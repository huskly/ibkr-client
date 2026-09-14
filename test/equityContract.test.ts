import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEquityContract, type EquityContract } from "../src/index.js";

const exact = {
  conid: 320227571,
  assetClass: "STK",
  symbol: "IBIT",
  exchange: "SMART",
  primaryExchange: "NASDAQ",
  currency: "USD",
} as const;

void test("normalizes one exact US equity contract", () => {
  const contract: EquityContract | null = normalizeEquityContract(exact);
  assert.deepEqual(contract, exact);
  assert.notEqual(contract, exact);
  assert.ok(Object.isFrozen(contract));
});

void test("normalizes text identity to uppercase without guessing missing fields", () => {
  assert.deepEqual(
    normalizeEquityContract({
      ...exact,
      symbol: " ibit ",
      exchange: " smart ",
      primaryExchange: " nasdaq ",
      currency: " usd ",
    }),
    exact
  );
});

void test("rejects malformed, non-US, and derivative-shaped identities", () => {
  const invalid: unknown[] = [
    null,
    {},
    { ...exact, conid: 0 },
    { ...exact, conid: 1.5 },
    { ...exact, conid: Number.POSITIVE_INFINITY },
    { ...exact, assetClass: "OPT" },
    { ...exact, symbol: "" },
    { ...exact, symbol: "IBIT\n" },
    { ...exact, exchange: "NASDAQ" },
    { ...exact, primaryExchange: "" },
    { ...exact, currency: "CAD" },
    { ...exact, expiration: "2026-10-02" },
  ];
  for (const value of invalid) assert.equal(normalizeEquityContract(value), null);
});
