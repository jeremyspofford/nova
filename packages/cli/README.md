# @nova/cli

The `nova` command (ADR-097 D1): extension authoring (FR-117, `docs/14` §4.3), Nova's MCP server
for MCP clients that only speak stdio (FR-044) and data export and import (FR-105).

```text
nova init <dir> [--id <reverse.dns.id>] [--name <name>]
nova validate <folder|bundle.novax> [--json]
nova pack <folder> [--key <file>] [--out <file.novax>] [--unsigned]
nova keys generate [--key <file>] [--force]
nova keys show [--key <file>]
nova dev <folder> [--once] [--trust-hooks] [--accept-publisher-change]
nova mcp stdio [--url <url>] [--token-file <file>]
nova data export [--out <file>] [--passphrase-file <file> --confirm <hub name>]
nova data import <file> [--passphrase-file <file>] [--yes]
nova help | version
```

Exit codes: 0 success, 1 failure, 2 usage (an unknown command, a missing argument or flag value,
`NOVA_URL`/`NOVA_TOKEN` missing or not allowed). AGPL-3.0-or-later (it imports `@nova/core`); the
SDK it builds against, `@nova/sdk`, is Apache-2.0.

- `init` copies the sample extension of `@nova/sdk` (`packages/sdk/examples/hello`) into an empty
  folder with a new id (default `local.<name>`) and name, version `0.1.0`. It reads the sample from
  the repository, so it works from a checkout. It rewrites every reference to the sample's id and
  name in the template's text files (escaped for JSON, JavaScript, HTML and Markdown), so the panel
  calls your own tools.
- `validate` lists every problem at once: plugin.json and its parts, extension.json, filesystem
  scopes, panel CSP domains outside the declared network permissions, hook definitions,
  observable events, modules that do not load or import something outside the extension, and a
  bundle's signature (checked without trusted keys, so a signed bundle reports "untrusted"). A
  `.env` file (other than `.example`, `.sample`, `.template`) or a PEM private key in the folder is
  a problem, so `pack` and `dev` refuse it. Exit code 1 when there is a problem.
- `pack` validates, then writes `<id>-<version>.novax` (in the current folder, or `--out`) signed
  with the publisher key (or `--unsigned`); `.git` and `node_modules` are left out and the zip is
  reproducible. It warns when the key file is readable by others.
- `keys generate` writes an Ed25519 key to `$XDG_CONFIG_HOME/nova/publisher-key`
  (`~/.config/nova/publisher-key`; `%APPDATA%\Nova\publisher-key` on Windows; or
  `NOVA_PUBLISHER_KEY`, or `--key`), folder 0700 and file 0600; it refuses to overwrite one without
  `--force` and to write inside a Git repository. `keys show` prints the public key and its fingerprint, which
  the Hub's owner adds to `plugins.trustedPublishers`.
- `dev` validates and packs the folder, loads it into the Hub (`POST /api/v1/extensions/dev`,
  always unverified, with the sideload confirmation), then watches the folder and reloads on
  every change (300 ms after the last one; `.git` and `node_modules` ignored). `--once` loads and
  exits, 0 only when the extension is running; `--trust-hooks` trusts the extension's hooks at the
  hashes of each load; `--accept-publisher-change` lets the unsigned dev copy replace an installed
  one signed by a publisher (its secrets and data are then cleared). A Hub whose managed policy
  forbids unverified installs refuses dev loads.
- `mcp stdio` relays an MCP client's stdio to Nova's MCP server (`packages/mcp`, FR-044): the
  endpoint from `--url` or `NOVA_MCP_URL`, the client's token from `NOVA_MCP_TOKEN` or a file
  (`--token-file`, `NOVA_MCP_TOKEN_FILE`).
- `data` is the data controls module of `@nova/core` (`datactl/cli.ts`, `docs/12` §9): `export`
  writes `nova-<date>.novaexport` (0600, never over an existing file); a passphrase comes from
  `NOVA_EXPORT_PASSPHRASE` or `--passphrase-file` (never `--passphrase`) and seals the archive,
  which then needs `--confirm <the Hub's name>`; `import` uploads and checks the archive and imports
  it only with `--yes` (into an empty Hub).

The Hub and the owner's session token come from `NOVA_URL` and `NOVA_TOKEN`; a token never goes
on the command line. `NOVA_URL` must be https, or http to this machine.

Run it from the repository with `node packages/cli/src/main.ts <command>`; `npm install` links it
as `nova`.
