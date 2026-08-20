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

    def test_open_position_blocks_full_collateral_return(self):
        with self.assertRaisesRegex(ScenarioRejected, "Close"):
            scenario_four(Wallets(coinm_usdt=1000, open_coinm_btc=0.01))

    def test_all_in_twenty_x_one_second_trigger_is_rejected(self):
        with self.assertRaisesRegex(ScenarioRejected, "leverage|All-in"):
            scenario_five(account_usdt=1000, leverage=20, price_jump=1000, window_seconds=1, confirmed=True)


if __name__ == "__main__": unittest.main()
