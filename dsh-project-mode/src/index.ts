/**
 * dsh-project-mode plugin entry. Loads as a Cordis plugin (function form) with
 * `tools` and `systemPrompt` services. Wires one store shared by the tool, the
 * per-turn L1 section, and the session-timeline archiver; every registration
 * is a Cordis effect and disposes with the plugin fiber.
 *
 * Example (path form is the repo-dev shape; see cordis.example.yml):
 * ```yml
 * - id: project-mode
 *   name: '/abs/path/to/dsh-project-mode/src/index.ts'
 * ```
 * @module dsh-project-mode
 */

import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigShape } from './config.ts';
import { ProjectStore, defaultProjectRoot } from './store.ts';
import { projectTool } from './tool.ts';
import { registerProjectSection } from './inject.ts';
import { createTimelineArchiver } from './archive.ts';
import { startWebServer, type WebServer } from './web.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The plugin's single project store; other consumers read it here. */
        'project-mode.store': ProjectStore;
        /** The running web server, when started (on demand or auto-start). */
        'project-mode.web': WebServer | null;
    }
}
export { Config };
export { PROJECT_ACTIONS } from './tool.ts';
export const name = 'project-mode';
export const inject = ['tools', 'systemPrompt'] as const;
export function apply(ctx: Context, config: ConfigShape): void {
    const root = config.root.length > 0 ? config.root : defaultProjectRoot();
    const store = new ProjectStore(root);
    ctx.provide('project-mode.store', store);
    ctx.provide('project-mode.web', null);
    const startServer = () => {
        const existing = ctx.get('project-mode.web');
        if (existing !== null && existing !== undefined)
            return Promise.resolve(existing);
        return startWebServer(store, config.webHost, config.webPort).then(server => {
            ctx.set('project-mode.web', server);
            ctx.logger.info(`[project-mode] web panel at http://${server.host}:${server.port}/`);
            return server;
        });
    };
    // Close the panel when this plugin instance goes away (host teardown).
    ctx.effect(() => {
        let server: WebServer | null = null;
        const onStarted = (next: WebServer): void => {
            server = next;
        };
        // `onWebStart` is invoked whenever a server is (re)started, so the effect
        // closes whichever handle is live at disposal time.
        const disposeTool = ctx.tools.register(projectTool(store, {
            webHost: config.webHost,
            webPort: config.webPort,
            onWebStart: onStarted,
        }));
        registerProjectSection(ctx, store, { enabled: config.injectContext });
        const disposeArchive = ctx.on('session/event', createTimelineArchiver(store, {
            enabled: config.archiveTimeline,
            warn: message => ctx.logger.warn(`[project-mode] ${message}`),
        }));
        if (config.webAutoStart) {
            void startServer().catch(error => {
                ctx.logger.error(`[project-mode] web auto-start failed: ${String(error)}`);
            });
        }
        return () => {
            disposeTool();
            disposeArchive();
            if (server !== null) {
                void server.close().catch(error => {
                    ctx.logger.warn(`[project-mode] web server close failed: ${String(error)}`);
                });
            }
        };
    }, 'project-mode');
}
