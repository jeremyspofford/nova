# @nova/cli

The `nova` command (ADR-097 D1): extension authoring (FR-117, `docs/14` §4.3), Nova's MCP server
for MCP clients that only speak stdio (FR-044) and data export and import (FR-105).

```text
nova init <dir> [--id <reverse.dns.id>] [--name <name>]
nova validate <folder|bundle.novax> [--json]
nova pack <folder> [--key <file>] [--out <file.novax>] [--unsigned]
nova keys generate [--key <file>] [--force]
nova keys show [--key <file>]
nova dev <folder> [--once] [--trust-hooks]
nova mcp stdio [--url <url>] [--token-file <file>]
nova data export|import ...
```

- `init` copies the sample extension of `@nova/sdk` (`packages/sdk/examples/hello`) with a new
  id and name.
- `validate` lists every problem at once: plugin.json and its parts, extension.json, filesystem
  scopes, panel CSP domains outside the declared network permissions, hook definitions,
  observable events, modules that do not load or import something outside the extension, and a
  bundle's signature. Exit code 1 when there is a problem.
- `pack` validates, then writes `<id>-<version>.novax` signed with the publisher key (or
  `--unsigned`).
- `keys generate` writes an Ed25519 key to `$XDG_CONFIG_HOME/nova/publisher-key` (or
  `NOVA_PUBLISHER_KEY`, or `--key`), mode 0600; it refuses to overwrite one without `--force` and
  to write inside a Git repository. `keys show` prints the public key and its fingerprint, which
  the Hub's owner adds to `plugins.trustedPublishers`.
- `dev` validates and packs the folder, loads it into the Hub (`POST /api/v1/extensions/dev`,
  always unverified, with the sideload confirmation), then watches the folder and reloads on
  every change. `--once` loads and exits; `--trust-hooks` trusts the extension's hooks at the
  hashes of each load.
- `mcp stdio` relays an MCP client's stdio to Nova's MCP server (`packages/mcp`, FR-044), with
  the client's token from `NOVA_MCP_TOKEN` or a file.
- `data` is the data controls module of `@nova/core` (`datactl/cli.ts`).

The Hub and the owner's session token come from `NOVA_URL` and `NOVA_TOKEN`; a token never goes
on the command line. `NOVA_URL` must be https, or http to this machine.

Run it from the repository with `node packages/cli/src/main.ts <command>`; `npm install` links it
as `nova`.
