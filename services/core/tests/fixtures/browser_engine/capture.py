"""Record what the pinned browser engine really answers (S38) — by hand, on purpose.

The tests read the engine's real words from v<tag>/<nn>-<step>.json
(tests/browser_engine.py) instead of a shape someone remembered: a fixture that
accepts what the product never sees proves nothing. So this is a helper you run
by hand and commit the output of, once per engine tag. If a test goes red
against a capture, the question is what the engine changed; re-running this to
make a test green again would delete the only evidence that anything did.

It drives a throwaway engine at http://127.0.0.1:18931/mcp: it probes the
2026-07-28 `server/discover` (recorded, whatever it says), then speaks the 2025
handshake and walks a small site (site/, served as http://site:8000) through
every engine tool her five tools use. Every raw response is written as JSON.
httpx only; nothing of app/ is imported.

v0.0.82 was captured on 2026-09-30, from the stock image by digest with its
profile and output folders bind-mounted. The steps below re-ran it on
2026-10-01 to the same answers, except two things that move between runs: the
refs' numbering (e4 in one run, f3e4 in another, so a test reads its refs from
the captured snapshot) and a favicon 404 that may or may not reach the first
page's `Console:` line before the answer does.

To capture a new tag: change FROM in deploy/browser/Dockerfile, then run this
from services/core, under bash (zsh does not word-split an arguments
variable). Every name starts with s38-, the only port is on loopback, and the
trap removes everything:

    bash <<'EOF'
    set -eu
    HERE=tests/fixtures/browser_engine
    trap 'docker rm -f s38-engine s38-site >/dev/null 2>&1;
          docker network rm s38-capture >/dev/null 2>&1;
          docker image rm s38-browser:capture >/dev/null 2>&1' EXIT
    docker build -q -t s38-browser:capture ../../deploy/browser >/dev/null
    docker network create s38-capture >/dev/null
    docker run -d --rm --name s38-site --network s38-capture --network-alias site \\
      -v "$PWD/$HERE/site:/site:ro" -w /site python:3.12-slim \\
      python -m http.server 8000 >/dev/null
    ENGINE=(--port 8931 --host 0.0.0.0 --allowed-hosts 127.0.0.1:18931 --no-webmcp
      --shared-browser-context --user-data-dir /profile --output-dir /output
      --image-responses omit --snapshot-mode none --file-paths absolute
      --timeout-navigation 45000 --console-level error)
    docker run -d --rm --init --name s38-engine --network s38-capture \\
      -p 127.0.0.1:18931:8931 s38-browser:capture "${ENGINE[@]}" >/dev/null
    sleep 6
    uv run python $HERE/capture.py $HERE/v<tag>
    EOF

Then point tests/browser_engine.py's GOLDEN at the new folder, run the browser
tests, and read every failure before changing a line of app/.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

import httpx

URL = "http://127.0.0.1:18931/mcp"
SITE = "http://site:8000"
BASE = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
CLIENT = {"name": "s38-capture", "version": "0"}


def messages(resp: httpx.Response) -> list:
    """The JSON-RPC messages in one answer: an event stream, or one body."""
    if resp.headers.get("content-type", "").startswith("text/event-stream"):
        found = []
        for block in resp.text.split("\n\n"):
            data = "\n".join(
                line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
            )
            if data.strip():
                found.append(json.loads(data))
        return found
    return [resp.json()] if resp.text.strip() else []


class Session:
    def __init__(self, client: httpx.Client, out: pathlib.Path) -> None:
        self.client = client
        self.out = out
        self.sid: str | None = None
        self.version: str | None = None
        self.next_id = 1
        self.n = 0

    def headers(self, extra: dict | None = None) -> dict:
        found = dict(BASE)
        if self.sid:
            found["Mcp-Session-Id"] = self.sid
        if self.version:
            found["MCP-Protocol-Version"] = self.version
        found.update(extra or {})
        return found

    def post(self, step: str, method: str, params: dict | None, *, headers: dict | None = None):
        body: dict = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        self.next_id += 1
        if params is not None:
            body["params"] = params
        resp = self.client.post(URL, json=body, headers=self.headers(headers), timeout=90)
        self.n += 1
        found = messages(resp)
        record = {
            "step": step,
            "request": body,
            "status": resp.status_code,
            "content_type": resp.headers.get("content-type", ""),
            "messages": found,
        }
        (self.out / f"{self.n:02d}-{step}.json").write_text(json.dumps(record, indent=2))
        return resp, found

    def call(self, step: str, tool: str, arguments: dict) -> str:
        _, found = self.post(step, "tools/call", {"name": tool, "arguments": arguments})
        return "\n".join(
            block["text"]
            for message in found
            for block in (message.get("result") or {}).get("content") or ()
            if block.get("type") == "text"
        )


def ref(snapshot: str, role: str, name: str) -> str:
    """The ref of a control in a snapshot. Refs carry a per-document prefix
    (f3e4), so never assume e<number>."""
    found = re.search(rf'{role} "{re.escape(name)}"[^\n]*?\[ref=([A-Za-z0-9]+)\]', snapshot)
    if not found:
        raise SystemExit(f"no {role} {name!r} in the snapshot:\n{snapshot[:3000]}")
    return found.group(1)


def main(out: pathlib.Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with httpx.Client() as client:
        s = Session(client, out)
        s.post(
            "discover-2026",
            "server/discover",
            {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": CLIENT,
                }
            },
            headers={"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover"},
        )
        resp, found = s.post(
            "initialize",
            "initialize",
            {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": CLIENT},
        )
        s.sid = resp.headers.get("mcp-session-id")
        s.version = (found[0].get("result") or {}).get("protocolVersion") if found else None
        client.post(
            URL,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers=s.headers(),
            timeout=30,
        )
        s.post("tools-list", "tools/list", {})
        s.call("navigate-index", "browser_navigate", {"url": f"{SITE}/index.html"})
        snap = s.call("snapshot-index", "browser_snapshot", {})
        page_two = ref(snap, "link", "Page two")
        s.call("click-link", "browser_click", {"target": page_two, "element": "Page two link"})
        s.call("back", "browser_navigate_back", {})
        snap = s.call("snapshot-after-back", "browser_snapshot", {})
        words = ref(snap, "textbox", "Search words")
        s.call("type", "browser_type", {"target": words, "text": "hello world"})
        pick = ref(snap, "combobox", "Pick one")
        s.call("select", "browser_select_option", {"target": pick, "values": ["b"]})
        report = ref(snap, "link", "Download the report")
        s.call("click-download", "browser_click", {"target": report})
        s.call("screenshot", "browser_take_screenshot", {"type": "png", "scale": "css"})
        s.call("click-alert", "browser_click", {"target": ref(snap, "button", "Show alert")})
        s.call("snapshot-during-dialog", "browser_snapshot", {})
        s.call("handle-dialog", "browser_handle_dialog", {"accept": True})
        s.call("click-stale-ref", "browser_click", {"target": "e9999"})
        s.call("press-key", "browser_press_key", {"key": "Tab"})
        submit = {"target": words, "text": "sent words", "submit": True}
        s.call("type-submit", "browser_type", submit)
        s.call("navigate-long", "browser_navigate", {"url": f"{SITE}/long.html"})
        s.call("snapshot-long", "browser_snapshot", {})
        s.call("navigate-404", "browser_navigate", {"url": f"{SITE}/missing.html"})
        dns = {"url": "http://no-such-host.invalid/"}
        s.call("navigate-dns-failure", "browser_navigate", dns)
        s.call("get-config", "browser_get_config", {})


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: capture.py <output folder, e.g. tests/fixtures/browser_engine/v0.0.83>"
        )
    main(pathlib.Path(sys.argv[1]))
