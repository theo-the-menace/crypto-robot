#!/usr/bin/env python3
"""Persistent, idempotent Binance execution service."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = os.getenv("BINANCE_EXECUTION_HOST", "127.0.0.1")
PORT = int(os.getenv("BINANCE_EXECUTION_PORT", "8888"))
DB_PATH = Path(os.getenv("BINANCE_EXECUTION_DB", "/var/lib/binance-execution/orders.sqlite"))
SERVICE_KEY = os.getenv("BINANCE_EXECUTION_API_KEY", "")
DASHBOARD_KEY = os.getenv("BINANCE_DASHBOARD_API_KEY", "")
API_KEY = os.getenv("BINANCE_API_KEY", "")
SECRET_KEY = os.getenv("BINANCE_SECRET_KEY", "")
ENVIRONMENT = os.getenv("BINANCE_ENV", "testnet")
MODE = os.getenv("BINANCE_EXECUTION_MODE", "disabled")
ALLOWED_SYMBOLS = {value.strip().upper() for value in os.getenv("BINANCE_SYMBOLS", "BTCUSDT,ETHUSDT").split(",") if value.strip()}
MAX_ORDER_USDT = float(os.getenv("MAX_ORDER_USDT", "100"))
RECV_WINDOW = int(os.getenv("BINANCE_RECV_WINDOW", "5000"))
TIMEOUT = float(os.getenv("BINANCE_REQUEST_TIMEOUT", "8"))
RECONCILE_INTERVAL = float(os.getenv("BINANCE_RECONCILE_INTERVAL", "5"))
CLIENT_ID = re.compile(r"^[A-Za-z0-9._:-]{8,36}$")
PRODUCTS = {
    "spot": {
        "live": "https://api.binance.com", "testnet": "https://testnet.binance.vision",
        "time": "/api/v3/time", "order": "/api/v3/order", "test": "/api/v3/order/test", "account": "/api/v3/account",
    },
    "usdm": {
        "live": "https://fapi.binance.com", "testnet": "https://testnet.binancefuture.com",
        "time": "/fapi/v1/time", "order": "/fapi/v1/order", "test": "/fapi/v1/order/test", "account": "/fapi/v3/account",
    },
    "margin": {
        "live": "https://api.binance.com", "testnet": "https://testnet.binance.vision",
        "time": "/api/v3/time", "order": "/sapi/v1/margin/order", "test": None, "account": "/sapi/v1/margin/account",
    },
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class BinanceError(RuntimeError):
    def __init__(self, message: str, status: int = 502, code: int | None = None):
        super().__init__(message)
        self.status, self.code = status, code


def database() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS orders (
        client_order_id TEXT PRIMARY KEY, product TEXT NOT NULL, symbol TEXT NOT NULL,
        state TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        symbol TEXT NOT NULL, updated_at INTEGER NOT NULL
    )""")
    return db


def public_order(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    value = dict(row)
    value["request"] = json.loads(value.pop("request_json"))
    value["response"] = json.loads(value.pop("response_json")) if value["response_json"] else None
    return value


class BinanceClient:
    def __init__(self, opener=urllib.request.urlopen, now=lambda: int(time.time() * 1000)):
        self.opener, self.now = opener, now
        self.offsets: dict[str, int] = {}

    def request(self, product: str, method: str, path: str, params: dict[str, Any], signed: bool = False) -> Any:
        spec = PRODUCTS[product]
        if ENVIRONMENT not in ("testnet", "live"):
            raise BinanceError("BINANCE_ENV must be testnet or live.", 500)
        if signed and (not API_KEY or not SECRET_KEY):
            raise BinanceError("Binance credentials are not configured.", 503)
        values = {key: value for key, value in params.items() if value is not None and value != ""}
        if signed:
            if product not in self.offsets:
                server = self.request(product, "GET", spec["time"], {})
                self.offsets[product] = int(server["serverTime"]) - self.now()
            values.update(timestamp=self.now() + self.offsets[product], recvWindow=RECV_WINDOW)
        query = urllib.parse.urlencode(values)
        if signed:
            query += "&signature=" + hmac.new(SECRET_KEY.encode(), query.encode(), hashlib.sha256).hexdigest()
        request = urllib.request.Request(
            f"{spec[ENVIRONMENT]}{path}{'?' + query if query else ''}", method=method,
            headers={"X-MBX-APIKEY": API_KEY, "User-Agent": "crypto-robot-execution/1"} if signed else {"User-Agent": "crypto-robot-execution/1"},
        )
        try:
            with self.opener(request, timeout=TIMEOUT) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            try: body = json.loads(error.read())
            except Exception: body = {}
            raise BinanceError(body.get("msg", f"Binance returned HTTP {error.code}."), error.code, body.get("code")) from error

    def public(self, product: str, path: str, params: dict[str, Any]) -> Any:
        last_error: Exception | None = None
        for delay in (0, 0.2, 0.8):
            if delay: time.sleep(delay)
            try: return self.request(product, "GET", path, params)
            except (urllib.error.URLError, TimeoutError, OSError, BinanceError) as error: last_error = error
        raise last_error or BinanceError("Binance request failed.")

    def query_order(self, product: str, symbol: str, client_order_id: str) -> Any:
        key = "origClientOrderId" if product != "margin" else "origClientOrderId"
        return self.request(product, "GET", PRODUCTS[product]["order"], {"symbol": symbol, key: client_order_id}, True)


class ExecutionEngine:
    def __init__(self, client: BinanceClient | None = None):
        self.client = client or BinanceClient()
        self.lock = threading.Lock()
        database().close()

    def get(self, client_order_id: str) -> dict[str, Any] | None:
        with database() as db:
            return public_order(db.execute("SELECT * FROM orders WHERE client_order_id=?", (client_order_id,)).fetchone())

    def dashboard(self) -> dict[str, Any]:
        with database() as db:
            states = {row["state"]: row["count"] for row in db.execute("SELECT state, COUNT(*) AS count FROM orders GROUP BY state")}
            strategies = [dict(row) for row in db.execute("SELECT id, name, status, symbol, updated_at FROM strategies ORDER BY updated_at DESC")]
            recent_orders = [public_order(row) for row in db.execute("SELECT * FROM orders ORDER BY updated_at DESC LIMIT 20")]
        return {
            "service": {"environment": ENVIRONMENT, "mode": MODE, "healthy": True},
            "risk": {"allowedSymbols": sorted(ALLOWED_SYMBOLS), "maxOrderUsdt": MAX_ORDER_USDT, "recvWindowMs": RECV_WINDOW},
            "orders": {"byState": states, "unknown": states.get("EXECUTION_UNKNOWN", 0)},
            "strategies": strategies,
            "recentOrders": recent_orders,
        }

    def update(self, client_order_id: str, state: str, response: Any = None, error: str | None = None) -> dict[str, Any]:
        with database() as db:
            db.execute("UPDATE orders SET state=?, response_json=?, error=?, updated_at=? WHERE client_order_id=?",
                       (state, json.dumps(response, separators=(",", ":")) if response is not None else None, error, int(time.time() * 1000), client_order_id))
        return self.get(client_order_id) or {}

    def validate(self, body: dict[str, Any]) -> tuple[str, str, str, dict[str, Any]]:
        product = str(body.get("product", "spot")).lower()
        order = dict(body.get("order") or {})
        symbol = str(order.get("symbol", "")).upper()
        client_order_id = str(body.get("clientOrderId", ""))
        if product not in PRODUCTS: raise BinanceError("product must be spot, usdm, or margin.", 400)
        if not CLIENT_ID.fullmatch(client_order_id): raise BinanceError("clientOrderId must be 8-36 safe characters.", 400)
        if not symbol or ("*" not in ALLOWED_SYMBOLS and symbol not in ALLOWED_SYMBOLS): raise BinanceError("Symbol is not allowed.", 403)
        if order.get("side") not in ("BUY", "SELL") or order.get("type") not in ("MARKET", "LIMIT"): raise BinanceError("Only BUY/SELL MARKET/LIMIT orders are allowed.", 400)
        if order.get("type") == "LIMIT" and (not order.get("price") or not order.get("quantity") or not order.get("timeInForce")): raise BinanceError("LIMIT orders require price, quantity, and timeInForce.", 400)
        notional = float(order.get("quoteOrderQty") or 0) or float(order.get("quantity") or 0) * float(order.get("price") or 0)
        if MAX_ORDER_USDT > 0 and notional > MAX_ORDER_USDT: raise BinanceError("Order exceeds MAX_ORDER_USDT.", 403)
        order["symbol"] = symbol
        order["newClientOrderId"] = client_order_id
        return product, symbol, client_order_id, order

    def submit(self, body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        product, symbol, client_order_id, order = self.validate(body)
        with self.lock:
            existing = self.get(client_order_id)
            if existing: return existing, True
            now = int(time.time() * 1000)
            with database() as db:
                db.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)", (client_order_id, product, symbol, "VALIDATED", json.dumps(order, separators=(",", ":")), None, None, now, now))
            if MODE == "disabled": return self.update(client_order_id, "BLOCKED", error="Execution mode is disabled."), False
            if MODE == "live" and ENVIRONMENT != "live": return self.update(client_order_id, "BLOCKED", error="Live mode requires BINANCE_ENV=live."), False
            if MODE == "test" and not PRODUCTS[product]["test"]: return self.update(client_order_id, "BLOCKED", error=f"{product} has no safe test-order endpoint."), False
            self.update(client_order_id, "SUBMITTING")
            path = PRODUCTS[product]["order"] if MODE == "live" else PRODUCTS[product]["test"]
            try:
                response = self.client.request(product, "POST", path, order, True)
                state = response.get("status", "TESTED" if MODE == "test" else "ACKNOWLEDGED")
                return self.update(client_order_id, state, response=response), False
            except BinanceError as error:
                return self.update(client_order_id, "REJECTED", error=str(error)), False
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                return self.update(client_order_id, "EXECUTION_UNKNOWN", error=type(error).__name__), False

    def reconcile(self, client_order_id: str) -> dict[str, Any]:
        order = self.get(client_order_id)
        if not order: raise BinanceError("Order not found.", 404)
        if MODE != "live" or order["state"] not in ("SUBMITTING", "EXECUTION_UNKNOWN"): return order
        try:
            response = self.client.query_order(order["product"], order["symbol"], client_order_id)
            return self.update(client_order_id, response.get("status", "ACKNOWLEDGED"), response=response)
        except BinanceError as error:
            if error.code == -2013: return self.update(client_order_id, "NOT_FOUND", error=str(error))
            return self.update(client_order_id, "EXECUTION_UNKNOWN", error=str(error))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return self.update(client_order_id, "EXECUTION_UNKNOWN", error=type(error).__name__)


ENGINE = ExecutionEngine()

DASHBOARD_HTML = """<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Crypto Robot</title><style>body{max-width:980px;margin:32px auto;padding:0 16px;font:14px system-ui;color:#1d232b;background:#f6f7f8}h1{margin:0}.sub{color:#68717c}.token{display:flex;gap:8px;margin:20px 0}.token input{flex:1;padding:10px}.token button{padding:10px 14px;background:#20262d;color:white;border:0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{padding:16px;border:1px solid #dde2e6;background:#fff}.label{font-size:11px;color:#68717c;text-transform:uppercase}.value{font-size:21px;font-weight:700;margin-top:8px}section{margin-top:12px;padding:16px;border:1px solid #dde2e6;background:#fff}table{width:100%;border-collapse:collapse}td,th{padding:9px 4px;border-bottom:1px solid #edf0f2;text-align:left}th{font-size:11px;color:#68717c}.empty{color:#68717c;padding:10px 0}@media(max-width:640px){.grid{grid-template-columns:1fr}}</style><main><h1>Crypto Robot</h1><p class=sub>Read-only execution console</p><div class=token><input id=token type=password placeholder=\"Management access token\"><button onclick=load()>Connect</button></div><div id=app hidden><div class=grid><div class=card><div class=label>Environment</div><div id=environment class=value></div></div><div class=card><div class=label>Execution mode</div><div id=mode class=value></div></div><div class=card><div class=label>Unknown orders</div><div id=unknown class=value></div></div></div><section><div class=label>Risk limits</div><p id=risk></p></section><section><div class=label>Running strategies</div><div id=strategies></div></section><section><div class=label>Recent orders</div><div id=orders></div></section></div></main><script>function tab(rows,cols){return rows.length?'<table><tr>'+cols.map(c=>'<th>'+c[1]+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+String(r[c[0]]??'')+'</td>').join('')+'</tr>').join('')+'</table>':'<div class=empty>None</div>'}async function load(){let r=await fetch('/v1/dashboard',{headers:{Authorization:'Bearer '+token.value}});if(!r.ok)return alert('Access denied');let d=await r.json();environment.textContent=d.service.environment;mode.textContent=d.service.mode;unknown.textContent=d.orders.unknown;risk.textContent=d.risk.allowedSymbols.join(', ')+' · max '+d.risk.maxOrderUsdt+' USDT/order · recvWindow '+d.risk.recvWindowMs+' ms';strategies.innerHTML=tab(d.strategies,[['name','Strategy'],['symbol','Symbol'],['status','Status']]);orders.innerHTML=tab(d.recentOrders,[['client_order_id','Client order ID'],['product','Product'],['symbol','Symbol'],['state','State']]);app.hidden=false}setInterval(()=>{if(!app.hidden)load()},5000)</script>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "BinanceExecution/1"

    def json(self, status: int, body: Any) -> None:
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store"); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type"); self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS"); self.end_headers()

    def authorized(self) -> bool:
        return bool(SERVICE_KEY) and hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {SERVICE_KEY}")

    def dashboard_authorized(self) -> bool:
        token = self.headers.get("Authorization", "")
        return bool(DASHBOARD_KEY) and hmac.compare_digest(token, f"Bearer {DASHBOARD_KEY}")

    def body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 100_000: raise BinanceError("Request body is too large.", 413)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            raw = DASHBOARD_HTML.encode()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); return self.wfile.write(raw)
        if parsed.path == "/health": return self.json(200, {"ok": True, "environment": ENVIRONMENT, "mode": MODE})
        if parsed.path in ("/v1/dashboard", "/v1/market/klines") or parsed.path.startswith("/v1/orders/"):
            if not (self.dashboard_authorized() or self.authorized()): return self.json(401, {"error": "Unauthorized"})
        elif not self.authorized(): return self.json(401, {"error": "Unauthorized"})
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/v1/dashboard": return self.json(200, ENGINE.dashboard())
            if parsed.path == "/v1/market/klines":
                symbol = query.get("symbol", ["BTCUSD_PERP"])[0].upper()
                interval = query.get("interval", ["5m"])[0]
                limit = min(1000, max(10, int(query.get("limit", ["300"])[0])))
                if symbol not in ("BTCUSD_PERP", "BTCUSDT"):
                    raise BinanceError("Only BTCUSD_PERP and BTCUSDT are available.", 400)
                if interval not in ("1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"):
                    raise BinanceError("Interval is not allowed.", 400)
                product = "spot" if symbol == "BTCUSDT" else "usdm"
                path = "/api/v3/klines" if product == "spot" else "/fapi/v1/klines"
                params = {"symbol": symbol, "interval": interval, "limit": limit}
                if "endTime" in query: params["endTime"] = int(query["endTime"][0])
                return self.json(200, {"symbol": symbol, "interval": interval, "klines": ENGINE.client.public(product, path, params)})
            if parsed.path == "/v1/binance/ping": return self.json(200, ENGINE.client.public("spot", "/api/v3/ping", {}))
            if parsed.path == "/v1/binance/ticker": return self.json(200, ENGINE.client.public("spot", "/api/v3/ticker/bookTicker", {"symbol": query.get("symbol", [""])[0].upper()}))
            if parsed.path == "/v1/binance/account":
                product = query.get("product", ["spot"])[0]
                if product not in PRODUCTS: raise BinanceError("Unknown product.", 400)
                return self.json(200, ENGINE.client.request(product, "GET", PRODUCTS[product]["account"], {}, True))
            if parsed.path.startswith("/v1/orders/"):
                order = ENGINE.get(parsed.path.rsplit("/", 1)[-1])
                return self.json(200 if order else 404, order or {"error": "Order not found."})
            return self.json(404, {"error": "Not found"})
        except BinanceError as error: return self.json(error.status, {"error": str(error), "code": error.code})
        except Exception as error: logging.exception("request failed"); return self.json(502, {"error": type(error).__name__})

    def do_POST(self) -> None:
        if self.client_address[0] not in ("127.0.0.1", "::1") or not self.authorized():
            return self.json(403, {"error": "Write endpoints are local-only."})
        try:
            if self.path == "/v1/orders":
                order, duplicate = ENGINE.submit(self.body())
                return self.json(200 if duplicate else 201, {"duplicate": duplicate, "order": order})
            if self.path.startswith("/v1/orders/") and self.path.endswith("/reconcile"):
                return self.json(200, ENGINE.reconcile(self.path.split("/")[-2]))
            return self.json(404, {"error": "Not found"})
        except BinanceError as error: return self.json(error.status, {"error": str(error), "code": error.code})
        except (ValueError, json.JSONDecodeError) as error: return self.json(400, {"error": str(error)})
        except Exception as error: logging.exception("request failed"); return self.json(500, {"error": type(error).__name__})

    def log_message(self, pattern: str, *args: Any) -> None:
        logging.info("%s %s", self.address_string(), pattern % args)


def reconcile_loop() -> None:
    while True:
        time.sleep(RECONCILE_INTERVAL)
        try:
            with database() as db:
                ids = [row[0] for row in db.execute("SELECT client_order_id FROM orders WHERE state IN ('SUBMITTING','EXECUTION_UNKNOWN') LIMIT 100")]
            for client_order_id in ids: ENGINE.reconcile(client_order_id)
        except Exception: logging.exception("background reconciliation failed")


def main() -> None:
    if not SERVICE_KEY: raise SystemExit("BINANCE_EXECUTION_API_KEY is required.")
    threading.Thread(target=reconcile_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    logging.info("Binance execution service listening on %s:%s (%s/%s)", HOST, PORT, ENVIRONMENT, MODE)
    server.serve_forever()


if __name__ == "__main__": main()
