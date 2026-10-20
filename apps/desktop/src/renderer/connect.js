/* global window, document */
// First run (FR-134): an Add Device link, or the Hub address and its fingerprint. The main
// process verifies the Hub before anything is sent; this page only collects and reports.
const api = window.novaLocal;
const t = window.novaText.t;
const $ = (id) => document.getElementById(id);

const problem = $('problem');
const status = $('status');

function showProblem(message) {
  problem.textContent = message || '';
  problem.hidden = !message;
}

function busy(on) {
  for (const b of document.querySelectorAll('button')) b.disabled = on;
  status.textContent = on ? t('checking') : '';
}

const replace = $('replace');
let pending = null;

function askReplace(res, payload) {
  // Another Hub: say which one replaces which, and wait for an explicit choice.
  pending = payload;
  $('replace-text').textContent = res.message;
  $('replace-confirm').textContent = res.confirmLabel || '';
  replace.hidden = false;
  $('replace-cancel').focus();
}

async function connect(payload) {
  showProblem('');
  replace.hidden = true;
  busy(true);
  try {
    const res = await api.invoke('shell.connect', payload);
    if (res && res.ok !== true && res.reason === 'confirm_replace' && res.replace) {
      askReplace(res, payload);
      return;
    }
    if (!res || res.ok !== true) {
      showProblem((res && res.message) || t('couldNotCheck'));
      problem.focus();
      return;
    }
    status.textContent = t('connected');
  } finally {
    busy(false);
  }
}

$('replace-confirm').addEventListener('click', () => {
  if (pending) void connect({ ...pending, replace: true });
});
$('replace-cancel').addEventListener('click', () => {
  pending = null;
  replace.hidden = true;
  status.textContent = t('nothingChanged');
});

$('link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void connect({ link: $('link').value });
});

$('manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void connect({ url: $('url').value, pin: $('pin').value });
});

problem.tabIndex = -1;

void window.novaText.ready
  .then(() => api.invoke('shell.connect.state', {}))
  .then((s) => {
    if (!s || s.ok !== true) return;
    if (s.link) $('link').value = s.link;
    if (s.url) $('url').value = s.url;
    if (s.pin) $('pin').value = s.pin;
    showProblem(s.problem || '');
    if (s.currentText) {
      $('current').textContent = s.currentText;
      $('current').hidden = false;
    }
    (s.link ? $('link') : $('url')).focus();
  });
