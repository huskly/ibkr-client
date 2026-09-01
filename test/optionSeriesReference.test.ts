import test from "node:test";
import assert from "node:assert/strict";
import { IbkrBrokerResponseError, IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

interface RequestInput {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}

const config: IbkrOauth1Config = {
  accessTokenSecret: "test",
  accessToken: "test",
  consumerKey: "test",
  encryption: "test",
  signature: "test",
  dhPrime: "test",
  realm: "test",
};

const PINNED_NOW = 1_754_000_000_000;

class FakeIbkrClient extends IbkrClient {
  readonly calls: RequestInput[] = [];

  constructor(private readonly responder: (input: RequestInput) => unknown) {
    super(config);
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }

  protected override now(): number {
    return PINNED_NOW;
  }
}

function clientForContracts(records: Readonly<Record<number, unknown>>): FakeIbkrClient {
  return new FakeIbkrClient((input) => {
    for (const [conid, record] of Object.entries(records)) {
      if (input.path === `iserver/contract/${conid}/info`) return record;
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
}

/** Live capture: SPY 04SEP26 P716, a standard ETF series (`probe-SPY-full.txt`). */
const SPY_OPTION = {
  cfi_code: "OPXXXS",
  symbol: "SPY",
  cusip: null,
  expiry_full: "20260904",
  con_id: 904834942,
  maturity_date: "20260904",
  instrument_type: "OPT",
  has_related_contracts: true,
  trading_class: "SPY",
  valid_exchanges: "SMART,AMEX,CBOE,PHLX,PSE,ISE,BOX,BATS,NASDAQOM",
  allow_sell_long: false,
  is_zero_commission_security: false,
  local_symbol: "SPY   260904P00716000",
  contract_clarification_type: null,
  classifier: null,
  currency: "USD",
  text: "SEP 04 '26 716 Put",
  underlying_con_id: 756733,
  r_t_h: false,
  multiplier: "100",
  strike: "716.0",
  right: "PUT",
  underlying_issuer: null,
  contract_month: "202609",
  company_name: "SS SPDR S&P 500 ETF TRUST-US",
  smart_available: true,
  exchange: "SMART",
};

/** Live capture: the SPY underlying (`probe-SPY-full.txt`). */
const SPY_UNDERLYING = {
  cfi_code: "",
  symbol: "SPY",
  cusip: null,
  expiry_full: null,
  con_id: 756733,
  maturity_date: null,
  instrument_type: "STK",
  has_related_contracts: true,
  trading_class: "SPY",
  valid_exchanges: "SMART,AMEX,NYSE,CBOE,ARCA,NASDAQ",
  allow_sell_long: false,
  is_zero_commission_security: false,
  local_symbol: "SPY",
  contract_clarification_type: null,
  classifier: null,
  currency: "USD",
  text: null,
  underlying_con_id: 0,
  r_t_h: true,
  multiplier: null,
  underlying_issuer: null,
  contract_month: null,
  company_name: "SS SPDR S&P 500 ETF TRUST-US",
  smart_available: true,
  exchange: "SMART",
};

/** Live capture: TLRY1 15JAN27 P3, a KNOWN ADJUSTED series (`probe-adjusted.txt`). */
const TLRY1_OPTION = {
  cfi_code: "OPXXXS",
  symbol: "TLRY1",
  cusip: null,
  expiry_full: "20270115",
  con_id: 728962155,
  maturity_date: "20270115",
  instrument_type: "OPT",
  has_related_contracts: true,
  trading_class: "TLRY1",
  valid_exchanges: "SMART,AMEX,CBOE,PHLX,PSE,ISE,BOX,BATS,NASDAQOM",
  allow_sell_long: false,
  is_zero_commission_security: false,
  local_symbol: "TLRY1 270115P00003000",
  contract_clarification_type: null,
  classifier: null,
  currency: "USD",
  text: "JAN 15 '27 3 Put",
  underlying_con_id: 835871298,
  r_t_h: false,
  multiplier: "100",
  strike: "3.0",
  right: "PUT",
  underlying_issuer: null,
  contract_month: "202701",
  company_name: "TLRY: TILRAY BRANDS INC: ADJ 20251201",
  smart_available: true,
  exchange: "SMART",
};

/** Live capture: the TLRY1 basket pseudo-underlying (`probe-adjusted.txt`). */
const TLRY1_UNDERLYING = {
  cfi_code: "",
  symbol: "TLRY1",
  underlying_con_id: 0,
  cusip: null,
  r_t_h: false,
  expiry_full: null,
  multiplier: null,
  con_id: 835871298,
  maturity_date: null,
  instrument_type: "STK",
  underlying_issuer: null,
  has_related_contracts: false,
  trading_class: "TLRY1",
  valid_exchanges: "BASKET",
  allow_sell_long: false,
  is_zero_commission_security: false,
  local_symbol: "TLRY1",
  contract_clarification_type: null,
  contract_month: null,
  company_name: "TLRY: TILRAY BRANDS INC: ADJ 20251201",
  classifier: null,
  exchange: "BASKET",
  currency: "USD",
  text: null,
};

/** Live capture: the SPX index underlying (`probe-final.txt`). */
const SPX_UNDERLYING = {
  cfi_code: "",
  symbol: "SPX",
  con_id: 416904,
  instrument_type: "IND",
  trading_class: null,
  valid_exchanges: "CBOE",
  local_symbol: "SPX",
  underlying_con_id: 0,
  multiplier: null,
  currency: "USD",
  company_name: "S&P 500 Stock Index",
  exchange: "CBOE",
  text: null,
};

void test("an exact option conid states every reference fact IBKR gave", async () => {
  const client = clientForContracts({ 904834942: SPY_OPTION });

  assert.deepEqual(await client.getOptionSeriesReference(904834942), {
    requestedConid: 904834942,
    observedAtEpochMillis: PINNED_NOW,
    conid: 904834942,
    symbol: "SPY",
    localSymbol: "SPY   260904P00716000",
    instrumentType: "OPT",
    tradingClass: "SPY",
    underlyingConid: 756733,
    multiplier: 100,
    multiplierRaw: "100",
    companyName: "SS SPDR S&P 500 ETF TRUST-US",
    currency: "USD",
    exchange: "SMART",
    listingExchange: null,
    validExchanges: "SMART,AMEX,CBOE,PHLX,PSE,ISE,BOX,BATS,NASDAQOM",
    cfiCode: "OPXXXS",
    contractClarificationType: null,
    classifier: null,
    underlyingIssuer: null,
    description: "SEP 04 '26 716 Put",
    right: "PUT",
    strike: 716,
    strikeRaw: "716.0",
    maturityDate: "20260904",
    expiryFull: "20260904",
    contractMonth: "202609",
    presentFieldNames: [
      "allow_sell_long",
      "cfi_code",
      "classifier",
      "company_name",
      "con_id",
      "contract_clarification_type",
      "contract_month",
      "currency",
      "cusip",
      "exchange",
      "expiry_full",
      "has_related_contracts",
      "instrument_type",
      "is_zero_commission_security",
      "local_symbol",
      "maturity_date",
      "multiplier",
      "r_t_h",
      "right",
      "smart_available",
      "strike",
      "symbol",
      "text",
      "trading_class",
      "underlying_con_id",
      "underlying_issuer",
      "valid_exchanges",
    ],
  });
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["iserver/contract/904834942/info"]
  );
});

void test("an option read uses contract/info, which secdef/info cannot replace", async () => {
  const client = clientForContracts({ 904834942: SPY_OPTION });

  const evidence = await client.getOptionSeriesReference(904834942);

  // The conid-only `iserver/secdef/info` re-read states neither of these two.
  assert.equal(evidence.multiplierRaw, "100");
  assert.equal(evidence.tradingClass, "SPY");
});

void test("a known adjusted series reports the same terms as a standard one", async () => {
  const client = clientForContracts({ 728962155: TLRY1_OPTION, 904834942: SPY_OPTION });

  const adjusted = await client.getOptionSeriesReference(728962155);
  const standard = await client.getOptionSeriesReference(904834942);

  // This package states facts only. Nothing here separates the two series.
  assert.equal(adjusted.multiplierRaw, standard.multiplierRaw);
  assert.equal(adjusted.cfiCode, standard.cfiCode);
  assert.equal(adjusted.instrumentType, standard.instrumentType);
  assert.equal(adjusted.contractClarificationType, null);
  assert.equal(adjusted.classifier, null);
  assert.equal(adjusted.underlyingIssuer, null);
  // Only the free-text name and the OSI root differ, and both are prose.
  assert.equal(adjusted.companyName, "TLRY: TILRAY BRANDS INC: ADJ 20251201");
  assert.equal(adjusted.localSymbol, "TLRY1 270115P00003000");
  assert.equal(adjusted.tradingClass, "TLRY1");
  assert.equal(adjusted.strike, 3);
  assert.equal(adjusted.underlyingConid, 835871298);
});

void test("an underlying read states the instrument type and the venue", async () => {
  const client = clientForContracts({ 756733: SPY_UNDERLYING });

  const evidence = await client.getUnderlyingInstrumentReference(756733);

  assert.equal(evidence.instrumentType, "STK");
  assert.equal(evidence.exchange, "SMART");
  assert.equal(evidence.validExchanges, "SMART,AMEX,NYSE,CBOE,ARCA,NASDAQ");
  assert.equal(evidence.symbol, "SPY");
  assert.equal(evidence.localSymbol, "SPY");
  assert.equal(evidence.companyName, "SS SPDR S&P 500 ETF TRUST-US");
  assert.equal(evidence.currency, "USD");
  assert.equal(evidence.requestedConid, 756733);
  assert.equal(evidence.conid, 756733);
  assert.equal(evidence.observedAtEpochMillis, PINNED_NOW);
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["iserver/contract/756733/info"]
  );
});

void test("an index underlying reads IND, so the consumer can split it from STK", async () => {
  const client = clientForContracts({ 416904: SPX_UNDERLYING });

  const evidence = await client.getUnderlyingInstrumentReference(416904);

  assert.equal(evidence.instrumentType, "IND");
  assert.equal(evidence.exchange, "CBOE");
  assert.equal(evidence.tradingClass, null);
});

void test("an adjusted pseudo-underlying reads its BASKET venue verbatim", async () => {
  const client = clientForContracts({ 835871298: TLRY1_UNDERLYING });

  const evidence = await client.getUnderlyingInstrumentReference(835871298);

  assert.equal(evidence.exchange, "BASKET");
  assert.equal(evidence.validExchanges, "BASKET");
  // It still calls itself a stock, so the venue is the only signal, not a verdict.
  assert.equal(evidence.instrumentType, "STK");
  assert.equal(evidence.companyName, "TLRY: TILRAY BRANDS INC: ADJ 20251201");
  assert.equal(evidence.multiplier, null);
  assert.equal(evidence.multiplierRaw, null);
  assert.equal(evidence.cfiCode, null);
});

void test("a stated underlying_con_id of zero stays zero and never reads null", async () => {
  const client = clientForContracts({ 756733: SPY_UNDERLYING });

  assert.equal((await client.getUnderlyingInstrumentReference(756733)).underlyingConid, 0);
});

void test("a missing field reads null and never makes the read throw", async () => {
  const client = clientForContracts({ 904834942: { con_id: 904834942, instrument_type: "OPT" } });

  const evidence = await client.getOptionSeriesReference(904834942);

  assert.equal(evidence.conid, 904834942);
  assert.equal(evidence.instrumentType, "OPT");
  assert.equal(evidence.multiplier, null);
  assert.equal(evidence.multiplierRaw, null);
  assert.equal(evidence.tradingClass, null);
  assert.equal(evidence.localSymbol, null);
  assert.equal(evidence.underlyingConid, null);
  assert.equal(evidence.currency, null);
  assert.equal(evidence.strike, null);
  assert.equal(evidence.right, null);
  assert.deepEqual(evidence.presentFieldNames, ["con_id", "instrument_type"]);
});

void test("a wrong-typed field reads null instead of a guessed value", async () => {
  const client = clientForContracts({
    904834942: {
      con_id: "904834942",
      symbol: 42,
      local_symbol: "   ",
      multiplier: 100,
      strike: 716,
      right: ["PUT"],
      trading_class: null,
      underlying_con_id: "756733",
      currency: false,
      valid_exchanges: 7,
    },
  });

  const evidence = await client.getOptionSeriesReference(904834942);

  assert.equal(evidence.conid, 904834942);
  assert.equal(evidence.symbol, null);
  assert.equal(evidence.localSymbol, null);
  assert.equal(evidence.multiplier, 100);
  assert.equal(evidence.multiplierRaw, null);
  assert.equal(evidence.strike, 716);
  assert.equal(evidence.strikeRaw, null);
  assert.equal(evidence.right, null);
  assert.equal(evidence.tradingClass, null);
  assert.equal(evidence.underlyingConid, 756733);
  assert.equal(evidence.currency, null);
  assert.equal(evidence.validExchanges, null);
});

void test("a response that is not one object states every field null", async () => {
  const client = new FakeIbkrClient(() => [SPY_OPTION]);

  const evidence = await client.getOptionSeriesReference(904834942);

  assert.equal(evidence.requestedConid, 904834942);
  assert.equal(evidence.conid, null);
  assert.equal(evidence.instrumentType, null);
  assert.deepEqual(evidence.presentFieldNames, []);
});

void test("an explicit broker error is raised, because it is a refusal", async () => {
  const client = new FakeIbkrClient(() => ({ error: "no bridge" }));

  await assert.rejects(
    () => client.getOptionSeriesReference(904834942),
    (error: unknown) => error instanceof IbkrBrokerResponseError
  );
  await assert.rejects(
    () => client.getUnderlyingInstrumentReference(756733),
    (error: unknown) => error instanceof IbkrBrokerResponseError
  );
});

void test("a conid that is not a positive integer is refused before any request", async () => {
  const client = clientForContracts({ 904834942: SPY_OPTION });

  await assert.rejects(() => client.getOptionSeriesReference(0), /exact positive IBKR conid/);
  await assert.rejects(() => client.getOptionSeriesReference(-1), /exact positive IBKR conid/);
  await assert.rejects(() => client.getOptionSeriesReference(1.5), /exact positive IBKR conid/);
  await assert.rejects(
    () => client.getUnderlyingInstrumentReference(Number.NaN),
    /exact positive IBKR conid/
  );
  assert.deepEqual(client.calls, []);
});
