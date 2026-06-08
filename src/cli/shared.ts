import { IbkrClient } from "../ibkr/ibkrClient.js";
import { buildOauthConfig } from "../ibkr/oauthConfig.js";
import type { BrokerClient, BrokerName } from "../types.js";

/**
 * Resolve an authenticated {@link BrokerClient} for the requested broker.
 *
 * Today only IBKR is implemented. The `schwab` branch is intentionally a
 * placeholder: when this is merged into huskly-cli it will return a thin
 * adapter over huskly's existing `SchwabClient`, satisfying the same interface.
 */
export async function apiClient(broker: BrokerName = "ibkr"): Promise<BrokerClient> {
  switch (broker) {
    case "ibkr": {
      const client = new IbkrClient(buildOauthConfig());
      await client.init();
      return client;
    }
    case "schwab":
      throw new Error(
        "Broker 'schwab' is not supported yet. It will be wired up when this CLI is merged into huskly-cli."
      );
    default:
      throw new Error(`Unknown broker: ${String(broker)}`);
  }
}

/** Resolve the broker from a Commander option, validating the value. */
export function resolveBroker(value: string | undefined): BrokerName {
  const broker = (value ?? "ibkr").toLowerCase();
  if (broker !== "ibkr" && broker !== "schwab") {
    throw new Error(`Invalid --broker '${broker}'. Expected 'ibkr' or 'schwab'.`);
  }
  return broker;
}
