**2026-11-07 · Tests · The sandbox's failed-start tests check the right child, with no race**
- What changed: two tests in tests/core/sandbox-launch.test.ts checked that a stopped sandbox child was gone by reading the PID the child writes to given.json on start. When the stop lands before or during that write (a 300 ms timeout or abort on a busy CI runner), the file is missing, still the previous child's, or empty; CI failed once on "Unexpected end of JSON input" (run 42425467104, on #357). A failed start's error now carries the stopped child's `pid` (`startSandbox`, src/core/resilience/sandbox.ts), and both tests check that one is gone.
- What you can now do: nothing new; one fewer random CI failure.
- Still unfinished: nothing known.
- Checked: the file passes 10 runs in a row in iso.sh; typecheck and npm test pass.
