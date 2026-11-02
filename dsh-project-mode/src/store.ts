/**
 * File-backed project store. One directory per project under a configurable
 * root, mirroring GenericAgent's `temp/projects/<name>/` layout:
 *
 * - `project.json`   machine-readable metadata (goal/status/timestamps)
 * - `memory.md`      project memory, appended line-by-line by the agent
 * - `instructions.md` persistent user instructions, injected verbatim in L1
 * - `sessions.md`    session timeline, appended automatically per user message
 * - `.assets.json`   local directory references bound to the project
 * - `.todos.json`    kanban items (4 states)
 * - `.library.json`  flat library tree (file / web / libfolder)
 * - `.members.json`  project members (nick + contact fields)
 * - `.skills.json`   project skill names imported from GA (name array)
 * - `.datasources.json` project data-source ids imported from GA
 * - `.experts.json`  project expert names imported from GA
 *
 * `state.json` at the root maps session id → active project name, the DSH
 * analogue of GA's per-process anchor file: activation is per session, so
 * concurrent sessions can each work inside a different project.
 *
 * All mutations that read-modify-write a JSON file (meta, assets, todos,
 * library) run inside {@link ProjectStore.enqueue} so they serialize on one
 * chain; pure reads and `read*Sync` helpers may run anywhere.
 *
 * All writes are atomic (tmp + rename). Reads used by the synchronous system
 * prompt provider live in `*Sync` methods; mutations are async.
 * @module dsh-project-mode/src/store
 */

import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
export type ProjectStatus = 'active' | 'archived';
export type ProjectMeta = {
    /** Project name; equals the directory name. */
    name: string;
    /** One-line goal, set at creation. Empty string when not provided. */
    goal: string;
    /** Lifecycle state; `archived` projects keep their files. */
    status: ProjectStatus;
    /** ISO-8601 creation instant. */
    createdAt: string;
    /** ISO-8601 last-activity instant (creation, enter, or timeline append). */
    lastActiveAt: string;
};
export type MemoryStat = {
    /** Whether `memory.md` exists. */
    exists: boolean;
    /** Line count of `memory.md`, for the L1 pointer. */
    lines: number;
    /** UTF-8 byte count of `memory.md`, for the L1 pointer. */
    bytes: number;
};
export interface ProjectFiles {
    dir: string;
    meta: string;
    memory: string;
    instructions: string;
    sessions: string;
    assets: string;
    todos: string;
    library: string;
    members: string;
    skills: string;
    datasources: string;
    experts: string;
}
/** One bound local directory reference. JSON-carried, hence a type alias. */
export type ProjectAssetRef = {
    /** Display name; defaults to the directory basename. */
    name: string;
    /** Absolute directory path. */
    path: string;
    /** True marks the directory read-only context (never edited). */
    readonly: boolean;
    /** Stable identifier, backfilled on read when the stored entry lacks one. */
    id?: string;
    /** Unix-seconds addition time, backfilled like `id`. */
    added_at?: number;
};
/** A kanban item (4 states). JSON-carried, hence a type alias. */
export type ProjectTodo = {
    id: string;
    title: string;
    desc: string;
    status: 'todo' | 'doing' | 'pause' | 'done';
    assignee: string;
    due: string;
    /** Unix-seconds (integer) creation instant. */
    createdAt: number;
    /** Unix-seconds (integer) last-update instant. */
    updatedAt: number;
    /** GA import provenance: originating data-source id, optional. */
    datasourceId?: string;
    /** GA import provenance: originating issue id, optional. */
    originId?: string;
    /** GA import provenance: original issue URL, optional. */
    originUrl?: string;
    /** GA import provenance: original issue status, optional. */
    originStatus?: string;
};
export type TodoStatus = ProjectTodo['status'];
/** A library tree node; `type: 'libfolder'` nodes can parent others. */
export type LibraryItem = {
    id: string;
    type: 'file' | 'web' | 'libfolder';
    name: string;
    /** Absolute path for `file`/`libfolder`, absent for `web`. */
    path?: string;
    /** URL for `web` entries, absent otherwise. */
    url?: string;
    desc: string;
    /** Unix-seconds (integer) addition instant. */
    added_at: number;
    parent_id: string | null;
    pinned: boolean;
    has_children: boolean;
};
/** One project member; `nick` is the unique handle assignee strings reference. */
export type ProjectMember = {
    id: string;
    /** Unique per project (≤ 64 chars), the todo `assignee` value. */
    nick: string;
    name: string;
    phone: string;
    email: string;
    role: string;
    /** Unix-seconds (integer) creation instant. */
    createdAt: number;
};
/** One top-level file entry of the aggregated asset view. */
export type AssetFile = {
    name: string;
    type: 'dir' | 'file';
    path: string;
    size: number;
    mtime: number;
    source: 'project';
};
/** Aggregated asset view returned by `GET assets`. */
export type AssetAggregate = {
    name: string;
    workspace: null;
    files: AssetFile[];
    uploads: unknown[];
    refs: ProjectAssetRef[];
};
/** Everything the synchronous L1 provider needs for one project. */
export interface L1Material {
    name: string;
    dir: string;
    memoryPath: string;
    memory: MemoryStat;
    /** Full `instructions.md` text when non-empty, otherwise ''. */
    instruction: string;
    assets: readonly ProjectAssetRef[];
    /** GA-imported skill names; empty when none. */
    skills: readonly string[];
    /** GA-imported data-source ids; empty when none. */
    datasources: readonly string[];
    /** GA-imported expert names; empty when none. */
    experts: readonly string[];
}
export type ProjectSummary = {
    meta: ProjectMeta;
    memory: MemoryStat;
    /** Number of rows in `sessions.md`. */
    timelineCount: number;
};
/** Initial session-timeline header written with a brand-new project. */
const SESSIONS_HEADER = (name: string): string => `# ${name} — 会话时间线\n（每条 user/message 自动追加；摘要用 project status 现读现摘）\n`;
/** Initial project-memory header written with a brand-new project. */
const MEMORY_HEADER = (name: string): string => `# ${name} — 项目记忆\n（一条一句，写成未来的自己能直接复用的形式；已有条目增量更新，不整篇重写）\n`;
/**
 * Whether `name` can address a project directory. Rejects path separators,
 * whitespace, control characters, a leading dot, and the implicit `.`/`..`
 * entries. CJK and most printable characters are allowed.
 * @param name - candidate project name.
 * @returns true when safe to use as a project directory name.
 */
export function isValidProjectName(name: string): boolean {
    if (name.length === 0 || name.length > 64)
        return false;
    if (name === '.' || name === '..' || name.startsWith('.'))
        return false;
    return !/[\s/\\\u0000-\u001f\u007f]/.test(name);
}
/** Input-blaming rejection of an unusable project name. */
export class InvalidProjectNameError extends Error {
    override readonly name = 'InvalidProjectNameError';
    /**
     * @param name - the rejected project name.
     */
    constructor(name: string) {
        super(`invalid project name ${JSON.stringify(name)}: non-empty, ≤ 64 chars, no separators/whitespace/leading dot`);
    }
}
/**
 * Assert `name` is a valid project name, throwing {@link InvalidProjectNameError}.
 * @param name - candidate project name.
 */
export function assertValidProjectName(name: string): void {
    if (!isValidProjectName(name))
        throw new InvalidProjectNameError(name);
}
/** Default projects root: `<home>/.dsh/projects`. */
export function defaultProjectRoot(): string {
    return join(homedir(), '.dsh', 'projects');
}
/** Directories never surfaced in the aggregate asset view. */
const _ASSET_IGNORED: ReadonlySet<string> = new Set(['.git', 'node_modules', 'venv', 'sessions']);
/** GA metadata files never surfaced in the aggregate asset view. */
const META_FILENAMES: ReadonlySet<string> = new Set(['project.json', 'memory.md', 'instructions.md', 'sessions.md', '.assets.json', '.todos.json', '.library.json', '.members.json', '.skills.json', '.datasources.json', '.experts.json', 'state.json']);
/** Allowed todo statuses; the on-disk default for invalid values. */
const TODO_STATUSES: ReadonlySet<string> = new Set<TodoStatus>(['todo', 'doing', 'pause', 'done']);
/** Per-field character limits for member creation/update. */
const MEMBER_LIMITS = {
    nick: 64,
    name: 64,
    phone: 32,
    email: 128,
    role: 64,
};
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
function asOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
function asUnixSeconds(value: unknown): number {
    return Math.floor(Number.isFinite(value) ? Number(value) : Date.now() / 1000);
}
/**
 * The duplicate key of `items` already matching a candidate, or null.
 * `web` items compare by lowercase URL, `file`/`libfolder` by absolute path.
 */
function duplicateLibraryKey(items: readonly LibraryItem[], type: LibraryItem['type'], key: string): string | null {
    for (const item of items) {
        if (item.type !== type)
            continue;
        if (type === 'web' && item.url !== undefined) {
            if (`web:${item.url.toLowerCase()}` === key)
                return key;
        }
        else if (item.path !== undefined) {
            if (`${type}:${resolve(item.path)}` === key)
                return key;
        }
    }
    return null;
}
/**
 * Rewrite the H1 title `# <old> —` on the first line of a header file to
 * `# <new> —` when that exact line exists; otherwise leave the file alone.
 */
async function rewriteH1(file: string, oldName: string, newName: string): Promise<void> {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null)
        return;
    const marker = `# ${oldName} —`;
    if (!text.startsWith(marker))
        return;
    const updated = `# ${newName} —` + text.slice(marker.length);
    await writeFileAtomic(file, updated);
}
/**
 * Normalize one asset ref for storage: coerce field types, backfill a stable
 * `id` and `added_at`, and resolve the path to its realpath form. Missing
 * input fields fall back to the path basename / absolute path.
 */
function normalizeRef(source: Record<string, unknown>): ProjectAssetRef {
    const id = asOptionalString(source['id']) ?? `ref_${randomBytes(6).toString('hex')}`;
    const added_at = asUnixSeconds(source['added_at']);
    const path = resolve(String(source['path'] ?? ''));
    return {
        name: asOptionalString(source['name']) ?? String(path.split('/').pop() ?? path),
        path,
        readonly: source['readonly'] === true,
        id,
        added_at,
    };
}
/** Read `<root>/state.json` without throwing; missing or corrupt means no activations. */
function readStateSync(root: string): Record<string, string> {
    try {
        const parsed: { sessions?: Record<string, string> } | null = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
            return parsed.sessions;
        }
    }
    catch {
        // Missing or corrupt state is an empty activation map; writes recreate it.
    }
    return {};
}
/** Read one project's meta without throwing; returns null when absent or corrupt. */
function readMetaSync(dir: string, name: string): ProjectMeta | null {
    try {
        const parsed: Partial<Record<keyof ProjectMeta, unknown>> | null = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string')
            return null;
        return {
            name,
            goal: typeof parsed.goal === 'string' ? parsed.goal : '',
            status: parsed.status === 'archived' ? 'archived' : 'active',
            createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
            lastActiveAt: typeof parsed.lastActiveAt === 'string' ? parsed.lastActiveAt : '',
        };
    }
    catch {
        return null;
    }
}
/**
 * Atomic text write: write to a unique sibling temp file, then rename over the
 * target. A failed write removes the temp file and rethrows.
 * @param path - target file path.
 * @param content - full file content.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, path);
    }
    catch (error) {
        await fs.unlink(tmp).catch(() => undefined);
        throw error;
    }
}
/**
 * One project store rooted at `root`. Instances are cheap; the plugin owns one
 * per activation and passes it to the tool, the L1 provider, and the archiver.
 */
export class ProjectStore {
    readonly root: string;
    /**
     * @param root - projects root; created lazily on first write.
     */
    constructor(root: string) {
        this.root = root;
    }
    /** Absolute paths of every file of one project. Pure, no I/O. */
    paths(name: string): ProjectFiles {
        const dir = join(this.root, name);
        return {
            dir,
            meta: join(dir, 'project.json'),
            memory: join(dir, 'memory.md'),
            instructions: join(dir, 'instructions.md'),
            sessions: join(dir, 'sessions.md'),
            assets: join(dir, '.assets.json'),
            todos: join(dir, '.todos.json'),
            library: join(dir, '.library.json'),
            members: join(dir, '.members.json'),
            skills: join(dir, '.skills.json'),
            datasources: join(dir, '.datasources.json'),
            experts: join(dir, '.experts.json'),
        };
    }
    /**
     * Whether a project with this name exists (its directory holds a readable
     * `project.json`).
     * @param name - project name.
     * @returns true when the project exists.
     */
    async exists(name: string): Promise<boolean> {
        return (await this.read(name)) !== null;
    }
    /**
     * Every project under the root, newest activity first, with memory stats and
     * timeline row counts. Unreadable directories without a valid `project.json`
     * are skipped.
     * @returns project summaries, sorted by `lastActiveAt` descending.
     */
    async list(): Promise<ProjectSummary[]> {
        let entries: string[];
        try {
            entries = await fs.readdir(this.root);
        }
        catch {
            return []; // Root not created yet — an empty project list.
        }
        const summaries: ProjectSummary[] = [];
        for (const entry of entries) {
            if (entry.startsWith('.'))
                continue;
            const summary = await this.read(entry);
            if (summary !== null)
                summaries.push(summary);
        }
        summaries.sort((a, b) => b.meta.lastActiveAt.localeCompare(a.meta.lastActiveAt));
        return summaries;
    }
    /**
     * Read one project's summary.
     * @param name - project name.
     * @returns the summary, or null when the project does not exist or its meta
     * is unreadable.
     */
    async read(name: string): Promise<ProjectSummary | null> {
        const meta = readMetaSync(this.paths(name).dir, name);
        if (meta === null)
            return null;
        return {
            meta,
            memory: this.memoryStatSync(name),
            timelineCount: await this.timelineCount(name),
        };
    }
    /**
     * Create a new project: directory, meta, empty memory/instructions,
     * timeline header, and empty asset refs. Errors when the project already
     * exists (input reserved to `project new`).
     * @param name - project name (validated).
     * @param goal - optional one-line goal stored in `project.json`.
     * @returns the created summary.
     */
    async create(name: string, goal: string): Promise<ProjectSummary> {
        assertValidProjectName(name);
        const files = this.paths(name);
        const now = new Date().toISOString();
        const meta: ProjectMeta = {
            name,
            goal,
            status: 'active',
            createdAt: now,
            lastActiveAt: now,
        };
        if (await this.exists(name)) {
            throw new Error(`project ${JSON.stringify(name)} already exists`);
        }
        await fs.mkdir(files.dir, { recursive: true });
        await Promise.all([
            writeFileAtomic(files.meta, `${JSON.stringify(meta, null, 2)}\n`),
            writeFileAtomic(files.memory, MEMORY_HEADER(name)),
            writeFileAtomic(files.instructions, ''),
            writeFileAtomic(files.sessions, SESSIONS_HEADER(name)),
            writeFileAtomic(files.assets, '[]\n'),
        ]);
        return { meta, memory: { exists: true, lines: 2, bytes: Buffer.byteLength(MEMORY_HEADER(name)) }, timelineCount: 0 };
    }
    /**
     * Flip a project's lifecycle status.
     * @param name - project name.
     * @param status - the new status.
     */
    async setStatus(name: string, status: ProjectStatus): Promise<void> {
        const meta = readMetaSync(this.paths(name).dir, name);
        if (meta === null)
            throw new Error(`project ${JSON.stringify(name)} does not exist`);
        await writeFileAtomic(this.paths(name).meta, `${JSON.stringify({ ...meta, status }, null, 2)}\n`);
    }
    /**
     * Stamp `lastActiveAt` to now. Idempotent on a missing project (activity is
     * a soft signal; the archiver uses it fail-open).
     * @param name - project name.
     */
    async touch(name: string): Promise<void> {
        return this.enqueue(async () => {
            const dir = this.paths(name).dir;
            const meta = readMetaSync(dir, name);
            if (meta === null)
                return;
            await writeFileAtomic(this.paths(name).meta, `${JSON.stringify({ ...meta, lastActiveAt: new Date().toISOString() }, null, 2)}\n`);
        });
    }
    /**
     * The active project name of one session, or null.
     * @param sessionId - session identity (the agent id).
     * @returns the active project name, or null when this session is not in a
     * project.
     */
    getActiveSync(sessionId: string): string | null {
        return readStateSync(this.root)[sessionId] ?? null;
    }
    /**
     * Set (or clear, with `null`) a session's active project.
     * @param sessionId - session identity.
     * @param name - project name to activate, or null to leave the project.
     */
    async setActive(sessionId: string, name: string | null): Promise<void> {
        const sessions = readStateSync(this.root);
        if (name === null) {
            delete sessions[sessionId];
        }
        else {
            sessions[sessionId] = name;
        }
        await fs.mkdir(this.root, { recursive: true });
        await writeFileAtomic(join(this.root, 'state.json'), `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
    }
    /**
     * Rename a project: move its directory, then rewrite the name inside every
     * meta file (`project.json`, memory/sessions H1 headers, timeline toggle
     * hint, and the root activation map). The whole operation runs inside one
     * enqueue block so no other store mutation observes the half-renamed state.
     * @param oldName - current project name.
     * @param newName - replacement project name (validated).
     */
    async rename(oldName: string, newName: string): Promise<void> {
        assertValidProjectName(newName);
        return this.enqueue(async () => {
            const oldDir = this.paths(oldName).dir;
            if (readMetaSync(oldDir, oldName) === null) {
                throw new Error(`project ${JSON.stringify(oldName)} does not exist`);
            }
            const newDir = this.paths(newName).dir;
            if (readMetaSync(newDir, newName) !== null) {
                throw new Error(`project ${JSON.stringify(newName)} already exists`);
            }
            await fs.rename(oldDir, newDir);
            const files = this.paths(newName);
            await Promise.all([
                writeFileAtomic(files.meta, `${JSON.stringify({ ...readMetaSync(newDir, newName), name: newName }, null, 2)}\n`),
                rewriteH1(files.memory, oldName, newName),
                rewriteH1(files.sessions, oldName, newName),
            ]);
            const sessions = readStateSync(this.root);
            for (const key of Object.keys(sessions)) {
                if (sessions[key] === oldName)
                    sessions[key] = newName;
            }
            await writeFileAtomic(join(this.root, 'state.json'), `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
        });
    }
    /**
     * Serialize one store mutation after every previously queued one. Timeline
     * and activity writes are submitted fire-and-forget by the archiver, so
     * ordering and quiescence must be observable: callers can await a later
     * queued mutation (e.g. `touch`) to wait for all earlier ones to settle.
     */
    private enqueue<T>(run: () => T | PromiseLike<T>): Promise<T> {
        const next = this.serial.then(run, run);
        this.serial = next.catch(() => undefined);
        return next;
    }
    private serial: Promise<unknown> = Promise.resolve();
    /**
     * Memory file statistics for the L1 pointer. Synchronous by contract: the
     * system prompt provider must not await.
     * @param name - project name.
     * @returns existence plus line/byte counts of `memory.md`.
     */
    memoryStatSync(name: string): MemoryStat {
        try {
            const path = this.paths(name).memory;
            const data = readFileSync(path, 'utf8');
            const lines = data.split('\n').length - (data.endsWith('\n') ? 1 : 0);
            return { exists: true, lines, bytes: Buffer.byteLength(data, 'utf8') };
        }
        catch {
            return { exists: false, lines: 0, bytes: 0 };
        }
    }
    /**
     * Assemble every synchronous input the L1 block needs. Instruction text is
     * returned in full but capped at 4000 chars to bound prompt cost; asset refs
     * list existing directories only.
     * @param name - project name.
     * @returns the material; a missing project yields a zero-material block.
     */
    l1MaterialSync(name: string): L1Material {
        const files = this.paths(name);
        const dir = files.dir;
        const memory = this.memoryStatSync(name);
        let instruction = '';
        try {
            instruction = readFileSync(files.instructions, 'utf8').slice(0, 4000).trim();
        }
        catch {
            // Missing instructions.md contributes nothing.
        }
        let assets: ProjectAssetRef[] = [];
        try {
            const parsed: unknown = JSON.parse(readFileSync(files.assets, 'utf8'));
            if (Array.isArray(parsed)) {
                assets = parsed
                    .filter((item): item is Record<string, unknown> & { path: string } => typeof item === 'object' && item !== null && typeof item.path === 'string')
                    .map(item => ({
                    name: typeof item['name'] === 'string' ? item['name'] : String(item['path'].split('/').pop() ?? item['path']),
                    path: item['path'],
                    readonly: item['readonly'] === true,
                }))
                    // Only refs that still address an existing directory are injected.
                    .filter(ref => {
                    try {
                        return statSync(ref.path).isDirectory();
                    }
                    catch {
                        return false;
                    }
                });
            }
        }
        catch {
            // Missing or corrupt asset refs contribute nothing.
        }
        return {
            name,
            dir,
            memoryPath: files.memory,
            memory,
            instruction,
            assets,
            skills: this.stringListSync(files.skills),
            datasources: this.stringListSync(files.datasources),
            experts: this.stringListSync(files.experts),
        };
    }
    /** Synchronous string-array sidecar read (skills/datasources/experts). */
    private stringListSync(file: string): string[] {
        try {
            const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            return parsed.map(item => String(item)).filter(s => s !== '');
        }
        catch {
            return [];
        }
    }
    async appendTimeline(name: string, entry: string): Promise<void> {
        return this.enqueue(async () => {
            const path = this.paths(name).sessions;
            const row = `${entry}\n`;
            try {
                await fs.appendFile(path, row, 'utf8');
            }
            catch {
                // First append: lay down the header, then the row.
                await fs.mkdir(this.paths(name).dir, { recursive: true });
                await writeFileAtomic(path, SESSIONS_HEADER(name));
                await fs.appendFile(path, row, 'utf8');
            }
        });
    }
    /** Number of `## ` timeline rows in `sessions.md`. */
    private async timelineCount(name: string): Promise<number> {
        try {
            const data = await fs.readFile(this.paths(name).sessions, 'utf8');
            return data.split('\n').filter(line => line.startsWith('## ')).length;
        }
        catch {
            return 0;
        }
    }
    /**
     * The last `n` timeline rows, oldest first.
     * @param name - project name.
     * @param n - maximum number of rows.
     * @returns raw `## ...` rows.
     */
    async timelineTail(name: string, n: number): Promise<string[]> {
        try {
            const data = await fs.readFile(this.paths(name).sessions, 'utf8');
            return data.split('\n').filter(line => line.startsWith('## ')).slice(-n);
        }
        catch {
            return [];
        }
    }
    /**
     * Update the stored goal of a project. No-op with an error on a missing
     * project (input reserved to the web API's PATCH handler).
     * @param name - project name.
     * @param goal - the new one-line goal.
     */
    async updateGoal(name: string, goal: string): Promise<void> {
        return this.enqueue(async () => {
            const paths = this.paths(name);
            const meta = readMetaSync(paths.dir, name);
            if (meta === null)
                throw new Error(`project ${JSON.stringify(name)} does not exist`);
            await writeFileAtomic(paths.meta, `${JSON.stringify({ ...meta, goal }, null, 2)}\n`);
        });
    }
    /**
     * Read the full text of a project file (memory or instructions). Missing
     * file reads as an empty string; this is intentional so the web panel can
     * render an editable buffer for a brand-new project.
     * @param name - project name.
     * @param kind - which file to read.
     * @returns the full file text, or '' when absent.
     */
    async readText(name: string, kind: 'memory' | 'instructions'): Promise<string> {
        try {
            return await fs.readFile(this.paths(name)[kind], 'utf8');
        }
        catch {
            return '';
        }
    }
    /**
     * Overwrite a project file (memory or instructions) atomically. Creates the
     * project directory when missing (first-ever write from the web panel).
     * @param name - project name.
     * @param kind - which file to write.
     * @param text - the full new file content.
     */
    async writeText(name: string, kind: 'memory' | 'instructions', text: string): Promise<void> {
        return this.enqueue(async () => {
            const file = this.paths(name)[kind];
            await fs.mkdir(this.paths(name).dir, { recursive: true });
            await writeFileAtomic(file, text);
        });
    }
    /**
     * The asset refs of a project: bound work directories shown in the web
     * panel and injected into L1 context. Stored entries missing `id`/`added_at`
     * (pre-renovation format) are backfilled and the file rewritten, so every
     * call returns fully migrated refs. Missing or corrupt file reads as [].
     * @param name - project name.
     * @returns migrated refs (not filtered by directory existence).
     */
    async readAssets(name: string): Promise<ProjectAssetRef[]> {
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.paths(name).assets, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            const migrated = parsed.map((raw: unknown) => normalizeRef(typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}));
            const file = this.paths(name).assets;
            const onDisk = await fs.readFile(file, 'utf8').catch(() => '');
            const migratedText = `${JSON.stringify(migrated, null, 2)}\n`;
            if (migratedText !== onDisk) {
                await writeFileAtomic(file, migratedText);
            }
            return migrated;
        }
        catch {
            // Missing or corrupt asset refs contribute nothing.
        }
        return [];
    }
    /**
     * The top-level file entries of a project directory, excluding harness
     * metadata. Hidden files are skipped except `.env`/`.env.local`/`.gitignore`;
     * the same exclusion set drives {@link ProjectStore.assetFiles} and the
     * aggregate view.
     */
    private async topLevelFiles(name: string): Promise<AssetFile[]> {
        const dir = this.paths(name).dir;
        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const files: AssetFile[] = [];
        for (const entry of entries) {
            if (_ASSET_IGNORED.has(entry.name))
                continue;
            // The GA metadata files are not assets; hide dot-files except the
            // `.env`/`.gitignore` exceptions.
            if (META_FILENAMES.has(entry.name))
                continue;
            if (entry.name.startsWith('.')) {
                if (entry.name !== '.env' && entry.name !== '.env.local' && entry.name !== '.gitignore')
                    continue;
            }
            if (entry.isDirectory()) {
                files.push({
                    name: entry.name,
                    type: 'dir',
                    path: join(dir, entry.name),
                    size: 0,
                    mtime: 0,
                    source: 'project',
                });
                continue;
            }
            if (!entry.isFile())
                continue;
            const stat = await fs.stat(join(dir, entry.name)).catch(() => null);
            if (stat === null)
                continue;
            files.push({
                name: entry.name,
                type: 'file',
                path: join(dir, entry.name),
                size: stat.size,
                mtime: Math.floor(stat.mtimeMs / 1000),
                source: 'project',
            });
        }
        return files.sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * The aggregated asset view of a project: its top-level files plus bound
     * directory refs. `workspace` and `uploads` are stubs of a future version.
     * @param name - project name.
     */
    async assetAggregate(name: string): Promise<AssetAggregate> {
        return {
            name,
            workspace: null,
            files: await this.topLevelFiles(name),
            uploads: [],
            refs: await this.readAssets(name),
        };
    }
    /**
     * Create a directory tree inside the project, validating each relative
     * segment. Rejected: empty, absolute, and parent-escaping (`..`) paths.
     * @param name - project name.
     * @param relative - project-relative directory path.
     */
    async assetMkdir(name: string, relative: string): Promise<void> {
        const rel = relative.replace(/\\/g, '/');
        if (rel === '')
            throw new Error('relative path is empty');
        if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel))
            throw new Error('relative path must not be absolute');
        if (rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
            throw new Error('relative path contains invalid segments');
        }
        return this.enqueue(async () => {
            const dir = this.paths(name).dir;
            if (readMetaSync(dir, name) === null)
                throw new Error(`project ${JSON.stringify(name)} does not exist`);
            await fs.mkdir(join(dir, ...rel.split('/')), { recursive: true });
        });
    }
    /**
     * Bind one existing directory (outside the project) as an asset ref.
     * Rejected: a file path, the project directory itself or anything inside
     * it (those already show up in the aggregate files), and a path that is
     * already bound (realpath equality).
     * @param name - project name.
     * @param path - absolute directory path to bind.
     * @returns the created ref.
     */
    async addAssetRef(name: string, path: string): Promise<ProjectAssetRef> {
        const resolved = resolve(path);
        return this.enqueue(async () => {
            const files = this.paths(name);
            const meta = readMetaSync(files.dir, name);
            if (meta === null)
                throw new Error(`project ${JSON.stringify(name)} does not exist`);
            let real: string;
            try {
                real = await fs.realpath(resolved);
            }
            catch {
                throw new Error(`asset path ${JSON.stringify(path)} does not exist`);
            }
            const projectReal = await fs.realpath(files.dir);
            const insideProject = real === projectReal || real.startsWith(projectReal + sep)
                || projectReal.startsWith(real + sep);
            const realRel = real.startsWith(projectReal + sep) ? real.slice(projectReal.length + 1) : real;
            const isFile = (await fs.stat(real).catch(() => null))?.isFile() ?? false;
            if (real === projectReal || insideProject) {
                throw new Error('asset path must be outside the project directory');
            }
            if (isFile) {
                throw new Error('asset path must be a directory, not a file');
            }
            const refs = await this.readAssets(name);
            const keys = refs
                .map(ref => fs.realpath(ref.path).catch(() => ''));
            const reals = await Promise.all(keys);
            if (reals.includes(real) || refs.some(ref => ref.path === real)) {
                throw new Error(`asset path ${JSON.stringify(path)} is already bound`);
            }
            if (refs.some(ref => resolve(ref.path) === resolved)) {
                throw new Error(`asset path ${JSON.stringify(path)} is already bound`);
            }
            const ref: ProjectAssetRef = {
                name: realRel,
                path: real,
                readonly: false,
                id: `ref_${randomBytes(6).toString('hex')}`,
                added_at: Math.floor(Date.now() / 1000),
            };
            await writeFileAtomic(files.assets, `${JSON.stringify([...refs, ref], null, 2)}\n`);
            return ref;
        });
    }
    /**
     * Partially update one asset ref (display name / read-only flag).
     * @param name - project name.
     * @param id - ref id.
     * @param patch - the fields to change.
     * @returns the updated ref.
     */
    async updateAssetRef(name: string, id: string, patch: {
        name?: string;
        readonly?: boolean;
    }): Promise<ProjectAssetRef> {
        return this.enqueue(async () => {
            const files = this.paths(name);
            const refs = await this.readAssets(name);
            const ref = refs.find(candidate => candidate.id === id);
            if (ref === undefined)
                throw new Error(`asset ref ${JSON.stringify(id)} not found`);
            const next: ProjectAssetRef = { ...ref };
            if (patch.name !== undefined) {
                const cleaned = patch.name.trim();
                if (cleaned === '')
                    throw new Error('asset ref name must not be empty');
                next.name = cleaned;
            }
            if (patch.readonly !== undefined) {
                next.readonly = patch.readonly;
            }
            await writeFileAtomic(files.assets, `${JSON.stringify(refs.map(item => item.id === id ? next : item), null, 2)}\n`);
            return next;
        });
    }
    /**
     * Unbind one asset ref.
     * @param name - project name.
     * @param id - ref id.
     */
    async removeAssetRef(name: string, id: string): Promise<void> {
        return this.enqueue(async () => {
            const files = this.paths(name);
            const refs = await this.readAssets(name);
            const next = refs.filter(ref => ref.id !== id);
            if (next.length === refs.length) {
                throw new Error(`asset ref ${JSON.stringify(id)} not found`);
            }
            await writeFileAtomic(files.assets, `${JSON.stringify(next, null, 2)}\n`);
        });
    }
    /**
     * Replace the whole asset-ref list (bind/unbind). Entries may arrive without
     * `id`/`added_at` (old format, or the compatibility surface the web API
     * keeps); those are backfilled before persisting.
     * @param name - project name.
     * @param refs - the new ref list.
     */
    async writeAssets(name: string, refs: ProjectAssetRef[]): Promise<void> {
        return this.enqueue(async () => {
            const file = this.paths(name).assets;
            await fs.mkdir(this.paths(name).dir, { recursive: true });
            const merged = refs.map((ref) => normalizeRef({ ...ref }));
            await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
        });
    }
    /**
     * Physical deletion of a project directory (no undo). The web panel asks
     * for confirmation before calling this.
     * @param name - project name.
     */
    async remove(name: string): Promise<void> {
        return this.enqueue(async () => {
            const dir = this.paths(name).dir;
            if ((await fs.stat(dir).catch(() => null)) === null)
                throw new Error(`project ${JSON.stringify(name)} does not exist`);
            await fs.rm(dir, { recursive: true, force: true });
        });
    }
    /**
     * The kanban items of a project. Missing or corrupt `.todos.json` reads as [].
     * @param name - project name.
     */
    async readTodos(name: string): Promise<ProjectTodo[]> {
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.paths(name).todos, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            return parsed
                .filter(isRecord)
                .map(item => ({
                id: String(item['id'] ?? ''),
                title: String(item['title'] ?? ''),
                desc: String(item['desc'] ?? ''),
                status: TODO_STATUSES.has(asString(item['status'])) ? item['status'] as TodoStatus : 'todo',
                assignee: String(item['assignee'] ?? ''),
                due: String(item['due'] ?? ''),
                createdAt: asUnixSeconds(item['createdAt']),
                updatedAt: asUnixSeconds(item['updatedAt']),
                ...(item['datasourceId'] !== undefined ? { datasourceId: String(item['datasourceId']) } : {}),
                ...(item['originId'] !== undefined ? { originId: String(item['originId']) } : {}),
                ...(item['originUrl'] !== undefined ? { originUrl: String(item['originUrl']) } : {}),
                ...(item['originStatus'] !== undefined ? { originStatus: String(item['originStatus']) } : {}),
            }))
                .filter(todo => todo.id !== '');
        }
        catch {
            return [];
        }
    }
    /**
     * Overwrite the whole kanban list atomically.
     * @param name - project name.
     * @param todos - the full new list.
     */
    async writeTodos(name: string, todos: ProjectTodo[]): Promise<void> {
        return this.enqueue(() => this.persistTodos(name, todos));
    }
    private async persistTodos(name: string, todos: ProjectTodo[]): Promise<void> {
        await fs.mkdir(this.paths(name).dir, { recursive: true });
        await writeFileAtomic(this.paths(name).todos, `${JSON.stringify(todos, null, 2)}\n`);
    }
    /**
     * Create one todo. The title is truncated to 500 chars, the description to
     * 8000; the status defaults to `'todo'` and is normalized when invalid.
     * @param name - project name.
     * @param input - the todo fields.
     * @returns the created todo.
     */
    async createTodo(name: string, input: {
        title: string;
        desc?: string;
        status?: string;
        assignee?: string;
        due?: string;
    }): Promise<ProjectTodo> {
        const now = Math.floor(Date.now() / 1000);
        const todo: ProjectTodo = {
            id: `td_${Date.now()}${randomBytes(3).toString('hex')}`,
            title: input.title.slice(0, 500),
            desc: (input.desc ?? '').slice(0, 8000),
            status: TODO_STATUSES.has(input.status ?? '') ? input.status as TodoStatus : 'todo',
            assignee: input.assignee ?? '',
            due: input.due ?? '',
            createdAt: now,
            updatedAt: now,
        };
        return this.enqueue(async () => {
            const todos = await this.readTodos(name);
            await this.persistTodos(name, [...todos, todo]);
            return todo;
        });
    }
    /**
     * Partially update one todo. `id`/`createdAt` are immutable; an invalid
     * status falls back to `'todo'`. The title/desc strings are truncated again.
     * @param name - project name.
     * @param id - todo id.
     * @param patch - the fields to change.
     * @returns the updated todo.
     */
    async updateTodo(name: string, id: string, patch: {
        title?: string;
        desc?: string;
        status?: string;
        assignee?: string;
        due?: string;
    }): Promise<ProjectTodo> {
        return this.enqueue(async () => {
            const todos = await this.readTodos(name);
            const index = todos.findIndex(todo => todo.id === id);
            if (index === -1)
                throw new Error(`todo ${JSON.stringify(id)} not found`);
            const current = todos[index];
            const next: ProjectTodo = { ...current };
            if (patch.title !== undefined)
                next.title = patch.title.slice(0, 500);
            if (patch.desc !== undefined)
                next.desc = patch.desc.slice(0, 8000);
            if (patch.status !== undefined)
                next.status = TODO_STATUSES.has(patch.status) ? patch.status as TodoStatus : 'todo';
            if (patch.assignee !== undefined)
                next.assignee = patch.assignee;
            if (patch.due !== undefined)
                next.due = patch.due;
            next.updatedAt = Math.floor(Date.now() / 1000);
            todos[index] = next;
            await this.persistTodos(name, todos);
            return next;
        });
    }
    /**
     * Remove one todo.
     * @param name - project name.
     * @param id - todo id.
     */
    async removeTodo(name: string, id: string): Promise<void> {
        return this.enqueue(async () => {
            const todos = await this.readTodos(name);
            const next = todos.filter(todo => todo.id !== id);
            if (next.length === todos.length)
                throw new Error(`todo ${JSON.stringify(id)} not found`);
            await this.persistTodos(name, next);
        });
    }
    /**
     * Move one todo to a new status (a specialization of {@link updateTodo}).
     * @param name - project name.
     * @param id - todo id.
     * @param status - the new status; invalid values fall back to `'todo'`.
     * @returns the updated todo.
     */
    async setTodoStatus(name: string, id: string, status: string): Promise<ProjectTodo> {
        return this.updateTodo(name, id, { status });
    }
    /**
     * The library items of a project. Missing or corrupt `.library.json` reads as [].
     * @param name - project name.
     */
    async readLibrary(name: string): Promise<LibraryItem[]> {
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.paths(name).library, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            const items: LibraryItem[] = [];
            for (const raw of parsed) {
                if (!isRecord(raw))
                    continue;
                const type = raw['type'];
                if (type !== 'file' && type !== 'web' && type !== 'libfolder')
                    continue;
                const id = asOptionalString(raw['id']);
                if (id === undefined || id === '')
                    continue;
                const parentId = typeof raw['parent_id'] === 'string' ? raw['parent_id'] : null;
                const item: LibraryItem = {
                    id,
                    type,
                    name: asString(raw['name']),
                    desc: asString(raw['desc']),
                    added_at: asUnixSeconds(raw['added_at']),
                    parent_id: parentId,
                    pinned: raw['pinned'] === true,
                    has_children: raw['has_children'] === true,
                };
                const path = asOptionalString(raw['path']);
                if (path !== undefined)
                    item['path'] = path;
                const url = asOptionalString(raw['url']);
                if (url !== undefined)
                    item['url'] = url;
                items.push(item);
            }
            return items;
        }
        catch {
            return [];
        }
    }
    /**
     * Overwrite the whole library list atomically.
     * @param name - project name.
     * @param items - the full new list.
     */
    async writeLibrary(name: string, items: LibraryItem[]): Promise<void> {
        return this.enqueue(() => this.persistLibrary(name, items));
    }
    private async persistLibrary(name: string, items: LibraryItem[]): Promise<void> {
        await fs.mkdir(this.paths(name).dir, { recursive: true });
        await writeFileAtomic(this.paths(name).library, `${JSON.stringify(items, null, 2)}\n`);
    }
    /**
     * Create one library item. Duplicate keys are rejected: `web` by lowercase
     * URL, `file`/`libfolder` by absolute path; entries without a key (e.g. a
     * web item without a url) are always accepted.
     * @param name - project name.
     * @param input - the item fields.
     * @returns the created item.
     */
    async addLibraryItem(name: string, input: {
        type: 'file' | 'web' | 'libfolder';
        name: string;
        path?: string;
        url?: string;
        desc?: string;
        parent_id?: string | null;
    }): Promise<LibraryItem> {
        const type = input.type;
        let key: string | null = null;
        if (type === 'web') {
            const url = (input.url ?? '').trim();
            if (url !== '')
                key = `web:${url.toLowerCase()}`;
        }
        else {
            const path = (input.path ?? '').trim();
            if (path !== '')
                key = `${type === 'libfolder' ? 'libfolder' : 'file'}:${resolve(path)}`;
        }
        const now = Math.floor(Date.now() / 1000);
        const item: LibraryItem = {
            id: `lib_${randomBytes(6).toString('hex')}`,
            type,
            name: input.name.slice(0, 200),
            desc: (input.desc ?? '').slice(0, 2000),
            added_at: now,
            parent_id: input.parent_id ?? null,
            pinned: false,
            has_children: false,
        };
        if (type !== 'web')
            item['path'] = resolve((input.path ?? '').trim());
        else if ((input.url ?? '').trim() !== '')
            item['url'] = input.url!.trim();
        if (key !== null) {
            return this.enqueue(async () => {
                const items = await this.readLibrary(name);
                const dupe = duplicateLibraryKey(items, type, key);
                if (dupe)
                    throw new Error(`library item already exists (${dupe})`);
                await this.persistLibrary(name, [...items, item]);
                return item;
            });
        }
        return this.enqueue(async () => {
            const items = await this.readLibrary(name);
            await this.persistLibrary(name, [...items, item]);
            return item;
        });
    }
    /**
     * Partially update one library item: display name, description, pin flag,
     * or parent. `parent_id: null` detaches the item to the root; a
     * self-reference or a cycle (becomes its own descendant) is rejected.
     * @param name - project name.
     * @param id - item id.
     * @param patch - the fields to change.
     * @returns the updated item.
     */
    async patchLibraryItem(name: string, id: string, patch: {
        name?: string;
        desc?: string;
        pinned?: boolean;
        parent_id?: string | null;
    }): Promise<LibraryItem> {
        return this.enqueue(async () => {
            const items = await this.readLibrary(name);
            const index = items.findIndex(item => item.id === id);
            if (index === -1)
                throw new Error(`library item ${JSON.stringify(id)} not found`);
            if (patch.parent_id !== undefined && patch.parent_id !== null) {
                if (patch.parent_id === id) {
                    throw new Error('library item cannot be its own descendant');
                }
                const ancestorsOf = (target: string): string[] => {
                    const result: string[] = [];
                    let cursor: string | null = target;
                    let guard = 0;
                    while (cursor !== null && guard < items.length + 2) {
                        result.push(cursor);
                        cursor = items.find(item => item.id === cursor)?.parent_id ?? null;
                        guard++;
                    }
                    return result;
                };
                if (ancestorsOf(patch.parent_id).includes(id)) {
                    throw new Error('library item cannot be its own descendant');
                }
            }
            const current = items[index];
            const next: LibraryItem = { ...current };
            if (patch.name !== undefined)
                next.name = patch.name.slice(0, 200);
            if (patch.desc !== undefined)
                next.desc = patch.desc.slice(0, 2000);
            if (patch.pinned !== undefined)
                next.pinned = patch.pinned;
            if (patch.parent_id !== undefined)
                next.parent_id = patch.parent_id;
            // Ensure consistency: `has_children` must reflect the actual parents.
            for (const parentItem of items) {
                const isParentOfAny = items.some(other => other.id !== id && other.parent_id === parentItem.id)
                    || next.parent_id === parentItem.id;
                parentItem['has_children'] = isParentOfAny;
            }
            items[index] = next;
            await this.persistLibrary(name, items);
            return next;
        });
    }
    /**
     * Remove one library item. When the item is a folder, its children are
     * detached to the root (`parent_id: null`) first; the folder itself is then
     * deleted.
     * @param name - project name.
     * @param id - item id.
     */
    async removeLibraryItem(name: string, id: string): Promise<void> {
        return this.enqueue(async () => {
            const items = await this.readLibrary(name);
            const target = items.find(item => item.id === id);
            if (target === undefined)
                throw new Error(`library item ${JSON.stringify(id)} not found`);
            const next = items
                .filter(item => item.id !== id)
                .map(item => item.parent_id === id ? { ...item, parent_id: null } : item);
            await this.persistLibrary(name, next);
        });
    }
    /**
     * The direct children of one library item (the lazy-load source for the
     * tree view).
     * @param name - project name.
     * @param id - parent item id.
     * @returns direct children, pinned first then by `added_at`.
     */
    async libraryChildren(name: string, id: string): Promise<LibraryItem[]> {
        const items = await this.readLibrary(name);
        return items
            .filter(item => item.parent_id === id)
            .sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)
            || a.added_at - b.added_at)
            .slice(0, 1000);
    }
    /**
     * The project members. Missing or corrupt `.members.json` reads as [].
     * @param name - project name.
     */
    async readMembers(name: string): Promise<ProjectMember[]> {
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.paths(name).members, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            return parsed
                .filter(isRecord)
                .map(item => ({
                id: String(item['id'] ?? ''),
                nick: String(item['nick'] ?? ''),
                name: String(item['name'] ?? ''),
                phone: String(item['phone'] ?? ''),
                email: String(item['email'] ?? ''),
                role: String(item['role'] ?? ''),
                createdAt: asUnixSeconds(item['createdAt']),
            }))
                .filter(member => member.id !== '' && member.nick !== '');
        }
        catch {
            return [];
        }
    }
    /**
     * Overwrite the whole member list atomically.
     * @param name - project name.
     * @param members - the full new list.
     */
    async writeMembers(name: string, members: ProjectMember[]): Promise<void> {
        return this.enqueue(() => this.persistMembers(name, members));
    }
    private async persistMembers(name: string, members: ProjectMember[]): Promise<void> {
        await fs.mkdir(this.paths(name).dir, { recursive: true });
        await writeFileAtomic(this.paths(name).members, `${JSON.stringify(members, null, 2)}\n`);
    }
    /**
     * Read a GA-derived string-array sidecar (skills, datasources, experts).
     * Missing or corrupt files read as [].
     * @param name - project name.
     * @param key - sidecar base name without the leading dot (e.g. 'skills').
     */
    async readStringList(name: string, key: 'skills' | 'datasources' | 'experts'): Promise<string[]> {
        const file = this.paths(name)[key];
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!Array.isArray(parsed))
                return [];
            return parsed.map(item => String(item)).filter(s => s !== '');
        }
        catch {
            return [];
        }
    }
    /**
     * Create one member. The nick must be non-empty and unique within the
     * project; every free-text field is truncated to its contract limit
     * (nick/name 64, phone 32, email 128, role 64).
     * @param name - project name.
     * @param input - the member fields.
     * @returns the created member.
     */
    async createMember(name: string, input: {
        nick: string;
        name?: string;
        phone?: string;
        email?: string;
        role?: string;
    }): Promise<ProjectMember> {
        const nick = input.nick.trim();
        if (nick === '')
            throw new Error('member nick must not be empty');
        const member: ProjectMember = {
            id: `mb_${Date.now()}${randomBytes(3).toString('hex')}`,
            nick: nick.slice(0, MEMBER_LIMITS.nick),
            name: (input.name ?? '').slice(0, MEMBER_LIMITS.name),
            phone: (input.phone ?? '').slice(0, MEMBER_LIMITS.phone),
            email: (input.email ?? '').slice(0, MEMBER_LIMITS.email),
            role: (input.role ?? '').slice(0, MEMBER_LIMITS.role),
            createdAt: Math.floor(Date.now() / 1000),
        };
        return this.enqueue(async () => {
            const members = await this.readMembers(name);
            if (members.some(existing => existing.nick.toLowerCase() === member.nick.toLowerCase())) {
                throw new Error(`member nick ${JSON.stringify(member.nick)} already exists`);
            }
            await this.persistMembers(name, [...members, member]);
            return member;
        });
    }
    /**
     * Partially update one member. `id`/`createdAt` are immutable; a changed
     * nick must stay non-empty and project-unique.
     * @param name - project name.
     * @param id - member id.
     * @param patch - the fields to change.
     * @returns the updated member.
     */
    async updateMember(name: string, id: string, patch: {
        nick?: string;
        name?: string;
        phone?: string;
        email?: string;
        role?: string;
    }): Promise<ProjectMember> {
        return this.enqueue(async () => {
            const members = await this.readMembers(name);
            const index = members.findIndex(member => member.id === id);
            if (index === -1)
                throw new Error(`member ${JSON.stringify(id)} not found`);
            const current = members[index];
            const next: ProjectMember = { ...current };
            if (patch.nick !== undefined) {
                const nick = patch.nick.trim();
                if (nick === '')
                    throw new Error('member nick must not be empty');
                if (nick.toLowerCase() !== current.nick.toLowerCase()
                    && members.some(existing => existing.id !== id && existing.nick.toLowerCase() === nick.toLowerCase())) {
                    throw new Error(`member nick ${JSON.stringify(nick)} already exists`);
                }
                next.nick = nick.slice(0, MEMBER_LIMITS.nick);
            }
            if (patch.name !== undefined)
                next.name = patch.name.slice(0, MEMBER_LIMITS.name);
            if (patch.phone !== undefined)
                next.phone = patch.phone.slice(0, MEMBER_LIMITS.phone);
            if (patch.email !== undefined)
                next.email = patch.email.slice(0, MEMBER_LIMITS.email);
            if (patch.role !== undefined)
                next.role = patch.role.slice(0, MEMBER_LIMITS.role);
            members[index] = next;
            await this.persistMembers(name, members);
            return next;
        });
    }
    /**
     * Remove one member.
     * @param name - project name.
     * @param id - member id.
     */
    async removeMember(name: string, id: string): Promise<void> {
        return this.enqueue(async () => {
            const members = await this.readMembers(name);
            const next = members.filter(member => member.id !== id);
            if (next.length === members.length)
                throw new Error(`member ${JSON.stringify(id)} not found`);
            await this.persistMembers(name, next);
        });
    }
}
