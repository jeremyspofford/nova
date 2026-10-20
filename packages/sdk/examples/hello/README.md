# Hello: a sample Nova extension

A command (`hello.greet`), a panel (`ui://hello/panel`) and three tools (`greet`, a read allowed
without asking; `save_note`, a write that asks; `check_status`, which fetches a status page),
plus a status item, a keybinding, a menu item, a `tool.post` hook and an event listener.
Everything it does is declared in `.nova-plugin/extension.json`. `check_status` fetches
`https://<host>/status` from its own code and may reach only the host the extension declared
(`api.example.com`): for any other host Nova refuses the request before it leaves the Hub, records
`extension.access.denied` in the audit log and turns the extension off.

```sh
nova validate .
nova pack . --unsigned       # or sign with your key: nova keys generate && nova pack .
NOVA_URL=https://hub.local:8443 NOVA_TOKEN=... nova dev .
```

`nova init <dir>` copies this folder as the template for a new extension.
