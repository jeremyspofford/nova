/* global window, document */
// The quick overlay (FR-008, docs/04 §1.1): ask Nova in a new or the current chat, see what
// needs input, start a task, attach a window, open Nova. Every row pairs icon and text.
const api = window.novaLocal;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const LABEL = {
  needs_input: 'Needs input',
  blocked: 'Blocked',
  running: 'Running',
  ready: 'Ready',
};
const KIND = { thread: 'Chat', run: 'Work run', session: 'Code', agent: 'Agent' };
// Small original line icons, one per status (docs/04 §1.1: hand, stop, spinner, check).
const ICON = {
  needs_input:
    'M5 9V4.5a1 1 0 0 1 2 0V8M7 8V3a1 1 0 0 1 2 0v5M9 8V3.5a1 1 0 0 1 2 0V8M11 8V5.5a1 1 0 0 1 2 0V10a5 5 0 0 1-5 5h-.5a4 4 0 0 1-3.2-1.6L2.6 11a1 1 0 0 1 1.6-1.2L5 10.8',
  blocked: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M5.5 5.5h5v5h-5z',
  running: 'M8 1.5a6.5 6.5 0 1 1-6.5 6.5',
  ready: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M5 8.2l2 2 4-4.2',
};

function icon(status) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICON[status] || ICON.ready);
  svg.append(path);
  return svg;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

let current = null;

function render(state) {
  if (!state || state.ok !== true) return;
  current = state.currentThreadId || null;
  const currentOption = $('current-option');
  const currentRadio = currentOption.querySelector('input');
  currentRadio.disabled = !current;
  if (!current && currentRadio.checked) document.querySelector('input[value="new"]').checked = true;

  const list = $('status-list');
  list.replaceChildren();
  if (!state.signedIn) {
    list.append(el('li', 'status-empty', 'Sign in to Nova to see your chats and tasks.'));
  } else if (state.status.length === 0) {
    list.append(el('li', 'status-empty', 'Nothing yet.'));
  }
  for (const item of state.status) {
    const li = el('li');
    const row = el('button', 'status-row');
    row.type = 'button';
    const chip = el('span', `chip ${item.status}`);
    chip.append(icon(item.status), el('span', '', LABEL[item.status] || item.status));
    row.append(
      chip,
      el('span', 'row-title', item.title),
      el('span', 'row-detail', item.reason || KIND[item.kind] || ''),
    );
    row.setAttribute(
      'aria-label',
      `${LABEL[item.status]}: ${item.title}, ${item.reason || KIND[item.kind] || ''}`,
    );
    row.addEventListener('click', () => void api.invoke('quick.open', { path: item.path }));
    li.append(row);
    list.append(li);
  }

  const problems = $('problems');
  problems.replaceChildren(...(state.problems || []).map((p) => el('li', '', p)));
}

$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  void send();
});

$('text').addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter adds a line.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

async function send() {
  const text = $('text').value.trim();
  if (!text) return;
  showError('');
  const target = document.querySelector('input[name="target"]:checked').value;
  const button = $('ask').querySelector('button');
  button.disabled = true;
  $('sent').textContent = 'Sending…';
  try {
    const res = await api.invoke('quick.send', { text, target });
    if (!res || res.ok !== true) {
      $('sent').textContent = '';
      showError((res && res.message) || 'The message was not sent.');
      return;
    }
    $('text').value = '';
    const sent = $('sent');
    sent.replaceChildren();
    const open = el('button', '', 'Open the chat');
    open.type = 'button';
    open.addEventListener('click', () => void api.invoke('quick.open', { path: res.path }));
    sent.append(el('span', '', target === 'new' ? 'Sent to a new chat. ' : 'Sent. '), open);
  } finally {
    button.disabled = false;
  }
}

$('new-task').addEventListener('click', () => void api.invoke('quick.newTask', {}));
$('attach').addEventListener('click', () => void api.invoke('quick.attach', {}));
$('open').addEventListener('click', () => void api.invoke('quick.home', {}));

api.on('quick.status', render);
void api.invoke('quick.state', {}).then(render);
$('text').focus();
