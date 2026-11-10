### Security
- When Nova runs under its supervisor and Screenpipe's API key is in Nova's vault, capture now uses
  the key through the vault: the vault sends each request to Screenpipe itself, and the rest of Nova
  never reads the key. If the vault won't use it there (not allowed for that address, locked, or not
  running), Capture says so and pulls nothing. This is the first of the places that use a stored key
  to move to the vault; the rest still read it the older way.
