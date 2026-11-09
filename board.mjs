import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const branch = 'team-board', upstream = `refs/remotes/origin/${branch}`;
const stages = ['backlog', 'ready', 'doing', 'review', 'done'];
const idPattern = /^WV-[A-Z0-9]{3,16}$/;
const holds = t => ['doing', 'review'].includes(t.status);
const revision = t => createHash('sha256').update(JSON.stringify(t)).digest('hex');
const token = randomBytes(24).toString('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const run = (args, options = {}) => spawnSync('git', args, {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 18000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env }, input: options.input,
});
function git(args, options) {
  const r = run(args, options);
  if (r.status !== 0) fail(`Git: ${r.error?.message || r.stderr?.trim() || args[0]}`, 503);
  return r.stdout.trim();
}
const actor = run(['config', 'user.name']).stdout?.trim() || '';
const email = run(['config', 'user.email']).stdout?.trim() || '';
let lastSync = null, syncError = null, lastAttempt = 0;
function sync() {
  lastAttempt = Date.now();
  try {
    if (git(['branch', '--show-current']) !== branch) fail(`Открой отдельную копию ветки ${branch}.`, 409);
    if (git(['status', '--porcelain'])) fail('В копии доски есть локальные изменения. Сохрани их через Git, прежде чем обновлять доску.', 409);
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${upstream}`]);
    if (run(['merge-base', '--is-ancestor', 'HEAD', upstream]).status !== 0) {
      fail('Локальная ветка опережает GitHub или разошлась с ним. Сверь ветки через Git.', 409);
    }
    if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', upstream])) git(['merge', '--ff-only', upstream]);
    lastSync = new Date().toISOString();
    syncError = null;
    return git(['rev-parse', upstream]);
  } catch (error) { syncError = error.message; throw error; }
}
function tasks() {
  return readdirSync(join(root, 'tasks')).filter(n => idPattern.test(n.slice(0, -5)) && n.endsWith('.json')).sort()
    .map(n => JSON.parse(readFileSync(join(root, 'tasks', n), 'utf8')));
}
const normalize = value => value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
const overlaps = (a, b) => {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
function clean(input, key, max, fallback = '') {
  const value = input[key] ?? fallback;
  if (typeof value !== 'string' || value.length > max) fail(`Проверь поле «${key}» (до ${max} символов).`);
  return value.trim();
}
function candidate(input, before, all, id) {
  const title = clean(input, 'title', 120, before?.title);
  const description = clean(input, 'description', 3000, before?.description);
  const status = clean(input, 'status', 10, before?.status ?? 'backlog');
  const raw = input.areas ?? before?.areas ?? [];
  if (!Array.isArray(raw) || raw.length > 12 || raw.some(a => typeof a !== 'string' || a.length > 160)) fail('Укажи до 12 зон работы.');
  const areas = [...new Set(raw.map(normalize).filter(Boolean))];
  if (areas.some(a => a.startsWith('/') || a.includes(':') || a.split('/').some(part => ['.', '..', ''].includes(part)))) fail('Зона должна быть относительным путём или коротким названием.');
  if (!title || !stages.includes(status)) fail('Укажи название и допустимый статус.');
  if (before && holds(before) && before.owner !== actor) fail(`Карточку держит ${before.owner}. Попроси владельца освободить её.`, 409);
  const next = { id, title, description, status, areas, owner: holds({ status }) ? actor : status === 'done' ? before?.owner || actor : '', updatedAt: new Date().toISOString() };
  if (holds(next) && !areas.length) fail('Для работы укажи хотя бы одну зону или путь.');
  if (holds(next)) for (const other of all.filter(t => holds(t) && t.id !== id && t.owner !== actor)) {
    const conflict = areas.find(a => other.areas.some(b => overlaps(a, b)));
    if (conflict) fail(`«${conflict}» пересекается с ${other.id} — эту зону держит ${other.owner}.`, 409);
  }
  return next;
}
function save(input) {
  if (!actor || !email) fail('Укажи git user.name и user.email в копии доски.');
  if (input.id != null && !idPattern.test(input.id)) fail('Некорректный номер задачи.');
  const id = input.id ?? `WV-${randomBytes(5).toString('hex').toUpperCase()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parent = sync(), all = tasks(), before = all.find(t => t.id === id);
    if (input.id && (!before || input.revision !== revision(before))) fail('Карточка изменилась у другого участника. Обнови её перед сохранением.', 409);
    if (!input.id && before) fail('Номер карточки занят, попробуй сохранить ещё раз.', 409);
    const next = candidate(input, before, all, id);
    const blob = git(['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(next, null, 2)}\n` });
    const index = join(git(['rev-parse', '--absolute-git-dir']), `board-index-${randomBytes(8).toString('hex')}`);
    const opts = { env: { GIT_INDEX_FILE: index } };
    let commit;
    try {
      git(['read-tree', parent], opts);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},tasks/${id}.json`], opts);
      const tree = git(['write-tree'], opts);
      commit = git(['commit-tree', tree, '-p', parent, '-m', `board: ${id} ${before ? 'update' : 'add'}`]);
    } finally { rmSync(index, { force: true }); }
    const pushed = run(['push', 'origin', `${commit}:refs/heads/${branch}`]);
    if (pushed.status === 0) {
      try { sync(); } catch { /* The push succeeded; the next refresh will catch up. */ }
      return next;
    }
    const remote = sync();
    if (run(['merge-base', '--is-ancestor', commit, remote]).status === 0) return next;
    if (remote === parent) fail(`GitHub не принял карточку: ${pushed.stderr?.trim() || pushed.error?.message || 'проверь доступ'}`, 503);
  }
  fail('Доску одновременно обновляли несколько раз. Попробуй сохранить ещё раз.', 409);
}
function state(refresh) {
  if (refresh && Date.now() - lastAttempt > 4000) try { sync(); } catch { /* Show local copy and error. */ }
  return { actor, writable: Boolean(actor && email), lastSync, syncError, tasks: tasks().map(t => ({ ...t, revision: revision(t) })) };
}
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/design.html', ['design.html', 'text/html']], ['/workflow.html', ['workflow.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']], ['/ui.js', ['ui.js', 'text/javascript']],
]);
function serve(port) {
  const host = `127.0.0.1:${port}`;
  createServer(async (req, res) => {
    const json = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== host) return json({ error: 'Открой доску по адресу из терминала.' }, 403);
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/board') return json({ ...state(true), token });
      if (req.method === 'POST' && url.pathname === '/api/task') {
        if (req.headers.origin !== `http://${host}` || req.headers['x-board-token'] !== token) return json({ error: 'Обнови страницу доски.' }, 403);
        req.setEncoding('utf8');
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return json({ error: 'Слишком большая карточка.' }, 413); }
        let input;
        try { input = JSON.parse(raw); } catch { fail('Не удалось прочитать карточку.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Не удалось прочитать карточку.');
        return json({ task: save(input), ...state(false) });
      }
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname);
        const contents = readFileSync(join(root, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        return res.end(contents);
      }
      json({ error: 'Страница не найдена.' }, 404);
    } catch (error) { json({ error: error.status ? error.message : 'Ошибка доски. Проверь терминал.' }, error.status || 500); if (!error.status) console.error(error); }
  }).listen(port, '127.0.0.1', () => console.log(`WonderVender: http://${host}`));
}
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    port: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' }, areas: { type: 'string' },
  } });
  const [command = 'serve', id] = positionals;
  if (!existsSync(join(root, 'tasks'))) fail('Не найдена папка tasks.');
  if (command === 'serve') {
    const port = Number(values.port ?? 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Некорректный порт.');
    serve(port);
  } else if (command === 'list') {
    sync(); console.log(JSON.stringify(state(false), null, 2));
  } else if (['add', 'set'].includes(command)) {
    const input = { title: values.title, description: values.description, status: values.status, areas: values.areas?.split(',') };
    if (command === 'set') {
      sync(); const before = tasks().find(t => t.id === id);
      if (!before) fail('Карточка не найдена.', 404);
      input.id = id; input.revision = revision(before);
    }
    console.log(JSON.stringify(save(input), null, 2));
  } else fail('Команды: serve [--port 8765], list, add --title …, set WV-001 --status doing');
} catch (error) { console.error(error.message); process.exitCode = 1; }
