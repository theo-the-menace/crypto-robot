"""Offline scenarios for Binance wallet routing and leverage guardrails."""

from __future__ import annotations

from dataclasses import dataclass, field


class ScenarioRejected(ValueError):
    pass


@dataclass
class Wallets:
    spot_usdt: float = 0.0
    usdm_usdt: float = 0.0
    coinm_usdt: float = 0.0
    coinm_btc: float = 0.0
    open_coinm_btc: float = 0.0


def transfer_usdt(wallets: Wallets, source: str, target: str) -> Wallets:
    """Simulate an internal USDT wallet transfer without calling Binance."""
    fields = {"spot": "spot_usdt", "usdm": "usdm_usdt", "coinm": "coinm_usdt"}
    if source not in fields or target not in fields or source == target:
        raise ScenarioRejected("Only distinct spot/usdm/coinm USDT wallet transfers are supported.")
    amount = getattr(wallets, fields[source])
    setattr(wallets, fields[source], 0.0)
    setattr(wallets, fields[target], getattr(wallets, fields[target]) + amount)
    return wallets


def scenario_one(wallets: Wallets) -> Wallets:
    return transfer_usdt(wallets, "spot", "usdm")


def scenario_two(wallets: Wallets) -> Wallets:
    # This is a collateral transfer, not a conversion into a COIN-M position.
    return transfer_usdt(wallets, "usdm", "coinm")


def scenario_three(wallets: Wallets) -> Wallets:
    return transfer_usdt(wallets, "spot", "coinm")


def scenario_four(wallets: Wallets) -> Wallets:
    # Testnet simulation: close the position, settle collateral, then transfer it.
    wallets.coinm_usdt += wallets.open_coinm_btc
    wallets.open_coinm_btc = 0.0
    return transfer_usdt(wallets, "coinm", "spot")


def scenario_five(*, account_usdt: float, leverage: int, price_jump: float, window_seconds: float, confirmed: bool = False, environment: str = "testnet") -> dict:
    """Return a Testnet-only order simulation; never creates a live Binance order."""
    if account_usdt <= 0:
        raise ScenarioRejected("Account balance must be positive.")
    if not confirmed:
        raise ScenarioRejected("Human confirmation is required for a strategy run.")
    if environment != "testnet":
        raise ScenarioRejected("This unrestricted scenario is Testnet-only.")
    if not isinstance(leverage, int) or leverage < 1 or leverage > 125:
        raise ScenarioRejected("Binance leverage must be an integer from 1x to 125x.")
    return {
        "dryRun": True, "environment": environment, "wouldUseUsdt": account_usdt,
        "leverage": leverage, "notionalUsdt": account_usdt * leverage,
        "priceJump": price_jump, "windowSeconds": window_seconds,
        "signal": "BTC 1s momentum trigger", "order": "COIN-M MARKET BUY draft",
    }
