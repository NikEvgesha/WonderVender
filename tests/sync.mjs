// Run with: node tests/sync.mjs (uses a disposable local Git remote).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const source = fileURLToPath(new URL('..', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'wondervender-sync-'));
const remote = join(sandbox, 'remote.git');
const clones = ['Alice', 'Boris'].map(n => join(sandbox, n));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const children = [];
async function start(dir) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['board.mjs', 'serve', '--port', String(port)], { cwd: dir });
  children.push(child);
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const origin = `http://127.0.0.1:${port}`;
  const state = async () => (await fetch(origin + '/api/board')).json();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) return { origin, state }; } catch { /* Starting. */ }
    await delay(50);
  }
  throw Error('Test board did not start');
}
const post = async (board, state, input) => {
  const res = await fetch(board.origin + '/api/task', {
    method: 'POST', headers: { Origin: board.origin, 'X-Board-Token': state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { code: res.status, body: await res.json() };
};
const edit = (state, id, fields) => ({ id, revision: state.tasks.find(t => t.id === id).revision, ...fields });
try {
  git(sandbox, 'init', '--bare', '--initial-branch=team-board', remote);
  const seed = join(sandbox, 'seed');
  mkdirSync(join(seed, 'tasks'), { recursive: true });
  git(seed, 'init', '--initial-branch=team-board');
  git(seed, 'config', 'user.name', 'Test seed');
  git(seed, 'config', 'user.email', 'seed@example.invalid');
  for (const file of ['board.mjs', 'index.html']) copyFileSync(join(source, file), join(seed, file));
  for (const [id, area] of [['WV-001', 'Assets/Interaction'], ['WV-002', 'Assets/Prototype/Brewing'], ['WV-003', 'Assets/Shop']]) {
    writeFileSync(join(seed, 'tasks', id + '.json'), JSON.stringify({ id, title: id, description: '', status: 'ready', areas: [area], owner: '', updatedAt: null }));
  }
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Test fixtures');
  git(seed, 'push', remote, 'team-board');
  for (const [i, dir] of clones.entries()) {
    git(sandbox, 'clone', remote, dir);
    git(dir, 'config', 'user.name', i ? 'Boris' : 'Alice');
    git(dir, 'config', 'user.email', i ? 'boris@example.invalid' : 'alice@example.invalid');
  }
  const [a, b] = await Promise.all(clones.map(start));
  const [initialA, initialB] = await Promise.all([a.state(), b.state()]);
  assert.equal(initialA.tasks.length, 3);
  assert.equal(initialB.syncError, null);
  const result = await Promise.all([
    post(a, initialA, edit(initialA, 'WV-001', { status: 'doing', areas: ['Assets/Prototype'] })),
    post(b, initialB, edit(initialB, 'WV-002', { status: 'doing' })),
  ]);
  assert.deepEqual(result.map(r => r.code).sort(), [200, 409], JSON.stringify(result));
  assert.match(result.find(r => r.code === 409).body.error, /пересекается/);
  const race = await Promise.all([
    post(a, initialA, edit(initialA, 'WV-003', { description: 'Уточнение заказа Alice' })),
    post(b, initialB, edit(initialB, 'WV-003', { description: 'Уточнение заказа Boris' })),
  ]);
  assert.deepEqual(race.map(r => r.code).sort(), [200, 409], JSON.stringify(race));
  assert.match(race.find(r => r.code === 409).body.error, /изменилась/);
  const unrelated = await Promise.all([
    post(a, initialA, { title: 'Стеклянная пробка', status: 'backlog' }),
    post(b, initialB, { title: 'Колокольчик', status: 'backlog' }),
  ]);
  assert.deepEqual(unrelated.map(r => r.code), [200, 200], JSON.stringify(unrelated));
  assert.equal(git(remote, 'ls-tree', '--name-only', 'team-board:tasks').split('\n').length, 5);
  assert.equal(git(clones[0], 'status', '--porcelain'), '');
  assert.equal(git(clones[1], 'status', '--porcelain'), '');
  const denied = await fetch(a.origin + '/api/task', { method: 'POST', body: '{}' });
  assert.equal(denied.status, 403);
  console.log('Passed: conflicting paths, stale cards, independent writes, clean checkouts, and request authorization.');
} finally {
  await Promise.all(children.map(child => child.exitCode === null ? (child.kill(), once(child, 'exit')) : null));
  const resolved = realpathSync(sandbox);
  if (dirname(resolved) === realpathSync(tmpdir())) rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
