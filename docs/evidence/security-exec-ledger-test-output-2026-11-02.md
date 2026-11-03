# Retained S1/S2 test and diagnostic output

Available stdout/stderr from controlled private fixtures, including expected RED failures and failed diagnostics. All canary values are synthetic. Identical log bodies are stored once with every original filename. SHA-256 and byte counts identify original byte streams. Text displays remove trailing whitespace only to satisfy repository whitespace checks; where this changes bytes, an accompanying gzip+base64 block retains the exact original stream losslessly. Decode with Python `gzip.decompress(base64.b64decode(payload))` and verify SHA-256. Commands and ordering are in the implementation reports. Focused runs do not replace ordinary CI.

## `task-1-affected.log`

6653 original bytes; SHA-256 `c649d063e8a04bab6b500e0ca001fe5928f51135e66844192e08443143ac8464`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ the OpenAPI document lists every route the core serves (190.264188ms)
✔ changes need Nova’s own header; unknown paths and methods are refused plainly (469.715736ms)
✔ health reports each part in plain words (135.250538ms)
✔ a task delegated over the API is done, with its evidence and its event trail, and the stream saw it (424.897572ms)
✔ settings and setup write the same profile records (367.178003ms)
✔ extensions install disabled, enable with an OK, and remove without residue (87.440764ms)
✔ an unexpected error answers 500 and is recorded as a problem, not only logged (4.871553ms)
✔ webhooks are the one route outside the X-Nova guard, and they check their own token (391.996636ms)
✔ the guard exemption is explicit: only the webhook route has it, and no other route can claim it (74.63902ms)
✔ the trigger registry over the API: add, edit, pause, remove; tokens never listed; tasks you delegate are reactive triggers (393.689367ms)
✔ the test clock route exists only when NOVA_TEST_CLOCK=1 (377.717079ms)
✔ module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts) (3.209503ms)
✔ a provider that rewrites the test is refused whole: nothing runs, nothing is copied back (236.439717ms)
✔ what the provider may change: inputs.editable is the list; by default the refs minus tests and what the test command names (563.096596ms)
✔ Nova asks before running code a provider wrote, whatever the policy, showing the diff; the run is on exactly what was shown (478.24834ms)
✔ the test run gets a bare environment, a home of its own, and nothing it starts outlives it (298.061951ms)
✔ a background process a test run leaves behind is stopped when it exits (82.150104ms)
✔ copy-back: only what the brief named and let the provider change; never the tasks folder; what stays behind is said (375.336628ms)
✔ a coding agent that changes more than Nova takes from one task is refused in plain words (361.846861ms)
✔ changing where an enabled provider runs or sends, or loosening its permissions, needs confirm; the key never goes to a new host first (318.710261ms)
✔ the JSON files contract: every path is checked first, and one bad path changes nothing (3.190844ms)
✔ diffs, command words and signatures (1.039401ms)
✔ registry lifecycle: built-ins installed and off; configure checks settings; enabling is tier 2 and needs a configured, installed provider (319.640084ms)
✔ a provider extension: a manifest picks a built-in implementation; a bad adapter block is refused; removal leaves no settings behind (230.680577ms)
✔ claude-code (stand-in speaking stream-json): asks first for the test run, works in its own folder, Nova runs the test and checks the diff, then copies back (522.157645ms)
✔ a provider that lies (says it fixed it, changed nothing) ends failed with the verifier’s reason, and nothing is copied back (828.147813ms)
✔ codex (stand-in speaking exec --json): the same brief, verified the same way (253.113744ms)
✔ openai-compatible (stand-in server, SSE): the JSON files contract applied in the task’s folder, local egress, verified (244.532426ms)
✔ a chat model’s reply that reaches outside the task’s folder is refused whole; nothing is written anywhere (390.389556ms)
✔ privacy: a local-only task refuses a remote provider and says why; a model on this machine is local (91.986557ms)
✔ n8n: a signed brief out, a signed callback in through the token webhook, the confirmation checked by Nova (512.231518ms)
✔ front matter: name, about, when, words, needs (2.381202ms)
✔ the shipped skills are both complete (2.206416ms)
✔ install, then remove: nothing left behind; undo puts it back exactly (3.985368ms)
✔ matching: a skill whose words appear is loaded; others are only listed (2.688563ms)
✔ tools on offer follow what is installed and connected (22.624655ms)
✔ no tool reads or writes connection secrets (1.461192ms)
✔ web search results: real links, no ads, no duplicates (1.357628ms)
✔ the model's environment carries none of the host session's memory or identity (3.135426ms)
✔ Claude's skill format works as-is: description, folded lines, extra files (4.203845ms)
✔ adding a skill: plain words for everything that can be wrong (4.936074ms)
✔ a .zip of a skill unpacks; a broken or oversized one is refused (7.518185ms)
✔ exec: subprocess inherits public metadata and no private parent canaries (625.773117ms)
✔ agent: subprocess inherits public metadata and no private parent canaries (531.798973ms)
✔ provider-default: subprocess inherits public metadata and no private parent canaries (392.579758ms)
✔ provider-childEnv: subprocess inherits public metadata and no private parent canaries (409.409196ms)
✔ provider explicit extras remain trusted, separate from inherited parent data (0.255497ms)
✔ no file tool reads or writes the vault, the mesh keys, or Era 2’s connection secrets (10.224507ms)
✔ the filter never lets tool markup reach the screen (0.445198ms)
✔ the filter releases a held-back "<" that turns out to be text (0.187326ms)
✔ parseToolCall splits prose from the call (0.873889ms)
✔ parseToolCall reports bad calls instead of throwing (0.355785ms)
✔ file tools stay inside home and protect the session logs and memory (1.765079ms)
✔ exec runs in the workspace, needs approval, and reports exit codes (10.783615ms)
✔ exec stops at its timeout (203.703307ms)
✔ htmlToText keeps the words and drops the markup (1.854714ms)
✔ the protocol lists every tool on offer (0.74522ms)
✔ memory blocks are taken out of the reply (0.95851ms)
✔ the stream filter hides memory blocks, even split across chunks, and keeps the text after them (0.311784ms)
✔ web_fetch fails when the page answers with an error, and reads it when it answers (25.341272ms)
✔ write_file writes only the workspace and the standing files; everything else of Nova’s is refused (5.260484ms)
✔ read_file never reads Nova’s database, checkpoints, backups, history, the reset marker, the vault or keys (2.58971ms)
✔ a link inside the workspace can’t carry a write or a read out to Nova’s own files (1.676789ms)
✔ write_file never goes through a link, even one that leads nowhere yet (1.887766ms)
✔ the file tools compare names whatever their case or Unicode form (3.143583ms)
ℹ tests 65
ℹ suites 0
ℹ pass 65
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4017.629174
no-Kubernetes tripwire: never fired
````

## `task-1-green-final.log`

753 original bytes; SHA-256 `e75572d5ddf20d423ea1afa9836c0a71a9171316c3857c70e32106ad1c1a17b4`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ exec: subprocess inherits public metadata and no private parent canaries (334.799506ms)
✔ agent: subprocess inherits public metadata and no private parent canaries (330.883864ms)
✔ provider-default: subprocess inherits public metadata and no private parent canaries (330.434167ms)
✔ provider-childEnv: subprocess inherits public metadata and no private parent canaries (336.749067ms)
✔ provider explicit extras remain trusted, separate from inherited parent data (0.282192ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1414.134388
no-Kubernetes tripwire: never fired
````

## `task-1-green.log`

753 original bytes; SHA-256 `caa22e1b13e70ac11a427682f7fa08742e261cc50954b454e8287f51236e2df3`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ exec: subprocess inherits public metadata and no private parent canaries (337.762815ms)
✔ agent: subprocess inherits public metadata and no private parent canaries (327.274782ms)
✔ provider-default: subprocess inherits public metadata and no private parent canaries (336.410832ms)
✔ provider-childEnv: subprocess inherits public metadata and no private parent canaries (341.336857ms)
✔ provider explicit extras remain trusted, separate from inherited parent data (0.366674ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1420.870043
no-Kubernetes tripwire: never fired
````

## `task-1-integration.log`

2633 original bytes; SHA-256 `194569a0e89784a1b4fcbfeb6213a11434d959b69a0b803a537caf92c90a89e3`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ a provider’s key comes from the vault, reaches the server, and appears in no log, problem or receipt (516.80175ms)
✔ the NOVA_SECRET_<NAME> fallback is for development only: the vault wins, and its value is redacted too (98.813535ms)
✔ stopping Nova’s work before a restart: running tasks stop, and no process it started outlives it (1635.777411ms)
✔ asked in a conversation, Nova hands the work to a helper and the reply ends at once; the report comes back as a handoff (2276.944757ms)
✔ a helper's context is scoped: its brief, who the person is, and the files passed along; not the conversation, memory or schedules (1.380222ms)
✔ a helper asks before a step that needs an OK, and waits for the answer (582.384528ms)
✔ with its switch on in Settings, a helper takes that step without asking (465.999044ms)
✔ after a helper's report, Nova says what it means, under it, with no message from the person (3.047034ms)
✔ briefs and files are checked before a helper starts (0.755512ms)
✔ three helpers work at once and a fourth waits; stopping one, working or waiting, says so in the conversation; Try again starts it fresh (112.222975ms)
✔ if Nova stops while a helper works, the conversation hears so when it starts again (4.121466ms)
✔ Activity: each reply, run and helper as an entry with its steps, newest first, in the person’s days (439.872199ms)
✔ Activity pages by week, and says when there is more (12.091789ms)
✔ missed runs are in the timeline; the summary counts what was asked and what ran on its own (0.303036ms)
✔ a day's sentence says what Nova did on its own (0.274527ms)
✔ nothing installed, nothing connected (367.392454ms)
✔ email before Gmail is connected: Nova says where to connect (226.68112ms)
✔ connecting Gmail through the browser flow (27.449212ms)
✔ the email summary: searches, reads, summarizes; mail is screened, and an address after it that the mail didn’t give asks (3070.278729ms)
✔ shopping uses the web search and the playbook (515.718585ms)
✔ removing a skill leaves nothing behind, and undo brings it back (516.617853ms)
✔ disconnecting takes the Gmail tools away (116.942763ms)
✔ an app password connects Gmail; drafts and changes wait for the person and show exactly what (1511.269232ms)
✔ adding your own skill, from a .zip or a folder, and removing it (741.944685ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7475.651466
no-Kubernetes tripwire: never fired
````

## `task-1-red-portable.log`

11031 original bytes; SHA-256 `f441cd921e2ebd0fea9e76e68a221dfc8df8dffa4d99835b4c739a174e0a489c`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ exec: subprocess inherits public metadata and no private parent canaries (330.539967ms)
✖ agent: subprocess inherits public metadata and no private parent canaries (327.702037ms)
✖ provider-default: subprocess inherits public metadata and no private parent canaries (344.757232ms)
✖ provider-childEnv: subprocess inherits public metadata and no private parent canaries (364.679531ms)
✖ provider explicit extras remain trusted, separate from inherited parent data (0.63029ms)
ℹ tests 5
ℹ suites 0
ℹ pass 0
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1441.700632

✖ failing tests:

test at tests/subprocess-environment.test.js:16:3
✖ exec: subprocess inherits public metadata and no private parent canaries (330.539967ms)
  AssertionError [ERR_ASSERTION]: private fields reached exec: WEATHER_67f2e7525967448eae6a2b1f8d6e0fbd, NOVA_SECRET_OPENAI, NOVA_SECRET_future, NOVA_MESH_NAME_TOKEN, NOVA_CALLBACK_TOKEN, NOVA_VAULT_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, CLAUDE_CODE_MEMORY_DIR, CLAUDE_CODE_USER_EMAIL, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_TEST_CONTEXT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR, STARTUP_SECRET
  + actual - expected

  + [
  +   'WEATHER_67f2e7525967448eae6a2b1f8d6e0fbd',
  +   'NOVA_SECRET_OPENAI',
  +   'NOVA_SECRET_future',
  +   'NOVA_MESH_NAME_TOKEN',
  +   'NOVA_CALLBACK_TOKEN',
  +   'NOVA_VAULT_KEY',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'CLAUDE_CODE_MEMORY_DIR',
  +   'CLAUDE_CODE_USER_EMAIL',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_TEST_CONTEXT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR',
  +   'STARTUP_SECRET'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:65:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.start (node:internal/test_runner/test:1242:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_67f2e7525967448eae6a2b1f8d6e0fbd', 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_MESH_NAME_TOKEN', 'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'CLAUDE_CODE_MEMORY_DIR', 'CLAUDE_CODE_USER_EMAIL', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'STARTUP_SECRET' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ agent: subprocess inherits public metadata and no private parent canaries (327.702037ms)
  AssertionError [ERR_ASSERTION]: private fields reached agent: WEATHER_f2001315189e4b1bbc106cfeb8d9584d, NOVA_SECRET_OPENAI, NOVA_SECRET_future, NOVA_CALLBACK_TOKEN, NOVA_VAULT_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_TEST_CONTEXT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_f2001315189e4b1bbc106cfeb8d9584d',
  +   'NOVA_SECRET_OPENAI',
  +   'NOVA_SECRET_future',
  +   'NOVA_CALLBACK_TOKEN',
  +   'NOVA_VAULT_KEY',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_TEST_CONTEXT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:65:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_f2001315189e4b1bbc106cfeb8d9584d', 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ provider-default: subprocess inherits public metadata and no private parent canaries (344.757232ms)
  AssertionError [ERR_ASSERTION]: private fields reached provider-default: WEATHER_db824d4fd280413aba2c4643b34fc5da, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_db824d4fd280413aba2c4643b34fc5da',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:65:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_db824d4fd280413aba2c4643b34fc5da', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ provider-childEnv: subprocess inherits public metadata and no private parent canaries (364.679531ms)
  AssertionError [ERR_ASSERTION]: private fields reached provider-childEnv: WEATHER_d76052bc0cdb4665b60c8b6dc1541e41, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_d76052bc0cdb4665b60c8b6dc1541e41',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:65:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_d76052bc0cdb4665b60c8b6dc1541e41', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:70:1
✖ provider explicit extras remain trusted, separate from inherited parent data (0.63029ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    {
      HOME: '/explicit',
      OPENAI_API_KEY: 'explicit-synthetic',
  +   UNKNOWN_SETTING: 'private'
    }

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:71:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: { HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic', UNKNOWN_SETTING: 'private' },
    expected: { HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic' },
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
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
```

## `task-1-red.log`

11031 original bytes; SHA-256 `08f9922888def8522073423c7331d3155245b3cec6d27caa4b381f1fda0d51f5`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ exec: subprocess inherits public metadata and no private parent canaries (363.036068ms)
✖ agent: subprocess inherits public metadata and no private parent canaries (339.328805ms)
✖ provider-default: subprocess inherits public metadata and no private parent canaries (343.225642ms)
✖ provider-childEnv: subprocess inherits public metadata and no private parent canaries (325.21273ms)
✖ provider explicit extras remain trusted, separate from inherited parent data (0.668621ms)
ℹ tests 5
ℹ suites 0
ℹ pass 0
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1455.725868

✖ failing tests:

test at tests/subprocess-environment.test.js:16:3
✖ exec: subprocess inherits public metadata and no private parent canaries (363.036068ms)
  AssertionError [ERR_ASSERTION]: private fields reached exec: WEATHER_2c706ac87bde4d5797d4fd60c3ba2096, NOVA_SECRET_OPENAI, NOVA_SECRET_future, NOVA_MESH_NAME_TOKEN, NOVA_CALLBACK_TOKEN, NOVA_VAULT_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, CLAUDE_CODE_MEMORY_DIR, CLAUDE_CODE_USER_EMAIL, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_TEST_CONTEXT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR, STARTUP_SECRET
  + actual - expected

  + [
  +   'WEATHER_2c706ac87bde4d5797d4fd60c3ba2096',
  +   'NOVA_SECRET_OPENAI',
  +   'NOVA_SECRET_future',
  +   'NOVA_MESH_NAME_TOKEN',
  +   'NOVA_CALLBACK_TOKEN',
  +   'NOVA_VAULT_KEY',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'CLAUDE_CODE_MEMORY_DIR',
  +   'CLAUDE_CODE_USER_EMAIL',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_TEST_CONTEXT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR',
  +   'STARTUP_SECRET'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:62:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.start (node:internal/test_runner/test:1242:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_2c706ac87bde4d5797d4fd60c3ba2096', 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_MESH_NAME_TOKEN', 'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'CLAUDE_CODE_MEMORY_DIR', 'CLAUDE_CODE_USER_EMAIL', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'STARTUP_SECRET' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ agent: subprocess inherits public metadata and no private parent canaries (339.328805ms)
  AssertionError [ERR_ASSERTION]: private fields reached agent: WEATHER_f9cd37176e4648eebbc84a0b12d57374, NOVA_SECRET_OPENAI, NOVA_SECRET_future, NOVA_CALLBACK_TOKEN, NOVA_VAULT_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_TEST_CONTEXT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_f9cd37176e4648eebbc84a0b12d57374',
  +   'NOVA_SECRET_OPENAI',
  +   'NOVA_SECRET_future',
  +   'NOVA_CALLBACK_TOKEN',
  +   'NOVA_VAULT_KEY',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_TEST_CONTEXT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:62:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_f9cd37176e4648eebbc84a0b12d57374', 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ provider-default: subprocess inherits public metadata and no private parent canaries (343.225642ms)
  AssertionError [ERR_ASSERTION]: private fields reached provider-default: WEATHER_a98d2c9165b94e378d939988e2d6b42f, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_a98d2c9165b94e378d939988e2d6b42f',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:62:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_a98d2c9165b94e378d939988e2d6b42f', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:16:3
✖ provider-childEnv: subprocess inherits public metadata and no private parent canaries (325.21273ms)
  AssertionError [ERR_ASSERTION]: private fields reached provider-childEnv: WEATHER_4d2a16fc63b1413aa3008092ddab049d, ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_SESSION_TOKEN, GOOGLE_CLIENT_SECRET, SESSION_COOKIE, PRIVATE_KEY, SSH_AUTH_SOCK, LC_FUTURE_SECRET, XDG_FUTURE_SECRET, PYTHONPATH, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, GIT_CONFIG_COUNT, NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR
  + actual - expected

  + [
  +   'WEATHER_4d2a16fc63b1413aa3008092ddab049d',
  +   'ANTHROPIC_API_KEY',
  +   'OPENAI_API_KEY',
  +   'AWS_SESSION_TOKEN',
  +   'GOOGLE_CLIENT_SECRET',
  +   'SESSION_COOKIE',
  +   'PRIVATE_KEY',
  +   'SSH_AUTH_SOCK',
  +   'LC_FUTURE_SECRET',
  +   'XDG_FUTURE_SECRET',
  +   'PYTHONPATH',
  +   'LD_LIBRARY_PATH',
  +   'DYLD_INSERT_LIBRARIES',
  +   'GIT_CONFIG_COUNT',
  +   'NODE_OPTIONS',
  +   'BASH_ENV',
  +   'ENV',
  +   'ZDOTDIR'
  + ]
  - []

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:62:14)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'WEATHER_4d2a16fc63b1413aa3008092ddab049d', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/subprocess-environment.test.js:67:1
✖ provider explicit extras remain trusted, separate from inherited parent data (0.668621ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    {
      HOME: '/explicit',
      OPENAI_API_KEY: 'explicit-synthetic',
  +   UNKNOWN_SETTING: 'private'
    }

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/subprocess-environment.test.js:68:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: { HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic', UNKNOWN_SETTING: 'private' },
    expected: { HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic' },
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
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
```

## `task-1-syntax-attempt.log`, `task-1-syntax-strip-attempt.log`

280 original bytes; SHA-256 `c01d656dd566300f308c33685a6e7ed62d2a41ad5db651fab39a1aa7e861ae94`.

````text
/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/src/core/child-env.ts:10
] as const;
  ^^

SyntaxError: Unexpected identifier 'as'
    at wrapSafe (node:internal/modules/cjs/loader:1806:18)
    at checkSyntax (node:internal/main/check_syntax:76:3)

Node.js v26.3.1
````

## `task-1-typecheck-final.log`, `task-1-typecheck.log`, `s2-logs/10-typecheck-final.log`

72 original bytes; SHA-256 `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0`.

````text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
````

## `s2-logs/00-inspection-diagnostics.log`

912 original bytes; SHA-256 `028d6a0b05b3ec5950004c4d292b01046235054a2feb8c42aed7d269de3abab7`.

````text
Read-only inspection diagnostics retained from tool transcripts (no source changed in these commands):
1. Combined cat scripts/test.sh package.json and rg over src/core/handover* failed with exit 1:
   zsh:1: no matches found: src/core/handover*
   The cat output was returned; remaining reads were rerun with literal paths.
2. rg over tests/core/*handover* emitted:
   zsh:1: no matches found: tests/core/*handover*
   Subsequent cat ledger.test.ts/ledger-not-started.test.ts succeeded; shell overall exit 0.
3. rg boundary search included nonexistent tests/core/core.test.ts:
   rg: tests/core/core.test.ts: No such file or directory (os error 2)
   Found actual module-boundary test via rg in tests/core/api.test.ts; later command overall exit 0.
No validation logs were overwritten or deleted. No test was interrupted. Full outputs for these read-only diagnostic commands remain in the task tool transcript.
````

## `s2-logs/01-red.log`

4065 original bytes; SHA-256 `15a083af4e9f4922eb80c9414eb1f5cc2ade347c98c661f1edaa8b2e8dbe560f`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ timeout retains the live worker slot (max 1, late resolve) (107.885108ms)
✖ timeout retains the live worker slot (max 1, late reject) (104.714565ms)
✖ timeout retains the live worker slot (max 2, late resolve) (105.542269ms)
✖ timeout retains the live worker slot (max 2, late reject) (104.595297ms)
✖ drain refuses live timed-out work and resume recovers stopped siblings without overlapping either (127.803498ms)
ℹ tests 5
ℹ suites 0
ℹ pass 0
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 647.431881

✖ failing tests:

test at tests/core/ledger.test.ts:439:3
✖ timeout retains the live worker slot (max 1, late resolve) (107.885108ms)
  AssertionError [ERR_ASSERTION]: no retry overlaps the unresolved first worker

  2 !== 1

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/ledger.test.ts:460:14)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at tests/core/ledger.test.ts:439:3
✖ timeout retains the live worker slot (max 1, late reject) (104.714565ms)
  AssertionError [ERR_ASSERTION]: no retry overlaps the unresolved first worker

  2 !== 1

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/ledger.test.ts:460:14)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at tests/core/ledger.test.ts:439:3
✖ timeout retains the live worker slot (max 2, late resolve) (105.542269ms)
  AssertionError [ERR_ASSERTION]: no retry overlaps the unresolved first worker

  2 !== 1

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/ledger.test.ts:460:14)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at tests/core/ledger.test.ts:439:3
✖ timeout retains the live worker slot (max 2, late reject) (104.595297ms)
  AssertionError [ERR_ASSERTION]: no retry overlaps the unresolved first worker

  2 !== 1

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/ledger.test.ts:460:14)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at tests/core/ledger.test.ts:497:1
✖ drain refuses live timed-out work and resume recovers stopped siblings without overlapping either (127.803498ms)
  AssertionError [ERR_ASSERTION]: unresolved work prevents handover
  + actual - expected

  + []
  - [
  -   'd68a4383-73a5-4fc2-9660-4b83906ca248'
  - ]

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/ledger.test.ts:522:12)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [],
    expected: [ 'd68a4383-73a5-4fc2-9660-4b83906ca248' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/+1X224bNxB991dMnyQjXq32pr20KeAEahsETQLbfRIEg9qdtRhzyS3JtWUUfes39Kk/0t/pl3RIyW3auLGbXtFKELTkXM4MZw6ppVTB82GFWqJFA1bz/pprrIDpDhsYX5KutuII1ii6I2jFsAEmG7hMDCgJr47PPgONtdKNF7eMC8Ar1DdQMyE+hOdfPJk/ffnik2efwiAN2sODH777FizvUA2WPC3jksKuEQS/QrhW+hI1GKEsjDu2gegIBLNIlkaJKzyEcTTNJ0WRRdOiM++P9ppW5cHSSR6l2Sz7/WDxHallkyyN41n5R9DeSC0rs7jMb8EaTRhk0A6GWuVhHH4TuAgO0LeA0hk69E2hPhgwVvU9tdLwleDywsA1t2vn4dSC9T0JAUlG6YyjmIo7TdJyW9xvvgdihTWQ+bEZuCPJ1E96Zm6Hvutbk5rJGoWgeFuVueQ++nZmVaN2w2bQzHIlzzsDszSfpElUFNGBX6jDc1n52NXBgXsCs9t5SGTDkCJcoJ44yYRs0qSskj+ZWgDHxqB2Sc61VhoW85OT8+PT0/nJ2bOXL5YVSOXCENd3pdxGG+QOkbYD18buIhMefWP44PFjiLYT96FlndEinippcWMnHzGp5E2nBvMxjFsusArDcK06DF+jxu4mnNSqwU3oMK1GNKFUVyzoaK1BzYOWb+ygb6WrgYsmfEfVZtMqSg9/zoSZG1n7fCZ6kDCWFKvilJmWTHigc5JL1H5cRUlRVvlb/sYybU+HlbM5bsn5iVLWWM36dyGuGZ1BxlRJkVfJIXzlUS+QVNSk5nNSsQs6l1omDB55patEBaNfdGW0VbHaDkxUtKv8FDc9bSpsKmq6F6jewSpN7pQYr+38S7LfOTe8bZ2Cd73AEYm+/uspeOd5tGfgezLQ+/da1cSaVygbOkx2fDT3QpaUUv4/4d99f2F7Au4J+DcR8M63nj3/9vx7OP/KvIr+mRfl+3n6BiN9Ar2mW5KkbqwpFReAMB7tqgbBT/XakvQRLJb0CGDhfwFGzaxgaVIkQZ6wLEjbOg7K2WwapKsiKaezmsVpMfLGy38Hz7M4rqL4v8vzxfLXRF88sEuwfGtHNIj96UN2hfyNy7t0V3B39BGDfgQOlbaP4Q8AAA==
```

## `s2-logs/02-green-focused.log`

690 original bytes; SHA-256 `00103b6d2ea950d788967da3502b657f7e54e3551e3d0a6f8347f441c6dcadd9`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ timeout retains the live worker slot (max 1, late resolve) (132.344883ms)
✔ timeout retains the live worker slot (max 1, late reject) (135.396335ms)
✔ timeout retains the live worker slot (max 2, late resolve) (131.078283ms)
✔ timeout retains the live worker slot (max 2, late reject) (126.750591ms)
✔ drain refuses live timed-out work and resume recovers stopped siblings without overlapping either (110.42038ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 736.473699
no-Kubernetes tripwire: never fired
````

## `s2-logs/03-ledger-complete.log`

3753 original bytes; SHA-256 `9cf05c9b145b04aeb1f9950de69c3e64b9c69274110941b607efe7acdfd069f9`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ a blocked report whose work never started gives the dispatch back, says so, and waits with the worker’s reason (53.934744ms)
✔ only a blocked report takes the claim: done and failed reports are counted, and so is a blocked one without it (128.328184ms)
✔ notStarted is only for a running task (44.62272ms)
✔ a restart keeps the count: work that said it never started is given back before it runs again (107.79894ms)
✔ a task runs, is verified by reading the file back, and ends done with its evidence (47.650506ms)
✔ a task without an evidence requirement is refused: done must be provable (40.581362ms)
✔ the same idempotency key gives back the same task, not a second one (41.791955ms)
✔ a worker that claims evidence it did not produce is caught, retried, then failed and surfaced (46.456058ms)
✔ evidence that does not match what is on disk fails verification (45.784658ms)
✔ evidence of a kind Nova cannot check yet never counts as proof (45.04152ms)
✔ a local-only task is never handed to a worker that would send data off the device (44.059371ms)
✔ tier 2 waits for an OK; tier 3 needs an explicit confirmation (52.805325ms)
✔ a worker that crashes is retried, and its final failure is a visible problem (85.373557ms)
✔ blocked and partial reports wait for the person instead of passing as done (44.56177ms)
✔ tasks survive a restart: running work is requeued and finishes (70.28433ms)
✔ illegal moves are refused (42.50095ms)
✔ pumping an empty queue settles, so idle() returns (regression: it used to spin forever) (43.928337ms)
✔ a worker past its deadline fails promptly but retains its lane until physical settlement (85.956481ms)
✔ cancelling revokes authority immediately but frees the lane only when the worker settles (57.900212ms)
✔ a read-back target matches however it is spelled, and an append is not repeated (42.954769ms)
✔ the workspace worker does not apply the same brief twice (39.053077ms)
✔ a read-back requirement must name its target (37.876723ms)
✔ a local-only task assigned to a worker that sends data off the device is refused up front (39.918875ms)
✔ tier 3 needs a fresh confirmation before every run, including retries (42.624416ms)
✔ a blocked task can be retried by the person (43.552703ms)
✔ a task that keeps dying with Nova is failed after the attempt limit, not requeued forever (39.622843ms)
✔ the transition table refuses moves it does not list (0.132055ms)
✔ a confirmation counts only when a checker for its system finds it; the checker is given the brief; unknown systems still fail (54.25105ms)
✔ a worker can run tasks side by side in a lane, up to its limit; other workers still run one at a time (159.051152ms)
✔ a waiting task can be sent back to the queue with the reason why (44.804205ms)
✔ bad parameters are refused, not stored as problems (39.313844ms)
✔ a worker can take longer than the default timeout when it says so (125.72685ms)
✔ timeout retains the live worker slot (max 1, late resolve) (131.267973ms)
✔ timeout retains the live worker slot (max 1, late reject) (129.732612ms)
✔ timeout retains the live worker slot (max 2, late resolve) (131.195897ms)
✔ timeout retains the live worker slot (max 2, late reject) (133.478544ms)
✔ drain refuses live timed-out work and resume recovers stopped siblings without overlapping either (113.310821ms)
✔ halt revokes authority and resume waits for physical settlement before recovery (62.186918ms)
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2316.657576
no-Kubernetes tripwire: never fired
````

## `s2-logs/04-handover-wording-red.log`

1217 original bytes; SHA-256 `8d39fe42e25f23dfc7e615f40743eb66a51d14a8fea546be483d658fc252714d`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ planned promotion refuses a timed-out live worker and keeps the old hub usable (3892.345298ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4305.662112

✖ failing tests:

test at tests/core/mesh-promotion.test.ts:465:1
✖ planned promotion refuses a timed-out live worker and keeps the old hub usable (3892.345298ms)
  AssertionError [ERR_ASSERTION]: a timed-out worker has not claimed a commit
      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/mesh-promotion.test.ts:493:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'Work past its commit point was still running. Nothing changed.',
    expected: /past its commit point/,
    operator: 'doesNotMatch',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

## `s2-logs/05-handover-wording-green.log`

364 original bytes; SHA-256 `47d497392ac231135db60b7ecaf6f4ca5b61a7abc2203c28c0544b46e8a75889`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ planned promotion refuses a timed-out live worker and keeps the old hub usable (3862.806328ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4224.604766
no-Kubernetes tripwire: never fired
````

## `s2-logs/06-final-affected.log`

8524 original bytes; SHA-256 `518a0bf476b6bacf4697c8f8e907ca1f910b25a54868dd50c7763ebccc79db65`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ after a hard restart, a run that waited for an OK ends with a reason, and its schedule can run again (1694.278402ms)
✔ CDP: answers find their commands by id, even split across chunks or sharing one (2.50718ms)
✔ CDP: an error answer rejects with the method named; events carry their session (0.877417ms)
✔ CDP: a closed pipe fails what is waiting and refuses what comes next; a silent browser times out (50.941943ms)
✔ Chromium: NOVA_CHROMIUM is used when it is there, and said plainly when it isn’t (4.005941ms)
✔ plan: declared hosts decide what a URL may reach: port, subdomains, schemes (0.639562ms)
✔ plan: where a plan’s data goes, so local-only can refuse it (0.510245ms)
✔ plan: every problem is listed; a navigation outside the declared hosts is refused before it runs (2.828004ms)
✔ input: the person’s pointer and keys are checked before they reach the page (0.434936ms)
✔ evidence: a screenshot counts only if Nova took it for this very task (1.10389ms)
✔ evidence: a link counts only if Nova read that page itself and it shows what the brief expects (1.443749ms)
✔ evidence: Nova fetches the page again itself, following redirects only inside the declared hosts (32.486777ms)
✔ ledger: a running worker that needs the person waits as Needs you, and carries on after (62.444566ms)
✔ ledger: after a restart, a task that waited for the person starts again from the beginning (45.888167ms)
✔ core: with no Chromium, browser work says so plainly; bad plans and remote hosts are refused when delegated (445.972572ms)
✔ core: only the console and devices allowed to approve may take over, drive or hand back (251.301051ms)
✔ form site: the form, the step only a person can do, and the record Nova checks against (32.034208ms)
✔ external work that fails after it was sent (bad-evidence) waits for the person; it never reruns by itself (50.519626ms)
✔ external work that fails after it was sent (throw) waits for the person; it never reruns by itself (47.701183ms)
✔ external work that fails after it was sent (garbage) waits for the person; it never reruns by itself (55.750806ms)
✔ external work that fails after it was sent (hang) waits for the person; it never reruns by itself (125.906576ms)
✔ the same failures rerun by themselves for work with no outside effects, or that the far end takes twice as once (194.67969ms)
✔ a retry of external work that needed your OK asks for it again (48.36689ms)
✔ after a restart, external work that was running or waiting for the person waits for them instead of starting over (46.97246ms)
✔ a brief that marks its commit point reruns by itself only if that point was never passed; the ledger notes which (134.402657ms)
✔ Home Assistant: a call whose read-back lags waits for you instead of calling again (a toggle would undo itself) (965.012112ms)
✔ n8n: a workflow that never answers is sent once and waits for you, unless its settings say it takes a brief twice as once (3768.249831ms)
✔ a blocked report whose work never started gives the dispatch back, says so, and waits with the worker’s reason (79.879698ms)
✔ only a blocked report takes the claim: done and failed reports are counted, and so is a blocked one without it (166.476399ms)
✔ notStarted is only for a running task (67.057916ms)
✔ a restart keeps the count: work that said it never started is given back before it runs again (109.084505ms)
✔ a task runs, is verified by reading the file back, and ends done with its evidence (74.19804ms)
✔ a task without an evidence requirement is refused: done must be provable (54.084055ms)
✔ the same idempotency key gives back the same task, not a second one (57.114497ms)
✔ a worker that claims evidence it did not produce is caught, retried, then failed and surfaced (59.253409ms)
✔ evidence that does not match what is on disk fails verification (63.512603ms)
✔ evidence of a kind Nova cannot check yet never counts as proof (43.75308ms)
✔ a local-only task is never handed to a worker that would send data off the device (53.377919ms)
✔ tier 2 waits for an OK; tier 3 needs an explicit confirmation (56.1567ms)
✔ a worker that crashes is retried, and its final failure is a visible problem (95.940154ms)
✔ blocked and partial reports wait for the person instead of passing as done (47.367361ms)
✔ tasks survive a restart: running work is requeued and finishes (80.750348ms)
✔ illegal moves are refused (44.34578ms)
✔ pumping an empty queue settles, so idle() returns (regression: it used to spin forever) (46.038109ms)
✔ a worker past its deadline fails promptly but retains its lane until physical settlement (92.250105ms)
✔ cancelling revokes authority immediately but frees the lane only when the worker settles (61.136256ms)
✔ a read-back target matches however it is spelled, and an append is not repeated (47.320902ms)
✔ the workspace worker does not apply the same brief twice (41.853971ms)
✔ a read-back requirement must name its target (43.661636ms)
✔ a local-only task assigned to a worker that sends data off the device is refused up front (45.294655ms)
✔ tier 3 needs a fresh confirmation before every run, including retries (48.94802ms)
✔ a blocked task can be retried by the person (47.524926ms)
✔ a task that keeps dying with Nova is failed after the attempt limit, not requeued forever (45.095996ms)
✔ the transition table refuses moves it does not list (0.136659ms)
✔ a confirmation counts only when a checker for its system finds it; the checker is given the brief; unknown systems still fail (60.207108ms)
✔ a worker can run tasks side by side in a lane, up to its limit; other workers still run one at a time (178.510438ms)
✔ a waiting task can be sent back to the queue with the reason why (41.640418ms)
✔ bad parameters are refused, not stored as problems (41.54784ms)
✔ a worker can take longer than the default timeout when it says so (128.225923ms)
✔ timeout retains the live worker slot (max 1, late resolve) (131.777164ms)
✔ timeout retains the live worker slot (max 1, late reject) (129.470186ms)
✔ timeout retains the live worker slot (max 2, late resolve) (129.04939ms)
✔ timeout retains the live worker slot (max 2, late reject) (132.755019ms)
✔ drain refuses live timed-out work and resume recovers stopped siblings without overlapping either (118.228225ms)
✔ halt revokes authority and resume waits for physical settlement before recovery (57.974265ms)
✔ pre-checks: each reason refuses, in words, and a good candidate passes every one (2.54388ms)
✔ trust widened to every pinned candidate, and only there: agents accept a candidate’s roster at a higher epoch, never an unpinned key, never a lower epoch; runtime bundles stay hub and standby (3.910982ms)
✔ the hub’s calls to the candidate and the handover are signed, fresh, used once, and carry no key (3.546438ms)
✔ the drain: nothing new starts but what is kept; running work gets the bound, then is handed over; work past its commit point is never cut (1338.524462ms)
✔ fencing covers every pinned hub candidate: a candidate computer’s higher epoch, proven with its key, makes the hub step down (269.107867ms)
✔ pre-checks through the hub: a phone, a computer that is no candidate, a candidate that isn’t the standby, a hub with no fresh backup, a candidate short of disk and memory, another release (1178.550487ms)
✔ a planned promotion end to end: catch-up, drain, writes held, transfer, the old hub a live standby, the window passed, every step a ledger task (2920.264138ms)
✔ the new hub fails its checks (the stable name didn’t move): the old hub takes the role back by itself at epoch + 2, and the new one steps down to copy it (2522.181874ms)
✔ the emergency sheet says the backup’s time, what was lost and that connectors sign in again; a hub or a live standby is sent elsewhere (462.887428ms)
✔ writes held: every change refused with the reason, the mesh’s own calls still pass, hello says so (116.511298ms)
✔ planned promotion refuses a timed-out live worker and keeps the old hub usable (3805.952424ms)
✔ stopping Nova’s work before a restart: running tasks stop, and no process it started outlives it (1648.340894ms)
ℹ tests 77
ℹ suites 0
ℹ pass 77
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13119.433099
no-Kubernetes tripwire: never fired
````

## `s2-logs/07-typecheck.log`

632 original bytes; SHA-256 `6406e4a71d6a75d3e4e07dc5ab1a61493fd937ccdb2f929d44373f0ef9dc66a2`.

````text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
tests/core/mesh-promotion.test.ts(471,41): error TS2345: Argument of type '{ id: string; name: string; about: string; egress: "none"; evidence: never[]; timeoutMs: number; lane: () => { key: string; max: number; }; run: (b: Brief) => Promise<unknown>; }' is not assignable to parameter of type 'LanedWorker'.
  Property 'health' is missing in type '{ id: string; name: string; about: string; egress: "none"; evidence: never[]; timeoutMs: number; lane: () => { key: string; max: number; }; run: (b: Brief) => Promise<unknown>; }' but required in type 'Worker'.
````

## `s2-logs/08-boundary.log`

406 original bytes; SHA-256 `6e1ad4ee51f7d62ad8d5fb694775e2903eb63b76ff7fda6699d96a35481ae36a`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts) (4.028151ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 490.374217
no-Kubernetes tripwire: never fired
````

## `s2-logs/09-handover-recovery.log`

859 original bytes; SHA-256 `03c4d98c47f31c01b72723a3939f585ba2649147b0ca63f8426b2a91cdb9ec8c`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ R5 (p5): the old hub restarts during the transfer: it starts holding, never runs handed-over work again, and follows the new hub (18213.464852ms)
✔ R7 (p7): the candidate dies at the transfer: held, told, released when it says (signed) it didn’t take it, or cancelled at tier 3 when it can’t say (31984.129689ms)
✔ R9 (p9): the candidate takes the role and then errors: the old hub doesn’t resume; it follows once the candidate says (26378.518218ms)
✔ a clock off by two minutes makes probes unknown, never a roll-back; a stale record isn’t probed at restart (3209.904912ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 80356.494987
no-Kubernetes tripwire: never fired
````

## `s2-logs/11-promotion-final.log`

1920 original bytes; SHA-256 `c17265b95a5ca1fbf6df957465a0791d553b20d9826fb5ca3a97bdf12b617ec2`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ pre-checks: each reason refuses, in words, and a good candidate passes every one (2.292011ms)
✔ trust widened to every pinned candidate, and only there: agents accept a candidate’s roster at a higher epoch, never an unpinned key, never a lower epoch; runtime bundles stay hub and standby (3.77498ms)
✔ the hub’s calls to the candidate and the handover are signed, fresh, used once, and carry no key (4.261761ms)
✔ the drain: nothing new starts but what is kept; running work gets the bound, then is handed over; work past its commit point is never cut (1278.615543ms)
✔ fencing covers every pinned hub candidate: a candidate computer’s higher epoch, proven with its key, makes the hub step down (240.770483ms)
✔ pre-checks through the hub: a phone, a computer that is no candidate, a candidate that isn’t the standby, a hub with no fresh backup, a candidate short of disk and memory, another release (1071.228673ms)
✔ a planned promotion end to end: catch-up, drain, writes held, transfer, the old hub a live standby, the window passed, every step a ledger task (2909.327822ms)
✔ the new hub fails its checks (the stable name didn’t move): the old hub takes the role back by itself at epoch + 2, and the new one steps down to copy it (2367.574666ms)
✔ the emergency sheet says the backup’s time, what was lost and that connectors sign in again; a hub or a live standby is sent elsewhere (481.217207ms)
✔ writes held: every change refused with the reason, the mesh’s own calls still pass, hello says so (119.910587ms)
✔ planned promotion refuses a timed-out live worker and keeps the old hub usable (3825.536028ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12708.354238
no-Kubernetes tripwire: never fired
````

## `s2-logs/12-diff-check.log`

0 original bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

````text
````

## `s2-logs/14-final-source-sha256.log`

462 original bytes; SHA-256 `08b73f967c1a21967c3c7dd2f50623e8768c272059d2346b99334a7173668acd`.

````text
bcb3c0f2a92d0476015a4119055e9a376e351fd171a861cf3af0052c222d023d  src/core/ledger.ts
2fe5e780a5f942e0d7896fd55a644d28c5318da7682263f86b8023d5ad2b01b0  src/core/mesh/handover.ts
a749833817c20c219166de46f60083337a94714f095f43ed2da128b07ccda6c9  tests/core/ledger.test.ts
87d7fb2080297553b5dd5a6eaba49afe6a028b511dca7340dfd1e7ca5d1be57d  tests/core/effects.test.ts
2a510ada1e707d640a1c3933d84c81cf8221f9c5c3f2f644e4c4f4bb28827ae8  tests/core/mesh-promotion.test.ts
````

## `s2-logs/15-commit.log`

153 original bytes; SHA-256 `9efce7effd684f32552c6e36cfa64a900eef4cad6fa8cfa7877abdc803ce9a79`.

````text
[codex/security-exec-ledger 7055737e] fix(ledger): retain worker capacity until physical settlement
 5 files changed, 319 insertions(+), 85 deletions(-)
````
