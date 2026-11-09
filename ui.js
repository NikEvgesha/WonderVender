const $ = selector => document.querySelector(selector);
const stageNames = { backlog: 'Идеи', ready: 'Готово взять', doing: 'В работе', review: 'На ревью', done: 'Готово' };
const active = t => ['doing', 'review'].includes(t.status);
let model = { tasks: [] }, token, selected, mine = false, busy = false, loading = false;
const board = $('#board'), dialog = $('#editor'), form = $('#task-form');
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function render() {
  const occupied = model.tasks.filter(active);
  $('#working').textContent = occupied.length;
  $('#reserved').textContent = new Set(occupied.flatMap(t => t.areas.map(a => a.toLowerCase()))).size;
  $('#ready').textContent = model.tasks.filter(t => t.status === 'ready').length;
  $('#add').disabled = !model.writable;
  $('#mine').disabled = !model.actor;
  const time = model.lastSync ? new Date(model.lastSync).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'ещё не было';
  const connection = $('#connection');
  connection.classList.toggle('warning', Boolean(model.syncError));
  connection.firstElementChild.textContent = model.syncError
    ? '⚠ Git не обновился. Показана локальная копия.'
    : `● Git: ${time} · ${model.actor || 'без имени'}${model.writable ? '' : ' · только чтение'}`;
  connection.title = model.syncError || '';
  const q = $('#query').value.trim().toLowerCase();
  const found = model.tasks.filter(t => (!mine || t.owner === model.actor) && [t.id, t.title, t.description, t.owner, ...t.areas].join(' ').toLowerCase().includes(q));
  board.replaceChildren();
  for (const [stage, name] of Object.entries(stageNames)) {
    const column = element('section', '', `column stage-${stage}`);
    const items = found.filter(t => t.status === stage);
    const heading = element('h3', name);
    heading.append(element('span', String(items.length), 'count'));
    column.append(heading);
    for (const task of items) {
      const card = element('button', '', 'card');
      card.type = 'button';
      card.append(element('span', task.id, 'id'), element('strong', task.title), element('span', task.description, 'card-desc'));
      if (task.areas.length) {
        const tags = element('span', '', 'tags');
        for (const area of task.areas) tags.append(element('span', area, 'tag'));
        card.append(tags);
      }
      if (task.owner) card.append(element('span', `${active(task) ? '◈ Держит' : '✓ Выполнил'}: ${task.owner}`, 'owner'));
      card.addEventListener('click', () => edit(task));
      column.append(card);
    }
    if (!items.length) column.append(element('p', 'Пока пусто', 'empty'));
    board.append(column);
  }
}
async function refresh() {
  if (loading || busy) return;
  loading = true;
  $('#sync').disabled = true;
  try {
    const r = await fetch('/api/board', { cache: 'no-store' });
    if (!r.ok) throw Error('Доска недоступна');
    const data = await r.json();
    if (!busy) { model = data; token = data.token; render(); }
  } catch (err) {
    model.syncError = err.message;
    render();
  } finally { loading = false; $('#sync').disabled = false; }
}
function edit(task) {
  selected = task;
  $('#task-id').textContent = task?.id || 'НОВАЯ КАРТОЧКА';
  $('#edit-heading').textContent = task ? 'Карточка' : 'Записать дело';
  form.elements.title.value = task?.title || '';
  form.elements.description.value = task?.description || '';
  form.elements.areas.value = task?.areas.join('\n') || '';
  form.elements.status.value = task?.status || 'ready';
  const blocked = task && active(task) && task.owner !== model.actor;
  for (const k of ['title', 'description', 'areas', 'status']) form.elements[k].disabled = !model.writable || blocked;
  $('#save').disabled = !model.writable || blocked;
  $('#form-error').textContent = blocked ? `Карточку держит ${task.owner}.` : '';
  $('#reopen').hidden = true;
  if (!dialog.open) dialog.showModal();
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  $('#save').disabled = true;
  $('#close').disabled = true;
  $('#form-error').textContent = 'Сохраняем карточку в Git…';
  const input = {
    id: selected?.id, revision: selected?.revision, title: form.elements.title.value,
    description: form.elements.description.value, status: form.elements.status.value,
    areas: form.elements.areas.value.split(/\r?\n/).map(a => a.trim()).filter(Boolean),
  };
  try {
    const r = await fetch('/api/task', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': token }, body: JSON.stringify(input) });
    const data = await r.json();
    if (!r.ok) { $('#reopen').hidden = r.status !== 409 || !selected; throw Error(data.error); }
    model = data;
    if (!model.tasks.some(t => t.id === data.task.id)) model.tasks.push(data.task);
    $('#message').textContent = `${data.task.id} сохранена в GitHub.`;
    dialog.close();
    render();
  } catch (err) { $('#form-error').textContent = err.message; }
  finally { busy = false; $('#save').disabled = false; $('#close').disabled = false; }
});
dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
$('#sync').addEventListener('click', refresh);
$('#query').addEventListener('input', render);
$('#mine').addEventListener('click', e => { mine = !mine; e.currentTarget.setAttribute('aria-pressed', mine); render(); });
$('#add').addEventListener('click', () => edit(null));
$('#close').addEventListener('click', () => dialog.close());
$('#reopen').addEventListener('click', async () => {
  if (!window.confirm('Загрузить новую версию? Несохранённые поля в этом окне будут заменены.')) return;
  await refresh();
  const newest = model.tasks.find(t => t.id === selected.id);
  if (newest) edit(newest);
});
refresh();
setInterval(refresh, 15000);
