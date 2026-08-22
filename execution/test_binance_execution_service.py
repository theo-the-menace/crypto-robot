import json
import os
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import patch


TEMP = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
TEMP.close()
os.environ.update(BINANCE_EXECUTION_DB=TEMP.name, BINANCE_EXECUTION_MODE="live", BINANCE_ENV="live", BINANCE_API_KEY="key", BINANCE_SECRET_KEY="secret")

from execution import binance_execution_service as service


class FakeClient:
    def __init__(self): self.submits = 0
    def request(self, product, method, path, params, signed=False):
        self.submits += 1
        if self.submits == 1: raise urllib.error.URLError("response lost")
        return {"status": "NEW"}
    def query_order(self, product, symbol, client_order_id): return {"status": "FILLED", "clientOrderId": client_order_id}


class ExecutionTest(unittest.TestCase):
    def setUp(self):
        with service.database() as db:
            db.execute("DELETE FROM orders")
        self.client = FakeClient(); self.engine = service.ExecutionEngine(self.client)

    def test_timeout_is_reconciled_and_duplicate_is_not_resubmitted(self):
        body = {"clientOrderId": "robot-test-0001", "product": "spot", "order": {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET", "quoteOrderQty": "10"}}
        first, duplicate = self.engine.submit(body)
        self.assertFalse(duplicate); self.assertEqual(first["state"], "EXECUTION_UNKNOWN")
        reconciled = self.engine.reconcile("robot-test-0001")
        self.assertEqual(reconciled["state"], "FILLED")
        again, duplicate = self.engine.submit(body)
        self.assertTrue(duplicate); self.assertEqual(again["state"], "FILLED"); self.assertEqual(self.client.submits, 1)

    def test_rejects_order_over_limit_before_network(self):
        with self.assertRaisesRegex(service.BinanceError, "MAX_ORDER_USDT"):
            self.engine.submit({"clientOrderId": "robot-test-0002", "order": {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET", "quoteOrderQty": "101"}})
        self.assertEqual(self.client.submits, 0)

    def test_dashboard_reports_actual_state_without_credentials(self):
        dashboard = self.engine.dashboard()
        self.assertTrue(dashboard["service"]["healthy"])
        self.assertEqual(dashboard["strategies"], [])
        self.assertIn("maxOrderUsdt", dashboard["risk"])

    def test_remote_writes_are_local_only(self):
        self.assertIn('Write endpoints are local-only.', service.Handler.do_POST.__code__.co_consts)

    def test_market_files_are_confined_to_the_configured_directory(self):
        with tempfile.TemporaryDirectory() as root:
            market = Path(root) / "BTCUSD_PERP" / "1m"; market.mkdir(parents=True)
            (market / "manifest.json").write_text('{"months":[]}', encoding="utf-8")
            handler = object.__new__(service.Handler); handler.wfile = BytesIO(); responses = []
            handler.send_response = lambda status: responses.append(status); handler.send_header = lambda *_: None; handler.end_headers = lambda: None
            with patch.object(service, "MARKET_DATA_DIR", Path(root).resolve()): handler.market_file("BTCUSD_PERP/1m/manifest.json")
            self.assertEqual(responses, [200]); self.assertEqual(handler.wfile.getvalue(), b'{"months":[]}')


if __name__ == "__main__": unittest.main()
