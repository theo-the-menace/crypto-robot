#!/usr/bin/env python3
"""Expose only read-only execution state to a remote local frontend."""

from __future__ import annotations

import hmac
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.getenv("BINANCE_DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.getenv("BINANCE_DASHBOARD_PORT", "8890"))
PUBLIC_KEY = os.getenv("BINANCE_DASHBOARD_API_KEY", "")
INTERNAL_KEY = os.getenv("BINANCE_EXECUTION_API_KEY", "")
INTERNAL_BASE = os.getenv("BINANCE_EXECUTION_BASE_URL", "http://127.0.0.1:8888").rstrip("/")
ALLOWED_ORIGIN = os.getenv("BINANCE_DASHBOARD_ALLOWED_ORIGIN", "*")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, body: object) -> None:
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self) -> bool:
        return bool(PUBLIC_KEY) and hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {PUBLIC_KEY}")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path not in ("/health", "/v1/dashboard") and not self.path.startswith("/v1/orders/"):
            return self.send_json(404, {"error": "Read-only dashboard endpoint not found."})
        if not self.authorized():
            return self.send_json(401, {"error": "Unauthorized"})
        request = urllib.request.Request(f"{INTERNAL_BASE}{self.path}", headers={"Authorization": f"Bearer {INTERNAL_KEY}"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                body = json.loads(response.read() or b"{}")
                self.send_json(response.status, body)
        except urllib.error.HTTPError as error:
            try: body = json.loads(error.read() or b"{}")
            except Exception: body = {"error": "Execution service request failed."}
            self.send_json(error.code, body)
        except (urllib.error.URLError, TimeoutError, OSError):
            self.send_json(503, {"error": "Execution service unavailable."})

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    if not PUBLIC_KEY or not INTERNAL_KEY:
        raise SystemExit("BINANCE_DASHBOARD_API_KEY and BINANCE_EXECUTION_API_KEY are required.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
