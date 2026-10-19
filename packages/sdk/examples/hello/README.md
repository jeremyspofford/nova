# Hello: a sample Nova extension

A command (`hello.greet`), a panel (`ui://hello/panel`) and two tools (`greet`, a read allowed
without asking; `save_note`, a write that asks), plus a status item, a keybinding, a menu item, a
`tool.post` hook and an event listener. Everything it does is declared in
`.nova-plugin/extension.json`.

```sh
nova validate .
nova pack . --unsigned       # or sign with your key: nova keys generate && nova pack .
NOVA_URL=https://hub.local:8443 NOVA_TOKEN=... nova dev .
```

`nova init <dir>` copies this folder as the template for a new extension.
