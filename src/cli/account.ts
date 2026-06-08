import chalk from "chalk";
import { apiClient } from "./shared.js";
import { fmtMoney } from "../format.js";
import type { BrokerName } from "../types.js";

/**
 * Show auth status and account balances.
 * Ports the account-summary portion of main.py's main().
 */
export async function handleAccount(broker: BrokerName): Promise<void> {
  const api = await apiClient(broker);

  const auth = await api.getAuthStatus();
  const accountId = await api.getAccountId();
  const balances = await api.getAccountBalances();

  console.log(chalk.bold("\n💰 Account Summary\n"));
  console.log(
    chalk.gray("Authenticated: ") +
      (auth.authenticated ? chalk.green("yes") : chalk.red("no")) +
      chalk.gray("   Competing: ") +
      (auth.competing ? chalk.red("yes") : chalk.green("no"))
  );
  console.log(chalk.gray("Account:       ") + chalk.cyan(accountId));
  console.log(chalk.gray("─".repeat(50)));
  console.log(`Net Liquidation:  ${chalk.green(fmtMoney(balances.netLiquidation))}`);
  console.log(`Available Funds:  ${chalk.blue(fmtMoney(balances.availableFunds))}`);
  console.log(`Buying Power:     ${chalk.magenta(fmtMoney(balances.buyingPower))}`);
  console.log(`Cash Balance:     ${chalk.yellow(fmtMoney(balances.cashBalance))}`);
  console.log(chalk.gray("─".repeat(50)));
  console.log();
}
