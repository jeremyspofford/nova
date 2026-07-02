"""Browser-worker smoke test against a self-served static fixture page.

No external network: we serve a tiny HTML form from an in-process HTTP
server and drive it through the BrowserManager (open → snapshot → type →
click → snapshot). Requires Playwright + chromium installed.

Run: pytest browser-worker/tests/test_browser_smoke.py
"""

from __future__ import annotations

import asyncio
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

FIXTURE_HTML = b"""<!doctype html>
<html><body>
<h1>Signup</h1>
<form method="get" action="/done">
  <input name="email" placeholder="Email" type="text">
  <input name="password" placeholder="Password" type="password">
  <button type="submit">Create account</button>
</form>
</body></html>"""

DONE_HTML = b"<!doctype html><html><body><h1>Welcome</h1><p>Account created.</p></body></html>"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = DONE_HTML if self.path.startswith("/done") else FIXTURE_HTML
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def fixture_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("playwright") is None,
    reason="playwright not installed",
)
def test_form_fill_flow(fixture_server, tmp_path):
    from app.browser import BrowserManager

    async def _run():
        mgr = BrowserManager()
        # Isolate profiles under tmp_path
        from app import config
        config.settings.profiles_dir = str(tmp_path / "profiles")
        await mgr.start()
        try:
            sess = await mgr.open_session(fixture_server, "test-session")
            snap = await mgr.snapshot("test-session")
            elements = snap["elements"]
            assert any("email" in e.lower() for e in elements), elements

            def find_ref(needle):
                for i, e in enumerate(elements):
                    if needle.lower() in e.lower():
                        return i + 1
                raise AssertionError(f"{needle!r} not in {elements}")

            email_ref = find_ref("email")
            btn_ref = find_ref("Create account")

            await mgr.act("test-session", email_ref, "type", "nova@example.com")
            result = await mgr.act("test-session", btn_ref, "click")
            assert "done" in result["url"], result

            snap2 = await mgr.snapshot("test-session")
            assert "done" in snap2["url"] or "Welcome" in snap2["title"]
        finally:
            await mgr.stop()

    asyncio.run(_run())
