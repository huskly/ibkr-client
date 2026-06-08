#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { handleAccount } from "./account.js";
import { handlePositions } from "./positions.js";
import { handleQuote } from "./quote.js";
import { handleOrders } from "./orders.js";
import { resolveBroker } from "./shared.js";

const program = new Command();

program
  .name("ibkr-cli")
  .description("Terminal-based trading tools for Interactive Brokers (and, later, Schwab)")
  .version("0.1.0")
  .option("--broker <name>", "Broker to use: ibkr or schwab", "ibkr");

/** The resolved broker from the global --broker option. */
const broker = (): ReturnType<typeof resolveBroker> =>
  resolveBroker(program.opts<{ broker?: string }>().broker);

program
  .command("account")
  .description("Show account balances and authentication status")
  .action(async () => {
    await handleAccount(broker());
  });

program
  .command("positions")
  .description("Show account positions, optionally filtered by symbol or type")
  .argument("[symbol]", "Optional symbol to filter positions")
  .option("-t, --type <type>", "Filter by asset type (e.g., OPTION, EQUITY)")
  .option("--csv", "Output in CSV format instead of table")
  .action(async (symbol: string | undefined, options: { type?: string; csv?: boolean }) => {
    await handlePositions(broker(), symbol, options);
  });

program
  .command("quote")
  .description("Get current price quotes for one or more symbols (not implemented yet)")
  .argument("<symbols...>", "Symbols to quote")
  .action((symbols: string[]) => {
    handleQuote(broker(), symbols);
  });

program
  .command("orders")
  .description("List account orders (not implemented yet)")
  .action(() => {
    handleOrders(broker());
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red("Error:"), message);
  process.exit(1);
});
