/* global window, document */
// The attach-window preview (FR-214, docs/04 §3.2): the image and the text as separate parts the
// user can drop, redactions shown, and nothing sent until Send.
const api = window.novaLocal;
const t = window.novaText.t;
const $ = (id) => document.getElementById(id);
const draftId = new URLSearchParams(window.location.search).get('draft') || '';

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

// The main process writes the sentences about the draft (`notes`) in the shell's language.
function renderWords(d, notes) {
  $('source').textContent = notes.source;
  $('image-note').textContent = t(d.image ? 'imageAsIs' : 'noImage');
  $('text-note').textContent = d.textNote || '';
  $('redactions').textContent = notes.redactions;
}

function render(d, notes) {
  renderWords(d, notes);
  const img = $('image');
  if (d.image) {
    img.src = d.image.dataUrl;
    img.hidden = false;
  } else {
    $('keep-image').checked = false;
    $('keep-image').disabled = true;
  }
  const text = $('text');
  if (d.text) {
    text.value = d.text;
    text.hidden = false;
  } else {
    $('keep-text').checked = false;
    $('keep-text').disabled = true;
  }
  const currentRadio = $('current-option').querySelector('input');
  currentRadio.disabled = !d.currentThreadId;
  if (d.currentThreadId) currentRadio.checked = true;
  update();
}

function update() {
  const any = $('keep-image').checked || $('keep-text').checked;
  $('send').disabled = !any;
}

$('keep-image').addEventListener('change', update);
$('keep-text').addEventListener('change', update);

$('send').addEventListener('click', async () => {
  showError('');
  $('send').disabled = true;
  try {
    const res = await api.invoke('window.capture.attach', {
      draftId,
      includeImage: $('keep-image').checked,
      includeText: $('keep-text').checked,
      note: $('note').value,
      target: document.querySelector('input[name="target"]:checked').value,
    });
    if (!res || res.ok !== true) showError((res && res.message) || t('notSent'));
  } finally {
    update();
  }
});

$('discard').addEventListener(
  'click',
  () => void api.invoke('window.capture.discard', { draftId }),
);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void api.invoke('window.capture.discard', { draftId });
});

let shown = null;
const load = () => api.invoke('window.capture.draft', { draftId });
window.novaText.onChange(() => {
  // The language changed: the main process writes the draft's sentences again.
  if (shown) void load().then((res) => res && res.ok === true && renderWords(res.draft, res.notes));
});
void window.novaText.ready.then(load).then((res) => {
  if (!res || res.ok !== true) {
    showError((res && res.message) || t('gone'));
    $('send').disabled = true;
    return;
  }
  shown = res.draft;
  render(res.draft, res.notes);
  $('send').focus();
});
