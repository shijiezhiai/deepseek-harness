/**
 * dsh-project-mode web panel client. Plain ES module, no build step: it talks to
 * the JSON API served by lib/web.js (see that module for the route table) and
 * renders every project surface — overview, kanban, members, library, assets,
 * memory, instructions, and the GenericAgent-imported capability lists.
 */

const TABS = [
  ['overview', '概览'],
  ['board', '看板'],
  ['members', '成员'],
  ['library', '资料库'],
  ['assets', '资产'],
  ['memory', '记忆'],
  ['instructions', '指令'],
  ['extras', '能力'],
];
const STATUS_LABEL = { todo: '待办', doing: '进行中', pause: '已暂停', done: '已完成' };
const STATUS_COLOR = { todo: 'var(--todo)', doing: 'var(--doing)', pause: 'var(--pause)', done: 'var(--done)' };
const COMPACT_KEY = 'project-mode:board-compact';

const state = { projects: [], name: null, detail: null, tab: 'overview', compact: localStorage.getItem(COMPACT_KEY) === '1' };
let renderToken = 0;

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

let toastTimer;
function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = isError ? 'toast err' : 'toast';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET' };
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch('/api' + path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.status + ' ' + res.statusText);
  return data;
}

const enc = encodeURIComponent;

async function loadProjects() {
  const data = await api('/projects');
  state.projects = data.projects ?? [];
  renderSidebar();
}

async function openProject(name) {
  state.name = name;
  state.detail = await api('/projects/' + enc(name));
  renderSidebar();
  renderProject();
}

function renderSidebar() {
  const host = $('#project-list');
  host.replaceChildren();
  if (state.projects.length === 0) {
    host.append(el('div', { class: 'empty', text: '还没有项目' }));
    return;
  }
  const sorted = [...state.projects].sort((a, b) => {
    const rank = (p) => (p.meta.status === 'archived' ? 1 : 0);
    return rank(a) - rank(b) || String(b.meta.lastActiveAt).localeCompare(String(a.meta.lastActiveAt));
  });
  for (const summary of sorted) {
    const { meta, memory } = summary;
    const classes = ['pcard'];
    if (meta.name === state.name) classes.push('active');
    if (meta.status === 'archived') classes.push('archived');
    host.append(el('div', {
      class: classes.join(' '),
      onclick: () => { void openProject(meta.name).catch((e) => toast(e.message, true)); },
    }, [
      el('div', { class: 'pn' }, [
        el('strong', { text: meta.name, title: meta.name }),
        el('span', { class: 'pm', text: memory.exists ? memory.lines + ' 行' : '' }),
      ]),
      meta.goal ? el('div', { class: 'pg', text: meta.goal, title: meta.goal }) : null,
      el('div', { class: 'pm', text: summary.timelineCount + ' 条时间线 · ' + fmtDate(meta.lastActiveAt) }),
    ]));
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtUnix(sec) {
  if (!sec) return '';
  return fmtDate(new Date(sec * 1000).toISOString());
}

async function refreshDetail() {
  if (state.name === null) return;
  state.detail = await api('/projects/' + enc(state.name));
  renderProject();
}

function renderProject() {
  const detail = state.detail;
  if (detail === null) {
    $('#project-view').hidden = true;
    $('#welcome').hidden = false;
    return;
  }
  $('#welcome').hidden = true;
  $('#project-view').hidden = false;
  const meta = detail.project.meta;
  $('#proj-name').textContent = meta.name;
  const badge = $('#proj-status');
  badge.textContent = meta.status === 'archived' ? '已归档' : '进行中';
  badge.className = 'badge ' + meta.status;
  $('#proj-goal').textContent = meta.goal || '';
  $('#btn-archive').textContent = meta.status === 'archived' ? '恢复' : '归档';

  const tabs = $('#tabs');
  tabs.replaceChildren();
  for (const [key, label] of TABS) {
    tabs.append(el('button', {
      class: state.tab === key ? 'on' : '',
      text: label,
      onclick: () => { state.tab = key; renderProject(); },
    }));
  }
  const panels = $('#panels');
  panels.replaceChildren();
  const render = PANELS[state.tab];
  if (render === undefined) return;
  const rendered = render(detail);
  if (rendered instanceof Promise) {
    // Async panels fetch their own data; drop the result once the user has moved on.
    const token = ++renderToken;
    void rendered.then((node) => {
      if (token !== renderToken || state.tab === null) return;
      panels.replaceChildren(node);
    }).catch((error) => toast(error.message, true));
    return;
  }
  panels.append(rendered);
}

/* ── overview ───────────────────────────────────────────────── */

function panelOverview(detail) {
  const meta = detail.project.meta;
  const wrap = el('div', { class: 'panel on' });
  const rows = [
    ['项目目录', detail.project.meta.name],
    ['目标', meta.goal || '（未设定）'],
    ['状态', meta.status === 'archived' ? '已归档' : '进行中'],
    ['创建', fmtDate(meta.createdAt)],
    ['最近活动', fmtDate(meta.lastActiveAt)],
    ['记忆', detail.project.memory.exists ? detail.project.memory.lines + ' 行 / ' + detail.project.memory.bytes + ' 字节' : '（空）'],
    ['时间线', (detail.project.timelineCount ?? 0) + ' 条'],
  ];
  const table = el('table', { class: 'grid' }, [
    el('tbody', {}, rows.map(([k, v]) => el('tr', {}, [
      el('th', { text: k, style: 'width:110px' }),
      el('td', { text: v }),
    ]))),
  ]);
  wrap.append(el('div', { class: 'section' }, [el('h3', { text: '概况' }), table]));

  const log = el('pre', { class: 'log' });
  const sessions = detail.sessions ?? [];
  if (sessions.length === 0) {
    log.append(el('span', { class: 'muted', text: '（暂无记录。进入项目后，每条用户消息会自动追加一行。）' }));
  } else {
    log.textContent = sessions.join('\n');
  }
  wrap.append(el('div', { class: 'section' }, [el('h3', { text: '会话时间线（最近 200 条）' }), log]));
  return wrap;
}

/* ── kanban ─────────────────────────────────────────────────── */

async function panelBoard(detail) {
  const wrap = el('div', { class: 'panel on' });
  const name = detail.project.meta.name;
  let todos = [];
  let members = [];
  try {
    [todos, members] = await Promise.all([
      api('/projects/' + enc(name) + '/todos').then((d) => d.todos ?? []),
      api('/projects/' + enc(name) + '/members').then((d) => d.members ?? []),
    ]);
  } catch (error) { toast(error.message, true); }
  if (state.tab !== 'board') return wrap;

  const nicks = members.map((m) => m.nick);
  const board = el('div', { class: 'kb-board' });
  for (const status of ['todo', 'doing', 'pause', 'done']) {
    const column = el('div', { class: 'kb-col' + (state.compact ? ' kb-compact' : ''), dataset: { status } });
    column.addEventListener('dragover', (event) => { event.preventDefault(); column.classList.add('kb-drop-target'); });
    column.addEventListener('dragleave', () => column.classList.remove('kb-drop-target'));
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('kb-drop-target');
      const id = event.dataTransfer.getData('text/plain');
      if (!id) return;
      void api('/projects/' + enc(name) + '/todos/' + enc(id), { method: 'PATCH', body: { status } })
        .then(() => panelBoardRefetch())
        .catch((e) => toast(e.message, true));
    });

    const items = todos.filter((t) => t.status === status);
    const head = el('div', { class: 'kb-col-head' }, [
      el('span', { class: 'kb-status-dot', style: 'background:' + STATUS_COLOR[status] }),
      el('span', { text: STATUS_LABEL[status] }),
      el('span', { class: 'kb-col-count', text: String(items.length) }),
      el('button', {
        class: 'kb-density ghost', style: 'padding:0 6px;border:0;background:transparent;color:var(--fg-faint)',
        title: '切换密度', text: state.compact ? '▦' : '▤',
        onclick: () => {
          state.compact = !state.compact;
          localStorage.setItem(COMPACT_KEY, state.compact ? '1' : '0');
          renderProject();
        },
      }),
    ]);
    column.append(head);

    for (const todo of items) column.append(kbCard(name, todo, nicks, () => panelBoardRefetch()));
    if (items.length === 0) column.append(el('div', { class: 'kb-col-empty', text: '拖放卡片到此列' }));

    column.append(el('button', {
      class: 'kb-add',
      text: '+ 新建',
      onclick: () => {
        const input = el('input', { placeholder: '任务标题，回车创建' });
        const editor = el('div', { class: 'kb-card-edit' }, input);
        column.insertBefore(editor, column.querySelector('.kb-add'));
        input.focus();
        input.addEventListener('keydown', async (event) => {
          if (event.key === 'Escape') { editor.remove(); return; }
          if (event.key !== 'Enter' || input.value.trim() === '') return;
          try {
            await api('/projects/' + enc(name) + '/todos', { method: 'POST', body: { title: input.value.trim(), status } });
            panelBoardRefetch();
          } catch (error) { toast(error.message, true); }
        });
      },
    }));
    board.append(column);
  }
  wrap.append(board);
  return wrap;
}

function panelBoardRefetch() {
  renderProject();
}

function kbCard(name, todo, nicks, done) {
  const card = el('div', { class: 'kb-card', draggable: 'true', dataset: { status: todo.status, todoId: todo.id } });
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', todo.id);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  let dragged = false;
  card.addEventListener('dragstart', () => { dragged = true; });
  card.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    if (card.querySelector('.kb-card-edit')) { card.querySelector('.kb-card-edit').remove(); return; }
    openEditor();
  });

  const path = '/projects/' + enc(name) + '/todos/' + enc(todo.id);
  function openEditor() {
    const title = el('input', { value: todo.title });
    const desc = el('textarea', { rows: '3', value: todo.desc });
    desc.value = todo.desc ?? '';
    const assignee = el('input', { value: todo.assignee ?? '', list: 'member-nicks-' + name, placeholder: '负责人 nick' });
    const due = el('input', { value: todo.due ?? '', placeholder: '截止日期' });
    const datalist = el('datalist', { id: 'member-nicks-' + name }, nicks.map((nick) => el('option', { value: nick })));
    const editor = el('div', { class: 'kb-card-edit' }, [
      title, desc, assignee, due, datalist,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'ghost', text: '保存',
          onclick: async () => {
            try {
              await api(path, { method: 'PATCH', body: { title: title.value, desc: desc.value, assignee: assignee.value, due: due.value } });
              done();
            } catch (error) { toast(error.message, true); }
          },
        }),
        el('button', {
          class: 'danger', text: '删除',
          onclick: async () => {
            if (!confirm('删除任务「' + todo.title + '」？')) return;
            try { await api(path, { method: 'DELETE' }); done(); } catch (error) { toast(error.message, true); }
          },
        }),
      ]),
    ]);
    card.append(editor);
    title.focus();
  }

  const meta = [];
  if (todo.assignee) meta.push(el('span', { class: 'kb-tag', text: '@' + todo.assignee }));
  if (todo.due) meta.push(el('span', { class: 'kb-tag', text: '⏱ ' + todo.due }));
  if (todo.desc) meta.push(el('span', { text: todo.desc.length > 40 ? todo.desc.slice(0, 40) + '…' : todo.desc }));
  card.append(el('div', { class: 'kb-card-title', text: todo.title }));
  if (meta.length > 0) card.append(el('div', { class: 'kb-card-meta' }, meta));
  return card;
}

/* ── members ────────────────────────────────────────────────── */

async function panelMembers(detail) {
  const name = detail.project.meta.name;
  const wrap = el('div', { class: 'panel on' });
  let members = [];
  try { members = (await api('/projects/' + enc(name) + '/members')).members ?? []; }
  catch (error) { toast(error.message, true); }
  if (state.tab !== 'members') return wrap;

  const host = el('div');
  if (members.length === 0) host.append(el('div', { class: 'empty', text: '还没有成员。' }));
  else {
    host.append(el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, ['昵称', '姓名', '角色', '手机', '邮箱', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, members.map((m) => el('tr', {}, [
        el('td', { text: m.nick }),
        el('td', { text: m.name || '—' }),
        el('td', { text: m.role || '—' }),
        el('td', { text: m.phone || '—' }),
        el('td', { text: m.email || '—' }),
        el('td', { class: 'ops' }, [
          el('button', {
            class: 'ghost', text: '编辑',
            onclick: () => editMember(m),
          }),
          el('button', {
            class: 'ghost', text: '删除',
            onclick: async () => {
              if (!confirm('删除成员 ' + m.nick + '？')) return;
              try {
                await api('/projects/' + enc(name) + '/members/' + enc(m.id), { method: 'DELETE' });
                renderProject();
              } catch (error) { toast(error.message, true); }
            },
          }),
        ]),
      ]))),
    ]));
  }

  const form = el('div', { class: 'section' }, [
    el('h3', { text: '新增成员' }),
    el('div', { class: 'row' }, [
      field('昵称', el('input', { id: 'm-nick', placeholder: '唯一 handle，任务负责人引用它' })),
      field('姓名', el('input', { id: 'm-name' })),
      field('角色', el('input', { id: 'm-role' })),
      field('手机', el('input', { id: 'm-phone' })),
      field('邮箱', el('input', { id: 'm-email' })),
    ]),
    el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', {
        text: '添加',
        onclick: async () => {
          const nick = $('#m-nick').value.trim();
          if (nick === '') { toast('昵称必填', true); return; }
          const body = { nick };
          for (const key of ['name', 'role', 'phone', 'email']) {
            const value = $('#m-' + key).value.trim();
            if (value !== '') body[key] = value;
          }
          try { await api('/projects/' + enc(name) + '/members', { method: 'POST', body }); renderProject(); }
          catch (error) { toast(error.message, true); }
        },
      }),
    ]),
  ]);

  function editMember(member) {
    const nick = el('input', { value: member.nick });
    const nameInput = el('input', { value: member.name ?? '' });
    const role = el('input', { value: member.role ?? '' });
    const phone = el('input', { value: member.phone ?? '' });
    const email = el('input', { value: member.email ?? '' });
    const box = el('div', { class: 'section' }, [
      el('h3', { text: '编辑成员 ' + member.nick }),
      el('div', { class: 'row' }, [field('昵称', nick), field('姓名', nameInput), field('角色', role), field('手机', phone), field('邮箱', email)]),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', {
          text: '保存',
          onclick: async () => {
            try {
              await api('/projects/' + enc(name) + '/members/' + enc(member.id), {
                method: 'PATCH',
                body: { nick: nick.value.trim(), name: nameInput.value, role: role.value, phone: phone.value, email: email.value },
              });
              renderProject();
            } catch (error) { toast(error.message, true); }
          },
        }),
        el('button', { class: 'ghost', text: '取消', onclick: () => box.remove() }),
      ]),
    ]);
    wrap.append(box);
    nick.focus();
  }

  wrap.append(host, form);
  return wrap;
}

function field(label, input) {
  return el('label', { class: 'grow', style: 'display:grid;gap:4px;font-size:12px;color:var(--fg-faint)' }, [
    el('span', { text: label }), input,
  ]);
}

/* ── library ────────────────────────────────────────────────── */

async function panelLibrary(detail) {
  const name = detail.project.meta.name;
  const wrap = el('div', { class: 'panel on' });
  let items = [];
  try { items = (await api('/projects/' + enc(name) + '/library')).items ?? []; }
  catch (error) { toast(error.message, true); }
  if (state.tab !== 'library') return wrap;

  const roots = items.filter((item) => item.parent_id === null || item.parent_id === undefined);
  const host = el('div');
  if (roots.length === 0) host.append(el('div', { class: 'empty', text: '资料库为空。文件、网址、文件夹都会挂在这里。' }));
  else for (const item of roots) host.append(libNode(name, item, items));

  const type = el('select', {}, [
    el('option', { value: 'file', text: '文件' }),
    el('option', { value: 'web', text: '网址' }),
    el('option', { value: 'libfolder', text: '文件夹' }),
  ]);
  const itemName = el('input', { placeholder: '名称' });
  const desc = el('input', { placeholder: '备注（可选）' });
  const target = el('input', { placeholder: '路径 / URL（可选）' });
  const parent = el('select', {}, [el('option', { value: '', text: '（根）' })].concat(
    items.filter((i) => i.type === 'libfolder').map((i) => el('option', { value: i.id, text: i.name })),
  ));

  wrap.append(host, el('div', { class: 'section' }, [
    el('h3', { text: '新增资料' }),
    el('div', { class: 'row' }, [field('类型', type), field('名称', itemName), field('备注', desc), field('路径/URL', target), field('父文件夹', parent)]),
    el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', {
        text: '添加',
        onclick: async () => {
          if (itemName.value.trim() === '') { toast('名称必填', true); return; }
          const body = { type: type.value, name: itemName.value.trim(), desc: desc.value };
          if (parent.value !== '') body.parent_id = parent.value;
          if (target.value.trim() !== '') {
            if (type.value === 'web') body.url = target.value.trim();
            else body.path = target.value.trim();
          }
          try { await api('/projects/' + enc(name) + '/library', { method: 'POST', body }); renderProject(); }
          catch (error) { toast(error.message, true); }
        },
      }),
    ]),
  ]));
  return wrap;
}

function libNode(name, item, all) {
  const children = all.filter((candidate) => candidate.parent_id === item.id);
  const label = { file: '文件', web: '网址', libfolder: '文件夹' }[item.type] ?? item.type;
  const target = item.type === 'web' ? item.url : item.path;
  const row = el('div', { class: 'lib-item' }, [
    el('span', { class: 'lt', text: label }),
    el('span', { class: 'ln', text: item.name, title: target || item.name }),
    item.desc ? el('span', { class: 'ld', text: item.desc }) : null,
    item.pinned ? el('span', { class: 'pin', text: '★' }) : null,
    el('button', {
      class: 'ghost', style: 'padding:1px 7px;font-size:12px', text: '编辑',
      onclick: () => {
        const newName = el('input', { value: item.name });
        const newDesc = el('input', { value: item.desc ?? '' });
        const box = el('div', { class: 'row', style: 'padding:8px 0;border-bottom:1px solid var(--line)' }, [
          field('名称', newName), field('备注', newDesc),
          el('button', {
            text: '保存',
            onclick: async () => {
              try {
                await api('/projects/' + enc(name) + '/library/' + enc(item.id), { method: 'PATCH', body: { name: newName.value, desc: newDesc.value } });
                renderProject();
              } catch (error) { toast(error.message, true); }
            },
          }),
        ]);
        row.after(box);
        newName.focus();
      },
    }),
    el('button', {
      class: 'ghost', style: 'padding:1px 7px;font-size:12px',
      text: item.pinned ? '取消置顶' : '置顶',
      onclick: async () => {
        try {
          await api('/projects/' + enc(name) + '/library/' + enc(item.id), { method: 'PATCH', body: { pinned: !item.pinned } });
          renderProject();
        } catch (error) { toast(error.message, true); }
      },
    }),
    el('button', {
      class: 'ghost', style: 'padding:1px 7px;font-size:12px;color:var(--danger)', text: '删除',
      onclick: async () => {
        if (!confirm('删除「' + item.name + '」？')) return;
        try { await api('/projects/' + enc(name) + '/library/' + enc(item.id), { method: 'DELETE' }); renderProject(); }
        catch (error) { toast(error.message, true); }
      },
    }),
  ]);
  if (children.length === 0) return row;
  return el('div', {}, [row, el('div', { class: 'lib-children' }, children.map((child) => libNode(name, child, all)))]);
}

/* ── assets ─────────────────────────────────────────────────── */

async function panelAssets(detail) {
  const name = detail.project.meta.name;
  const wrap = el('div', { class: 'panel on' });
  let aggregate = null;
  try { aggregate = await api('/projects/' + enc(name) + '/assets'); }
  catch (error) { toast(error.message, true); }
  if (state.tab !== 'assets') return wrap;
  const refs = aggregate?.refs ?? [];
  const files = aggregate?.files ?? [];

  const refHost = el('div');
  if (refs.length === 0) refHost.append(el('div', { class: 'empty', text: '还没有绑定本地目录。绑定的目录会进入 L1 上下文，让模型知道去哪里读项目代码。' }));
  else {
    refHost.append(el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, ['名称', '路径', '权限', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, refs.map((ref) => el('tr', {}, [
        el('td', { text: ref.name }),
        el('td', { text: ref.path, style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px' }),
        el('td', { text: ref.readonly ? '只读' : '可写' }),
        el('td', { class: 'ops' }, [
          el('button', {
            class: 'ghost', text: ref.readonly ? '改为可写' : '改为只读',
            onclick: async () => {
              if (!ref.id) { toast('该引用缺少 id，先刷新', true); return; }
              try {
                await api('/projects/' + enc(name) + '/assets/ref/' + enc(ref.id), { method: 'PATCH', body: { readonly: !ref.readonly } });
                renderProject();
              } catch (error) { toast(error.message, true); }
            },
          }),
          el('button', {
            class: 'ghost', text: '解绑', style: 'color:var(--danger)',
            onclick: async () => {
              if (!ref.id) { toast('该引用缺少 id，先刷新', true); return; }
              if (!confirm('解绑「' + ref.name + '」？不会删除目录本身。')) return;
              try { await api('/projects/' + enc(name) + '/assets/ref/' + enc(ref.id), { method: 'DELETE' }); renderProject(); }
              catch (error) { toast(error.message, true); }
            },
          }),
        ]),
      ]))),
    ]));
  }

  const refPath = el('input', { placeholder: '/绝对路径/到/本地目录' });
  const refReadonly = el('input', { type: 'checkbox' });
  const mkdir = el('input', { placeholder: '相对子目录，如 src/docs' });

  wrap.append(el('div', { class: 'section' }, [el('h3', { text: '本地目录引用' }), refHost]), el('div', { class: 'section' }, [
    el('h3', { text: '绑定目录' }),
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [refPath]),
      el('label', { class: 'row', style: 'gap:6px;font-size:12.5px' }, [refReadonly, el('span', { text: '只读' })]),
      el('button', {
        text: '绑定',
        onclick: async () => {
          const value = refPath.value.trim();
          if (value === '') { toast('填一个绝对路径', true); return; }
          try { await api('/projects/' + enc(name) + '/assets/ref', { method: 'POST', body: { path: value } }); renderProject(); }
          catch (error) { toast(error.message, true); }
        },
      }),
    ]),
  ]), el('div', { class: 'section' }, [
    el('h3', { text: '项目内文件（' + files.length + '）' }),
    files.length === 0
      ? el('div', { class: 'empty', text: '项目目录下暂无文件。' })
      : el('table', { class: 'grid' }, [
        el('thead', {}, [el('tr', {}, ['名称', '类型', '大小', '修改时间'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, files.slice(0, 200).map((file) => el('tr', {}, [
          el('td', { text: file.name }),
          el('td', { text: file.type === 'dir' ? '目录' : '文件' }),
          el('td', { text: file.type === 'dir' ? '—' : formatBytes(file.size) }),
          el('td', { text: fmtUnix(file.mtime) }),
        ]))),
      ]),
    el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('div', { class: 'grow' }, [mkdir]),
      el('button', {
        class: 'ghost', text: '建子目录',
        onclick: async () => {
          if (mkdir.value.trim() === '') { toast('填相对路径', true); return; }
          try { await api('/projects/' + enc(name) + '/assets/mkdir', { method: 'POST', body: { relative: mkdir.value.trim() } }); renderProject(); }
          catch (error) { toast(error.message, true); }
        },
      }),
    ]),
  ]));
  return wrap;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ── memory / instructions ──────────────────────────────────── */

function textPanel(detail, kind, hint) {
  const name = detail.project.meta.name;
  const wrap = el('div', { class: 'panel on' });
  const area = el('textarea', { rows: '20' });
  area.value = (kind === 'memory' ? detail.memory : detail.instructions) ?? '';
  const save = el('button', {
    text: '保存',
    onclick: async () => {
      try {
        await api('/projects/' + enc(name) + '/' + kind, { method: 'PUT', body: { content: area.value } });
        toast('已保存');
        await refreshDetail();
      } catch (error) { toast(error.message, true); }
    },
  });
  wrap.append(el('div', { class: 'section' }, [
    el('h3', { text: kind === 'memory' ? '项目记忆 memory.md' : '项目指令 instructions.md' }),
    el('p', { class: 'muted', text: hint }),
    area,
    el('div', { class: 'row', style: 'margin-top:10px' }, [save]),
  ]));
  return wrap;
}

/* ── extras ─────────────────────────────────────────────────── */

async function panelExtras(detail) {
  const name = detail.project.meta.name;
  const wrap = el('div', { class: 'panel on' });
  const lists = [
    ['skills', '技能', '该项目可用的技能名'],
    ['datasources', '数据源', 'GenericAgent 导入的数据源 id'],
    ['experts', '专家', 'GenericAgent 导入的专家名'],
  ];
  const results = await Promise.all(lists.map(([key]) =>
    api('/projects/' + enc(name) + '/' + key).then((d) => d[key] ?? []).catch(() => [])));
  if (state.tab !== 'extras') return wrap;
  lists.forEach(([key, title, hint], index) => {
    const values = results[index];
    wrap.append(el('div', { class: 'section' }, [
      el('h3', { text: title + '（' + values.length + '）' }),
      values.length === 0
        ? el('div', { class: 'empty', text: '暂无。' })
        : el('div', { class: 'row' }, values.map((value) => el('span', { class: 'kb-tag', text: value }))),
      el('p', { class: 'muted', style: 'font-size:12px', text: hint + '（只读，随 L1 上下文注入）' }),
    ]));
  });
  return wrap;
}

const PANELS = {
  overview: panelOverview,
  board: panelBoard,
  members: panelMembers,
  library: panelLibrary,
  assets: panelAssets,
  memory: (detail) => textPanel(detail, 'memory', '记忆是 L2：不进提示词，模型在任务涉及项目上下文时自行读取。每条一行、写成未来可直接复用的形式。'),
  instructions: (detail) => textPanel(detail, 'instructions', '指令全文会注入每轮 L1 上下文，请只放用户设定、必须严格遵守的规则。'),
  extras: panelExtras,
};

/* ── header actions ─────────────────────────────────────────── */

$('#btn-refresh').addEventListener('click', () => {
  void loadProjects().then(() => (state.name ? refreshDetail() : undefined)).catch((e) => toast(e.message, true));
});

$('#btn-new').addEventListener('click', async () => {
  const name = prompt('新项目名（用作目录名）');
  if (name === null || name.trim() === '') return;
  const goal = prompt('一句话目标（可留空）') ?? '';
  try {
    await api('/projects/new', { method: 'POST', body: { name: name.trim(), goal } });
    await loadProjects();
    await openProject(name.trim());
  } catch (error) { toast(error.message, true); }
});

$('#btn-edit-goal').addEventListener('click', async () => {
  if (state.name === null) return;
  const goal = prompt('项目目标', state.detail?.project?.meta?.goal ?? '');
  if (goal === null) return;
  try { await api('/projects/' + enc(state.name), { method: 'PATCH', body: { goal } }); await loadProjects(); await refreshDetail(); }
  catch (error) { toast(error.message, true); }
});

$('#btn-rename').addEventListener('click', async () => {
  if (state.name === null) return;
  const next = prompt('新项目名', state.name);
  if (next === null || next.trim() === '' || next.trim() === state.name) return;
  try {
    await api('/projects/' + enc(state.name) + '/rename', { method: 'PUT', body: { name: next.trim() } });
    state.name = next.trim();
    await loadProjects();
    await refreshDetail();
  } catch (error) { toast(error.message, true); }
});

$('#btn-archive').addEventListener('click', async () => {
  if (state.name === null) return;
  const archived = state.detail?.project?.meta?.status === 'archived';
  try {
    await api('/projects/' + enc(state.name) + '/' + (archived ? 'restore' : 'archive'), { method: 'POST' });
    await loadProjects();
    await refreshDetail();
  } catch (error) { toast(error.message, true); }
});

$('#btn-delete').addEventListener('click', async () => {
  if (state.name === null) return;
  if (!confirm('删除项目「' + state.name + '」及其全部文件？此操作不可撤销。')) return;
  try {
    await api('/projects/' + enc(state.name), { method: 'DELETE' });
    state.name = null;
    state.detail = null;
    renderProject();
    await loadProjects();
  } catch (error) { toast(error.message, true); }
});

void loadProjects().catch((error) => toast(error.message, true));
