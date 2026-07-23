import test from "node:test";
import assert from "node:assert/strict";
import { formatOsiOptionSymbol, parseOsiOptionSymbol } from "../src/ibkr/optionContract.js";

void test("OSI symbols preserve root padding, calendar expiry, right, and millistrike", () => {
  const symbol = formatOsiOptionSymbol({
    underlying: "MSTR",
    expiry: "2026-08-21",
    right: "C",
    strike: 215,
  });
  assert.equal(symbol, "MSTR  260821C00215000");
  assert.deepEqual(parseOsiOptionSymbol(symbol), {
    underlying: "MSTR",
    expiry: "2026-08-21",
    right: "C",
    strike: 215,
  });
});

void test("invalid OSI dates and oversized roots fail closed", () => {
  assert.throws(
    () =>
      formatOsiOptionSymbol({
        underlying: "TOO-LONG",
        expiry: "2026-08-21",
        right: "P",
        strike: 95,
      }),
    /1-6 characters/
  );
  assert.equal(parseOsiOptionSymbol("MSTR  260231C00215000"), null);
});
