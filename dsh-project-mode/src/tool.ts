/**
 * The `project` tool: one dispatcher over the project lifecycle, mirroring GA's
 * single `/project` command. Actions keep GA semantics — `new` also enters,
 * `status` is the dashboard, `archive`/`restore` flip lifecycle state softly.
 * The canonical value is structured JSON; `render` turns it into the markdown
 * the model sees. The closing discipline is carried in the description and the
 * L1 block so the model applies it without extra tool calls.
 * @module dsh-project-mode/src/tool
 */
import { defineTool, type ObjectValueSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { buildL1Block } from './l1.ts';
import { formatLocalTimestamp } from './timeline.ts';
import { runningServer, startWebServer } from './web.ts';
import type { ProjectStatus, ProjectStore, ProjectSummary } from './store.ts';
export const PROJECT_ACTIONS = ['list', 'new', 'status', 'enter', 'close', 'archive', 'restore', 'web'] as const;
export type ProjectAction = typeof PROJECT_ACTIONS[number];
/** Canonical return value of the `project` tool. */
export type ProjectToolValue = {
    action: ProjectAction;
    /** One-line outcome summary the model can echo verbatim. */
    message: string;
    /** Active project after the action, or '' when none. */
    active: string;
    /** Subject project for single-project actions, else null. */
    project: ProjectSummary | null;
    /** `list` output, else null. */
    projects: ProjectSummary[] | null;
    /** `status` timeline tail (up to 5 raw rows), else null. */
    recent: string[] | null;
    /** URL of the local project-management web panel, for `web` only. */
    webUrl: string | null;
};
const DESCRIPTION = 'Manage project workspaces (project mode). Each project is a directory under the configured root '
    + 'holding project.json (goal/status/timestamps), memory.md (project memory), instructions.md (user '
    + 'instructions), sessions.md (auto timeline), and .assets.json (bound local directories).\n'
    + 'Actions: `new <project> [goal]` creates AND enters the project; `enter <project>` switches this '
    + 'session to it; `close` leaves (data is kept); `status` shows the dashboard of the active project '
    + '(meta, last 5 timeline rows, memory pointer); `list` shows every project with the active one '
    + 'marked; `archive <project>` / `restore <project>` flip lifecycle state; `web` opens the local project-management web panel (GenericAgent-style card list) and returns its URL.\n'
    + 'File discipline: read memory.md via file tools when a task touches project context (conventions, '
    + 'pitfalls, continuation); write project artifacts inside the returned project directory. Closing '
    + 'discipline: after finishing work, append to memory.md (one reusable line per fact) anything a '
    + 'future you would otherwise re-learn by paying a cognitive cost again (a pitfall, a discovered '
    + 'convention, a repeated answer); write nothing otherwise.';
const outputObject = { type: 'object', additionalProperties: true } as const satisfies ObjectValueSchemaSpec;
/**
 * Build the tool definition bound to one store.
 * @param store - store all actions operate on.
 * @param options - tool options.
 * @param options.webHost - bind address for the local web panel.
 * @param options.webPort - bind port for the local web panel (`0` = ephemeral).
 * @param options.onWebStart - invoked (once per newly started server) so the
 * caller can retain a handle for shutdown and tests.
 * @returns a `defineTool` definition ready for `ctx.tools.register`.
 */
export function projectTool(store: ProjectStore, options: {
    webHost: string;
    webPort: number;
    onWebStart?: (server: import('./web.ts').WebServer) => void;
} = { webHost: '127.0.0.1', webPort: 8437 }): ToolDefinition {
    return defineTool({
        name: 'project',
        description: DESCRIPTION,
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...PROJECT_ACTIONS],
                description: 'Which project operation to run.',
            },
            project: { type: 'string', description: 'Project name for new/enter/archive/restore.' },
            goal: { type: 'string', description: 'One-line goal, used by new only.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    action: { type: 'string', enum: [...PROJECT_ACTIONS] },
                    message: { type: 'string' },
                    active: { type: 'string' },
                    project: { oneOf: [outputObject, { type: 'null' }] },
                    projects: {
                        oneOf: [
                            { type: 'array', items: outputObject },
                            { type: 'null' },
                        ],
                    },
                    recent: {
                        oneOf: [
                            { type: 'array', items: { type: 'string' } },
                            { type: 'null' },
                        ],
                    },
                    webUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
            },
            render: (_args, value) => {
                const typed = value as ProjectToolValue;
                const body = typed.action === 'list' && typed.projects !== null
                    ? renderList(typed, typed.active)
                    : typed.action === 'web'
                        ? typed.message
                        : typed.project !== null
                            ? renderProject(typed)
                            : typed.message;
                return [{ type: 'text', text: body }];
            },
            presentationMeta: (_args, value) => {
                const typed = value as ProjectToolValue;
                return { action: typed.action, active: typed.active };
            },
        },
        async execute(args, exec) {
            const agent = exec.agent;
            if (agent === undefined) {
                throw new Error('project requires a session owner (agent); no agent on this execution');
            }
            const { action, project: projectArg, goal } = args;
            const sessionId = String(agent.id);
            const activeNow = () => store.getActiveSync(sessionId) ?? '';
            async function summaryFor(name: string, message: string): Promise<ProjectToolValue> {
                return {
                    action,
                    message,
                    active: activeNow(),
                    project: await store.read(name),
                    projects: null,
                    recent: null,
                    webUrl: null,
                };
            }
            switch (action) {
                case 'list': {
                    const projects = await store.list();
                    return {
                        action,
                        message: `共 ${projects.length} 个项目`,
                        active: activeNow(),
                        project: null,
                        projects,
                        recent: null,
                        webUrl: null,
                    };
                }
                case 'web': {
                    const existing = runningServer(store);
                    const server = existing ?? (await startWebServer(store, options.webHost, options.webPort));
                    options.onWebStart?.(server);
                    const url = `http://${server.host}:${server.port}/`;
                    return {
                        action,
                        message: `项目管理面板已就绪：${url}\n打开该地址即可看到项目卡片列表（名称/描述/时间线），点卡片进入对应项目工作区。`,
                        active: activeNow(),
                        project: null,
                        projects: null,
                        recent: null,
                        webUrl: url,
                    };
                }
                case 'new': {
                    const name = requireName(projectArg);
                    if (await store.exists(name)) {
                        throw new Error(`project ${JSON.stringify(name)} already exists; use enter to switch to it`);
                    }
                    await store.create(name, (goal ?? '').trim());
                    await store.setActive(sessionId, name);
                    return await summaryFor(name, `已创建并进入项目「${name}」`);
                }
                case 'enter': {
                    const name = requireName(projectArg);
                    const summary = await store.read(name);
                    if (summary === null) {
                        throw new Error(`project ${JSON.stringify(name)} does not exist; use new to create it`);
                    }
                    await store.setActive(sessionId, name);
                    await store.touch(name);
                    const l1 = buildL1Block(store.l1MaterialSync(name)).trim();
                    const value = await summaryFor(name, `已进入项目「${name}」，本会话的项目模式已激活`);
                    value.message = `${value.message}\n\n${l1}`;
                    return value;
                }
                case 'status': {
                    const name = activeNow();
                    if (name === '') {
                        return {
                            action,
                            message: '未激活任何项目。先 project list 查看，或 project new/enter 进入一个项目。',
                            active: '',
                            project: null,
                            projects: null,
                            recent: null,
                            webUrl: null,
                        };
                    }
                    const summary = await store.read(name);
                    if (summary === null) {
                        await store.setActive(sessionId, null);
                        return {
                            action,
                            message: `激活指向的项目「${name}」已不存在，已清除激活。先 project list 查看现有项目。`,
                            active: '',
                            project: null,
                            projects: null,
                            recent: null,
                            webUrl: null,
                        };
                    }
                    return {
                        action,
                        message: `项目「${name}」仪表盘`,
                        active: name,
                        project: summary,
                        projects: null,
                        recent: await store.timelineTail(name, 5),
                        webUrl: null,
                    };
                }
                case 'close': {
                    const name = activeNow();
                    if (name === '') {
                        return {
                            action,
                            message: '本会话未激活任何项目，无需离开。',
                            active: '',
                            project: null,
                            projects: null,
                            recent: null,
                            webUrl: null,
                        };
                    }
                    await store.setActive(sessionId, null);
                    return await summaryFor(name, `已离开项目「${name}」（数据保留，可随时 enter 回来）`);
                }
                case 'archive':
                case 'restore': {
                    const fallback = activeNow();
                    const name = (projectArg ?? '').trim() === '' ? fallback : (projectArg ?? '').trim();
                    if (name === '') {
                        throw new Error('archive/restore needs a project name (argument or the active project)');
                    }
                    if (!(await store.exists(name))) {
                        throw new Error(`project ${JSON.stringify(name)} does not exist`);
                    }
                    const status: ProjectStatus = action === 'archive' ? 'archived' : 'active';
                    await store.setStatus(name, status);
                    const verb = action === 'archive' ? '已归档' : '已恢复';
                    return await summaryFor(name, `项目「${name}」${verb}`);
                }
            }
        },
    });
}
function requireName(value: string | undefined): string {
    const name = (value ?? '').trim();
    if (name === '')
        throw new Error('project name is required for this action');
    return name;
}
function summaryLine(project: ProjectSummary, active: boolean): string {
    const { meta, memory, timelineCount } = project;
    const mark = active ? '*' : ' ';
    return (`| ${mark}${meta.name} | ${meta.status} | ${meta.goal || '—'} | ${formatLocalTimestamp(new Date(meta.lastActiveAt)).slice(0, 10)} `
        + `| ${memory.exists ? memory.lines : 0} 行 | ${timelineCount} 条 |`);
}
function renderList(value: ProjectToolValue, active: string): string {
    const lines = ['| 项目 | 状态 | 目标 | 最近活跃 | 记忆 | 时间线 |', '|---|---|---|---|---|---|'];
    for (const project of value.projects ?? []) {
        lines.push(summaryLine(project, project.meta.name === active));
    }
    const note = active !== '' ? `当前激活：${active}` : '未激活任何项目';
    return `${lines.join('\n')}\n\n${note}`;
}
function renderProject(value: ProjectToolValue): string {
    const project = value.project;
    if (project === null)
        return value.message;
    const { meta, memory, timelineCount } = project;
    const parts = [
        `# ${meta.name}（${meta.status}）`,
        `目标：${meta.goal || '—'}`,
        `最近活跃：${formatLocalTimestamp(new Date(meta.lastActiveAt))} ｜ 记忆：${memory.exists ? `${memory.lines} 行 / ${memory.bytes} 字节` : '空'} ｜ 时间线：${timelineCount} 条`,
        '',
        value.message,
    ];
    if (value.recent !== null && value.recent.length > 0) {
        parts.push('', '最近会话：');
        for (const row of value.recent)
            parts.push(`- ${row}`);
    }
    return parts.join('\n');
}
