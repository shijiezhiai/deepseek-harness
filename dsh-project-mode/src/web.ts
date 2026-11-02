/**
 * Local project-management web server. Serves the static frontend under
 * `web/static/` plus a small read/write JSON API over a {@link ProjectStore}.
 * Zero runtime dependencies: plain `node:http` + `node:fs`.
 *
 * The server binds loopback and is spawned on demand by the `project web`
 * tool action. One server per store; a second `web` call reuses the running
 * instance instead of forking another process.
 * @module dsh-project-mode/src/web
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectStore } from './store.ts';
/** Where the static frontend lives relative to this module. */
const STATIC_ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'web', 'static');
/** Fallback page for unknown non-API paths (SPA-style catch-all). */
const INDEX_NAME = 'index.html';
const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.md': 'text/markdown; charset=utf-8',
};
/** One running server instance, keyed to its store. */
export interface WebServer {
    /** The server's bound address, host and port. */
    host: string;
    port: number;
    /** Promise that resolves once the server is listening and ready. */
    ready: Promise<void>;
    /** Stop the server and release the port. */
    close(): Promise<void>;
}
const running = new WeakMap<ProjectStore, WebServer>();
/** The bound port of an already-running server for a store, or null. */
export function runningServer(store: ProjectStore): WebServer | null {
    return running.get(store) ?? null;
}
/**
 * Start (or reuse) the web server for a store. Non-fatal failures to bind
 * throw with the original error so the tool call surfaces them.
 * @param store - project store the API reads and writes.
 * @param host - bind address (loopback by default).
 * @param port - bind port; `0` allocates a free ephemeral port.
 * @param staticRoot - static frontend root; defaults to the bundled `web/static`.
 * @returns a handle with the actual host/port and shutdown.
 */
export async function startWebServer(store: ProjectStore, host: string, port: number, staticRoot: string = STATIC_ROOT): Promise<WebServer> {
    const existing = running.get(store);
    if (existing !== undefined) {
        await existing.ready;
        return existing;
    }
    const server = createServer((req, res) => {
        void handle(store, staticRoot, req, res);
    });
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolveCall, rejectCall) => {
        readyResolve = resolveCall;
        readyReject = rejectCall;
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
            server.removeListener('error', rejectListen);
            resolveListen();
        });
    }).catch((error: unknown) => {
        readyReject(error);
        throw error;
    });
    const address = server.address();
    const actualPort = address !== null && typeof address === 'object' ? address.port : port;
    const instance: WebServer = {
        host,
        port: actualPort,
        ready,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
            running.delete(store);
            server.close((error?: Error) => {
                if (error)
                    rejectClose(error);
                else
                    resolveClose();
            });
        }),
    };
    running.set(store, instance);
    readyResolve();
    return instance;
}
/** JSON body helpers. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(body);
}
function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolveBody, rejectBody) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            data += chunk;
        });
        req.on('end', () => {
            try {
                resolveBody(data === '' ? {} : JSON.parse(data));
            }
            catch (error) {
                rejectBody(error);
            }
        });
        req.on('error', rejectBody);
    });
}
/** API route table; every guest-facing route lives under `/api/`. */
async function handleApi(store: ProjectStore, pathname: string, method: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    try {
        if (method === 'GET' && seg[0] === 'projects' && seg.length === 1) {
            sendJson(res, 200, { projects: await store.list() });
            return;
        }
        // Project route group: /api/projects/<name>[/<sub>]
        if (seg[0] === 'projects' && seg[1] !== undefined && seg[1] !== 'new' && seg[1] !== 'touch') {
            const name = seg[1];
            const sub = seg[2];
            if (method === 'GET' && sub === undefined) {
                const summary = await store.read(name);
                if (summary === null) {
                    sendJson(res, 404, { error: `项目「${name}」不存在` });
                    return;
                }
                const [sessions, memory, instructions, assets] = await Promise.all([
                    store.timelineTail(name, 200),
                    store.readText(name, 'memory'),
                    store.readText(name, 'instructions'),
                    store.readAssets(name),
                ]);
                sendJson(res, 200, { project: summary, sessions, memory, instructions, assets });
                return;
            }
            if (method === 'PATCH' && sub === undefined) {
                const body = (await readBody(req)) as Record<string, unknown>;
                const goal = typeof body.goal === 'string' ? body.goal : '';
                try {
                    await store.updateGoal(name, goal);
                    const summary = await store.read(name);
                    sendJson(res, 200, { project: summary });
                }
                catch (error) {
                    sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (method === 'DELETE' && sub === undefined) {
                try {
                    await store.remove(name);
                    sendJson(res, 200, { ok: true });
                }
                catch (error) {
                    sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (method === 'POST' && sub === 'archive') {
                try {
                    await store.setStatus(name, 'archived');
                    sendJson(res, 200, { ok: true });
                }
                catch (error) {
                    sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (method === 'POST' && sub === 'restore') {
                try {
                    await store.setStatus(name, 'active');
                    sendJson(res, 200, { ok: true });
                }
                catch (error) {
                    sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            // Rename: PUT /api/projects/<name>/rename with {name}.
            if (method === 'PUT' && sub === 'rename' && seg.length === 3) {
                const body = (await readBody(req)) as Record<string, unknown>;
                const newName = String(body.name ?? '').trim();
                try {
                    await store.rename(name, newName);
                    sendJson(res, 200, { project: await store.read(newName) });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (message.startsWith('invalid project name')) {
                        sendJson(res, 400, { error: message });
                    }
                    else if (message.includes('already exists')) {
                        sendJson(res, 409, { error: message });
                    }
                    else {
                        sendJson(res, 404, { error: message });
                    }
                }
                return;
            }
            // Todos: GET/POST /todos, PATCH/DELETE /todos/:tid.
            if (sub === 'todos') {
                if (method === 'GET' && seg.length === 3) {
                    sendJson(res, 200, { todos: await store.readTodos(name) });
                    return;
                }
                if (method === 'POST' && seg.length === 3) {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const title = typeof body.title === 'string' ? body.title.trim() : '';
                    if (title === '') {
                        sendJson(res, 400, { error: '缺少 title' });
                        return;
                    }
                    try {
                        const input: { title: string; desc?: string; status?: string; assignee?: string; due?: string } = {
                            title,
                        };
                        if (typeof body.desc === 'string')
                            input.desc = body.desc;
                        if (typeof body.status === 'string')
                            input.status = body.status;
                        if (typeof body.assignee === 'string')
                            input.assignee = body.assignee;
                        if (typeof body.due === 'string')
                            input.due = body.due;
                        const todo = await store.createTodo(name, input);
                        sendJson(res, 201, { todo });
                    }
                    catch (error) {
                        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
                const tid = seg[3];
                if (tid !== undefined && seg.length === 4) {
                    if (method === 'PATCH') {
                        const body = (await readBody(req)) as Record<string, unknown>;
                        const patch: { title?: string; desc?: string; status?: string; assignee?: string; due?: string } = {};
                        if (typeof body.title === 'string' && body.title.trim() !== '')
                            patch.title = body.title.trim();
                        if (typeof body.desc === 'string')
                            patch.desc = body.desc;
                        if (typeof body.status === 'string')
                            patch.status = body.status;
                        if (typeof body.assignee === 'string')
                            patch.assignee = body.assignee;
                        if (typeof body.due === 'string')
                            patch.due = body.due;
                        try {
                            sendJson(res, 200, { todo: await store.updateTodo(name, tid, patch) });
                        }
                        catch (error) {
                            sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                        }
                        return;
                    }
                    if (method === 'DELETE') {
                        try {
                            await store.removeTodo(name, tid);
                            sendJson(res, 200, { ok: true });
                        }
                        catch (error) {
                            sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                        }
                        return;
                    }
                }
            }
            // Members: GET/POST /members, PATCH/DELETE /members/:mid.
            if (sub === 'members') {
                if (method === 'GET' && seg.length === 3) {
                    sendJson(res, 200, { members: await store.readMembers(name) });
                    return;
                }
                if (method === 'POST' && seg.length === 3) {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const nick = typeof body.nick === 'string' ? body.nick.trim() : '';
                    if (nick === '') {
                        sendJson(res, 400, { error: '缺少 nick' });
                        return;
                    }
                    try {
                        const input: { nick: string; name?: string; phone?: string; email?: string; role?: string } = {
                            nick,
                        };
                        if (typeof body.name === 'string')
                            input.name = body.name;
                        if (typeof body.phone === 'string')
                            input.phone = body.phone;
                        if (typeof body.email === 'string')
                            input.email = body.email;
                        if (typeof body.role === 'string')
                            input.role = body.role;
                        const member = await store.createMember(name, input);
                        sendJson(res, 201, { member });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, message.includes('already exists') ? 409 : 404, { error: message });
                    }
                    return;
                }
                const mid = seg[3];
                if (mid !== undefined && seg.length === 4 && method === 'PATCH') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const patch: { nick?: string; name?: string; phone?: string; email?: string; role?: string } = {};
                    if (typeof body.nick === 'string')
                        patch.nick = body.nick;
                    if (typeof body.name === 'string')
                        patch.name = body.name;
                    if (typeof body.phone === 'string')
                        patch.phone = body.phone;
                    if (typeof body.email === 'string')
                        patch.email = body.email;
                    if (typeof body.role === 'string')
                        patch.role = body.role;
                    try {
                        sendJson(res, 200, { member: await store.updateMember(name, mid, patch) });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, message.includes('already exists') ? 409 : message.includes('not found') ? 404 : 400, { error: message });
                    }
                    return;
                }
                if (mid !== undefined && seg.length === 4 && method === 'DELETE') {
                    try {
                        await store.removeMember(name, mid);
                        sendJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
            }
            // GA-derived metadata: GET /skills, /datasources, /experts (read-only string lists).
            const listKey = sub === 'skills' ? 'skills' : sub === 'datasources' ? 'datasources' : sub === 'experts' ? 'experts' : null;
            if (listKey !== null && method === 'GET' && seg.length === 3) {
                sendJson(res, 200, { [listKey]: await store.readStringList(name, listKey) });
                return;
            }
            // Library: GET/POST /library, PATCH/DELETE /library/:id, GET /library/:id/children.
            if (sub === 'library') {
                if (method === 'GET' && seg.length === 3) {
                    sendJson(res, 200, { items: await store.readLibrary(name) });
                    return;
                }
                if (method === 'POST' && seg.length === 3) {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const type = body.type;
                    if (type !== 'file' && type !== 'web' && type !== 'libfolder') {
                        sendJson(res, 400, { error: 'type 必须是 file|web|libfolder' });
                        return;
                    }
                    const itemName = typeof body.name === 'string' ? body.name.trim() : '';
                    if (itemName === '') {
                        sendJson(res, 400, { error: '缺少 name' });
                        return;
                    }
                    try {
                        const input: { type: 'file' | 'web' | 'libfolder'; name: string; path?: string; url?: string; desc?: string; parent_id?: string | null } = {
                            type,
                            name: itemName,
                        };
                        if (typeof body.desc === 'string')
                            input.desc = body.desc;
                        if (typeof body.parent_id === 'string')
                            input.parent_id = body.parent_id;
                        else if (body.parent_id === null)
                            input.parent_id = null;
                        if (typeof body.path === 'string')
                            input.path = body.path;
                        if (typeof body.url === 'string')
                            input.url = body.url;
                        const item = await store.addLibraryItem(name, input);
                        sendJson(res, 201, { item });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, message.includes('already exists') ? 409 : 400, { error: message });
                    }
                    return;
                }
                const lid = seg[3];
                if (lid !== undefined && seg.length === 4 && method === 'PATCH') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const patch: { name?: string; desc?: string; pinned?: boolean; parent_id?: string | null } = {};
                    if (typeof body.name === 'string')
                        patch.name = body.name.trim();
                    if (typeof body.desc === 'string')
                        patch.desc = body.desc;
                    if (typeof body.pinned === 'boolean')
                        patch.pinned = body.pinned;
                    if (body.parent_id === null)
                        patch.parent_id = null;
                    else if (typeof body.parent_id === 'string')
                        patch.parent_id = body.parent_id;
                    try {
                        sendJson(res, 200, { item: await store.patchLibraryItem(name, lid, patch) });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, 400, { error: message });
                    }
                    return;
                }
                if (lid !== undefined && seg.length === 4 && method === 'DELETE') {
                    try {
                        await store.removeLibraryItem(name, lid);
                        sendJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
                if (lid !== undefined && method === 'GET' && seg.length === 5 && seg[4] === 'children') {
                    sendJson(res, 200, { items: await store.libraryChildren(name, lid) });
                    return;
                }
            }
            // Project files: memory / instructions.
            if (sub === 'memory' || sub === 'instructions') {
                const kind = sub;
                if (method === 'GET') {
                    sendJson(res, 200, { content: await store.readText(name, kind) });
                    return;
                }
                if (method === 'PUT') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    try {
                        await store.writeText(name, kind, typeof body.content === 'string' ? body.content : '');
                        sendJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
            }
            // Project assets. `assets` is both the aggregate subtree root and the
            // legacy list endpoint: PUT /assets keeps its whole-list replace meaning,
            // while GET /assets returns the aggregate view (contract §4; the legacy
            // refs list stays reachable via the detail GET's `assets` field).
            if (sub === 'assets') {
                if (method === 'GET' && seg.length === 3) {
                    sendJson(res, 200, await store.assetAggregate(name));
                    return;
                }
                if (method === 'PUT' && seg.length === 3) {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const refs = Array.isArray(body.refs) ? body.refs.filter((item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)['path'] === 'string') : [];
                    const mapped = refs.map(item => ({
                        name: typeof item['name'] === 'string' ? item['name'] : '',
                        path: item['path'] as string,
                        readonly: item['readonly'] === true,
                    }));
                    await store.writeAssets(name, mapped);
                    sendJson(res, 200, { ok: true, assets: await store.readAssets(name) });
                    return;
                }
                // POST /assets/mkdir {relative}.
                if (seg[3] === 'mkdir' && seg.length === 4 && method === 'POST') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const relative = typeof body.relative === 'string' ? body.relative.replace(/\\/g, '/').replace(/^\/+/, '') : '';
                    try {
                        await store.assetMkdir(name, relative);
                        sendJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
                // POST /assets/ref {path}.
                if (seg[3] === 'ref' && seg.length === 4 && method === 'POST') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const refPath = typeof body.path === 'string' ? body.path.trim() : '';
                    if (refPath === '') {
                        sendJson(res, 400, { error: '缺少 path' });
                        return;
                    }
                    try {
                        sendJson(res, 201, { ref: await store.addAssetRef(name, refPath) });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, message.includes('already bound') ? 409 : 400, { error: message });
                    }
                    return;
                }
                // PATCH /assets/ref/:id, DELETE /assets/ref/:id.
                const refId = seg[4];
                if (seg[3] === 'ref' && refId !== undefined && seg.length === 5 && method === 'PATCH') {
                    const body = (await readBody(req)) as Record<string, unknown>;
                    const patch: { name?: string; readonly?: boolean } = {};
                    if (typeof body.name === 'string' && body.name.trim() !== '')
                        patch.name = body.name.trim();
                    if (typeof body.readonly === 'boolean')
                        patch.readonly = body.readonly;
                    try {
                        sendJson(res, 200, { ref: await store.updateAssetRef(name, refId, patch) });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        sendJson(res, message.includes('not found') ? 404 : 400, { error: message });
                    }
                    return;
                }
                if (seg[3] === 'ref' && refId !== undefined && seg.length === 5 && method === 'DELETE') {
                    try {
                        await store.removeAssetRef(name, refId);
                        sendJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
                    }
                    return;
                }
            }
        }
        if (method === 'POST' && seg[0] === 'projects' && seg[1] === 'new') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const newName = String(body.name ?? '').trim();
            const goal = String(body.goal ?? '').trim();
            if (newName === '') {
                sendJson(res, 400, { error: '缺少项目名 name' });
                return;
            }
            try {
                const created = await store.create(newName, goal);
                sendJson(res, 200, { project: created });
            }
            catch (error) {
                sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (method === 'POST' && seg[0] === 'projects' && seg[1] === 'touch') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const touchName = String(body.name ?? '').trim();
            if (touchName === '') {
                sendJson(res, 400, { error: '缺少项目名 name' });
                return;
            }
            await store.touch(touchName);
            sendJson(res, 200, { ok: true });
            return;
        }
        sendJson(res, 404, { error: `未知 API 路径 ${pathname}` });
    }
    catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
}
/** Route one request: API first, then static files under the frontend root. */
async function handle(store: ProjectStore, staticRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
    }
    if (pathname.startsWith('/api/')) {
        await handleApi(store, pathname, req.method ?? 'GET', req, res);
        return;
    }
    // Static: serve the file; fall back to index.html (catch-all).
    let candidate = normalize(pathname).replace(/^([/\\])+/, '');
    if (candidate === '' || candidate === '.')
        candidate = INDEX_NAME;
    const filePath = resolve(staticRoot, candidate);
    if (!filePath.startsWith(resolve(staticRoot))) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    try {
        const info = await stat(filePath);
        if (info.isFile()) {
            const data = await readFile(filePath);
            const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
            res.end(data);
            return;
        }
        if (info.isDirectory()) {
            const index = join(filePath, INDEX_NAME);
            const data = await readFile(index);
            res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
            res.end(data);
            return;
        }
    }
    catch {
        // Fall through to the SPA index when the file is missing.
    }
    try {
        const index = join(staticRoot, INDEX_NAME);
        const data = await readFile(index);
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(data);
    }
    catch {
        sendJson(res, 404, { error: '前端资源缺失' });
    }
}
