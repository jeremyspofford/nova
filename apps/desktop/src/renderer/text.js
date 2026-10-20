/* global window, document */
// The page's words, in the shell's language (FR-016): the main process sends them with the
// page's `lang` and `dir` (IPC `shell.text`, again on a language change). Elements carry
// `data-t` (their text), `data-t-placeholder`, `data-t-alt` or `data-t-aria-label`; the window
// title is the `title` entry. Scripts read other words with `window.novaText.t(key)`.
(function () {
  let words = {};
  const listeners = [];

  function apply(res) {
    if (!res || res.ok !== true) return;
    words = res.text || {};
    document.documentElement.lang = res.lang || 'en';
    document.documentElement.dir = res.dir || 'ltr';
    for (const el of document.querySelectorAll('[data-t]'))
      el.textContent = words[el.dataset.t] || '';
    for (const attr of ['placeholder', 'alt', 'aria-label']) {
      const key = `data-t-${attr}`;
      for (const el of document.querySelectorAll(`[${key}]`))
        el.setAttribute(attr, words[el.getAttribute(key)] || '');
    }
    if (words.title) document.title = words.title;
    for (const fn of listeners) fn();
  }

  window.novaText = {
    t: (key) => words[key] || '',
    ready: window.novaLocal.invoke('shell.text', {}).then(apply),
    onChange: (fn) => listeners.push(fn),
  };
  window.novaLocal.on('shell.text', apply);
})();
