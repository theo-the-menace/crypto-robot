import unittest

from execution.scenario_simulator import ScenarioRejected, Wallets, scenario_five, scenario_four, scenario_one, scenario_three, scenario_two


class ScenarioTest(unittest.TestCase):
    def test_wallet_transfers_preserve_usdt(self):
        wallets = Wallets(spot_usdt=1000)
        scenario_one(wallets); self.assertEqual(wallets.usdm_usdt, 1000)
        scenario_two(wallets); self.assertEqual(wallets.coinm_usdt, 1000)
        scenario_four(wallets); self.assertEqual(wallets.spot_usdt, 1000)

    def test_spot_to_coinm_is_collateral_not_a_position(self):
        wallets = Wallets(spot_usdt=1000)
        scenario_three(wallets)
        self.assertEqual(wallets.coinm_usdt, 1000)
        self.assertEqual(wallets.open_coinm_btc, 0)

    def test_testnet_closes_position_before_full_collateral_return(self):
        wallets = Wallets(coinm_usdt=1000, open_coinm_btc=0.01)
        scenario_four(wallets)
        self.assertEqual(wallets.open_coinm_btc, 0)
        self.assertEqual(wallets.spot_usdt, 1000.01)

    def test_all_in_twenty_x_one_second_trigger_is_rejected(self):
        result = scenario_five(account_usdt=1000, leverage=20, price_jump=1000, window_seconds=1, confirmed=True)
        self.assertEqual(result["notionalUsdt"], 20000)
        self.assertEqual(result["order"], "COIN-M MARKET BUY draft")

    def test_unrestricted_scenario_is_not_available_in_live(self):
        with self.assertRaisesRegex(ScenarioRejected, "Testnet-only"):
            scenario_five(account_usdt=1000, leverage=20, price_jump=1000, window_seconds=1, confirmed=True, environment="live")


if __name__ == "__main__": unittest.main()
