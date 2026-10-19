/* global window, document */
// The attach-window preview (FR-214, docs/04 §3.2): the image and the text as separate parts the
// user can drop, redactions shown, and nothing sent until Send.
const api = window.novaLocal;
const $ = (id) => document.getElementById(id);
const draftId = new URLSearchParams(window.location.search).get('draft') || '';

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function render(d) {
  $('source').textContent = d.appName
    ? `From ${d.appName}: ${d.windowTitle}`
    : `From the window "${d.windowTitle}"`;
  const img = $('image');
  if (d.image) {
    img.src = d.image.dataUrl;
    img.hidden = false;
    $('image-note').textContent =
      'The image is sent as it is: check that it shows nothing private.';
  } else {
    $('keep-image').checked = false;
    $('keep-image').disabled = true;
    $('image-note').textContent = 'This system gave no image of the window.';
  }
  const text = $('text');
  if (d.text) {
    text.value = d.text;
    text.hidden = false;
  } else {
    $('keep-text').checked = false;
    $('keep-text').disabled = true;
  }
  $('text-note').textContent = d.textNote || '';
  const notes = [];
  if (d.redactions.length > 0) {
    const n = d.redactions.reduce((s, r) => s + r.count, 0);
    notes.push(`${plural(n, 'secret was', 'secrets were')} masked before attaching.`);
  }
  if (d.passwordFieldsSkipped > 0)
    notes.push(
      `${plural(d.passwordFieldsSkipped, 'password field was', 'password fields were')} left out.`,
    );
  $('redactions').textContent = notes.join(' ');
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
    if (!res || res.ok !== true) showError((res && res.message) || 'Nothing was sent.');
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

void api.invoke('window.capture.draft', { draftId }).then((res) => {
  if (!res || res.ok !== true) {
    showError((res && res.message) || 'This capture is gone.');
    $('send').disabled = true;
    return;
  }
  render(res.draft);
  $('send').focus();
});
