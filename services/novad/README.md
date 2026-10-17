# novad

The Nova device agent (`docs/23`). A small supervisor that registers a device with the Hub,
reports its capability document (`contracts/schemas/device-capability.json`), and runs signed,
sandboxed modules.

M0 ships the skeleton: argument parsing, capability detection, and the service unit.

```bash
npm run test:rust                 # cargo test, in a container if cargo is not installed
node scripts/cargo.mjs run -- capabilities
```
