"""wol-helper — sends Wake-on-LAN magic packets from the HOST network namespace.

Containers on Docker's bridge network can't emit L2 broadcasts onto the LAN,
so llm-gateway delegates here (compose profile `wol`, network_mode: host).
Stdlib only — no dependencies to install.
"""
import json
import logging
import os
import re
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(level="INFO")
logger = logging.getLogger("wol-helper")

ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")
PORT = int(os.environ.get("WOL_HELPER_PORT", "8890"))


def build_magic_packet(mac: str) -> bytes:
    cleaned = re.sub(r"[:\-.]", "", mac.strip()).lower()
    if not re.fullmatch(r"[0-9a-f]{12}", cleaned):
        raise ValueError(f"Invalid MAC address: {mac!r}")
    return b"\xff" * 6 + bytes.fromhex(cleaned) * 16


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path in ("/health", "/health/ready", "/health/live"):
            self._reply(200, {"status": "ok", "service": "wol-helper"})
        else:
            self._reply(404, {"detail": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/wake":
            self._reply(404, {"detail": "not found"})
            return
        if not ADMIN_SECRET or self.headers.get("X-Admin-Secret") != ADMIN_SECRET:
            self._reply(401, {"detail": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            packet = build_magic_packet(body["mac"])
            broadcast = body.get("broadcast", "255.255.255.255")
            port = int(body.get("port", 9))
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            self._reply(422, {"detail": str(exc)})
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            for _ in range(3):
                sock.sendto(packet, (broadcast, port))
        finally:
            sock.close()
        logger.info("magic packet sent to %s:%s", broadcast, port)
        self._reply(200, {"sent": True, "broadcast": broadcast, "port": port})

    def log_message(self, *args):  # quiet the default per-request stderr noise
        pass


if __name__ == "__main__":
    logger.info("wol-helper listening on :%d (host network)", PORT)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
