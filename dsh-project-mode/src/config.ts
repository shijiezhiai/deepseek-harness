/**
 * Project-mode plugin configuration. All fields are deployment choices with
 * defaults, so a bare `dsh-project-mode` entry in cordis.yml works as-is.
 * @module dsh-project-mode/src/config
 */
import z from '@deepseek-ai/schemastery';
export interface Config {
    /**
     * Projects root directory. Empty resolves to `<home>/.dsh/projects`; every
     * project is one directory under this root. The path is used verbatim when
     * non-empty (relative paths resolve against the profile working directory).
     */
    readonly root: string;
    /**
     * Whether the active project's L1 block (rules, instruction, memory pointer,
     * asset refs, closing discipline) is injected into every system prompt. Turn
     * off to reduce prompt cost when only the `project` tool is wanted.
     */
    readonly injectContext: boolean;
    /**
     * Whether every user message appends a timeline row to the active project's
     * `sessions.md` and refreshes its `lastActiveAt`. Failure never blocks the
     * session (fail-open, diagnostic only).
     */
    readonly archiveTimeline: boolean;
    /**
     * Host address for the local project-management web server. Bound to
     * loopback by default; the `project web` tool action spawns it on demand.
     */
    readonly webHost: string;
    /**
     * Port for the local project-management web server. `0` picks a free
     * ephemeral port; the tool reply carries the actual URL.
     */
    readonly webPort: number;
    /**
     * Start the web server automatically when the plugin loads (default true),
     * so the panel is reachable at `http://<webHost>:<webPort>/` right after
     * the desktop app starts. The `project web` tool action then reuses it.
     */
    readonly webAutoStart: boolean;
}
/** Schemastery configuration for the project-mode consumer. */
export const Config = z.object({
    root: z.string().default(''),
    injectContext: z.boolean().default(true),
    archiveTimeline: z.boolean().default(true),
    webHost: z.string().default('127.0.0.1'),
    webPort: z.number().default(8437),
    webAutoStart: z.boolean().default(true),
});
