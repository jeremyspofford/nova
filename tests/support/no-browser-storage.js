// Nova's screens keep small things in the browser's localStorage (ui/js/wait.js, for one, the
// usual length of a wait). A test that runs them in Node imports this first, so they find what a
// browser with storage turned off gives: storage that keeps nothing. Without it they reach Node's
// own localStorage, which with no --localstorage-file is unavailable and says so as an
// ExperimentalWarning on every read. The screens already treat both as "nothing kept", so no
// result changes; only the stray warning goes.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 };
