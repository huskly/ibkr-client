import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseFlexStatement, type FlexStatementEvidence } from "../src/index.js";

function xml(content: string, count = "1"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="synthetic-query" type="AF">
  <FlexStatements count="${count}">${content}</FlexStatements>
</FlexQueryResponse>`;
}
const statement = `<FlexStatement accountId="SYNTHETIC" fromDate="20260901" toDate="20260902">
  <CashTransactions count="2">
    <CashTransaction transactionID="event-1" amount="20000" currency="USD"
      dateTime="20260901;120000" type="Deposits/Withdrawals" description=" A &amp; B " />
    <CashTransaction transactionID="event-2" amount="0" currency="" newField="kept" />
  </CashTransactions><Transfers />
</FlexStatement>`;

void test("statement attributes and detailed cash rows remain source strings", () => {
  const rows: readonly FlexStatementEvidence[] = parseFlexStatement(xml(statement));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.statementAttributes, {
    accountId: "SYNTHETIC",
    fromDate: "20260901",
    toDate: "20260902",
  });
  assert.deepEqual(rows[0]?.cashTransactions?.[0], {
    transactionID: "event-1",
    amount: "20000",
    currency: "USD",
    dateTime: "20260901;120000",
    type: "Deposits/Withdrawals",
    description: " A & B ",
  });
  assert.equal(rows[0]?.cashTransactions?.[1]?.["amount"], "0");
  assert.equal(rows[0]?.cashTransactions?.[1]?.["currency"], "");
  assert.equal(rows[0]?.cashTransactions?.[1]?.["newField"], "kept");
  assert.deepEqual(rows[0]?.transfers, []);
  assert.equal("complete" in (rows[0] ?? {}), false);
});

void test("Trades and identically named OptionEAE rows remain raw source attributes", () => {
  const fixture = readFileSync(
    new URL("./fixtures/flex-option-events.xml", import.meta.url),
    "utf8"
  );
  const [row] = parseFlexStatement(fixture);

  assert.equal(row?.trades?.length, 3);
  assert.deepEqual(row?.trades?.[0], {
    accountId: "SYNTHETIC",
    assetCategory: "OPT",
    symbol: "SYNOPT",
    tradeID: "trade-expiration",
    transactionID: "transaction-expiration",
    positionActionID: "position-expiration",
    relatedTradeID: "",
    notes: "Ep",
    openCloseIndicator: "C",
    buySell: "BUY",
    quantity: "1",
    tradePrice: "0",
    transactionType: "BookTrade",
    dateTime: "20240315;162000",
    ibCommission: "0",
    netCash: "0",
    origTradeID: "",
    origTransactionID: "0",
    levelOfDetail: "EXECUTION",
  });
  assert.equal(row?.trades?.[1]?.["positionActionID"], "position-assignment");
  assert.equal(row?.trades?.[1]?.["buySell"], "BUY");
  assert.equal(row?.trades?.[1]?.["openCloseIndicator"], "C");
  assert.equal(row?.trades?.[1]?.["notes"], "A");
  assert.equal(row?.trades?.[1]?.["quantity"], "1");
  assert.equal(row?.trades?.[1]?.["tradePrice"], "0");
  assert.equal(row?.trades?.[1]?.["netCash"], "0");
  assert.equal(row?.trades?.[2]?.["positionActionID"], "position-assignment");
  assert.equal(row?.trades?.[2]?.["buySell"], "BUY");
  assert.equal(row?.trades?.[2]?.["openCloseIndicator"], "O");
  assert.equal(row?.trades?.[2]?.["notes"], "A");
  assert.equal(row?.trades?.[2]?.["quantity"], "100");
  assert.equal(row?.trades?.[2]?.["tradePrice"], "100");
  assert.equal(row?.trades?.[2]?.["netCash"], "-10000");
  for (const trade of row?.trades ?? []) {
    assert.equal(trade["relatedTradeID"], "");
    assert.equal(trade["origTradeID"], "");
    assert.equal(trade["origTransactionID"], "0");
  }

  assert.equal(row?.optionEae?.length, 3);
  assert.equal(row?.optionEae?.[0]?.["transactionType"], "Expiration");
  assert.equal(row?.optionEae?.[0]?.["quantity"], "1");
  assert.equal(row?.optionEae?.[0]?.["tradePrice"], "0");
  assert.equal(row?.optionEae?.[0]?.["proceeds"], "0");
  assert.equal(row?.optionEae?.[0]?.["commisionsAndTax"], "0");
  assert.equal(row?.optionEae?.[1]?.["transactionType"], "Assignment");
  assert.equal(row?.optionEae?.[1]?.["quantity"], "1");
  assert.equal(row?.optionEae?.[1]?.["tradePrice"], "0");
  assert.equal(row?.optionEae?.[1]?.["proceeds"], "0");
  assert.equal(row?.optionEae?.[2]?.["transactionType"], "Buy");
  assert.equal(row?.optionEae?.[2]?.["quantity"], "100");
  assert.equal(row?.optionEae?.[2]?.["tradePrice"], "100");
  assert.equal(row?.optionEae?.[2]?.["proceeds"], "-10000");
  assert.equal(row?.optionEae?.[1]?.["tradeID"], row?.trades?.[1]?.["tradeID"]);
  assert.equal(row?.optionEae?.[2]?.["tradeID"], row?.trades?.[2]?.["tradeID"]);
});

void test("absent and empty trade evidence sections remain distinct", () => {
  const [absent] = parseFlexStatement(xml(`<FlexStatement accountId="SYNTHETIC"/>`));
  assert.equal(absent?.trades, null);
  assert.equal(absent?.optionEae, null);

  const [empty] = parseFlexStatement(
    xml(`<FlexStatement accountId="SYNTHETIC"><Trades/><OptionEAE/></FlexStatement>`)
  );
  assert.deepEqual(empty?.trades, []);
  assert.deepEqual(empty?.optionEae, []);
});

void test("multiple accounts remain separate without inferred identity", () => {
  const rows = parseFlexStatement(
    xml(
      statement +
        `<FlexStatement accountId="OTHER">
    <CashTransactions/><Transfers><Transfer type="INTERNAL" amount="-10" /></Transfers>
    <UnrelatedSection value="not-consumed" />
  </FlexStatement>`,
      "2"
    )
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.statementAttributes["accountId"], "OTHER");
  assert.deepEqual(rows[1]?.cashTransactions, []);
  assert.deepEqual(rows[1]?.transfers, [{ type: "INTERNAL", amount: "-10" }]);
});

void test("absent sections are null, not an assertion that no flow occurred", () => {
  const rows = parseFlexStatement(xml(`<FlexStatement accountId="SYNTHETIC"/>`));
  assert.equal(rows[0]?.cashTransactions, null);
  assert.equal(rows[0]?.transfers, null);
});

void test("empty statement lists do not invent an account", () => {
  assert.deepEqual(parseFlexStatement(xml("", "0")), []);
});

const malformed: [string, string][] = [
  ["broken XML", "<FlexQueryResponse>"],
  ["error envelope", "<FlexStatementResponse><Status>Fail</Status></FlexStatementResponse>"],
  ["missing wrapper", "<FlexQueryResponse/>"],
  ["missing count", "<FlexQueryResponse><FlexStatements/></FlexQueryResponse>"],
  ["wrong count", xml(statement, "2")],
  [
    "duplicate wrapper",
    xml(statement).replace(
      "</FlexQueryResponse>",
      '<FlexStatements count="0"/></FlexQueryResponse>'
    ),
  ],
  ["row count mismatch", xml(statement.replace('count="2"', 'count="3"'))],
  [
    "duplicate cash section",
    xml("<FlexStatement><CashTransactions/><CashTransactions/></FlexStatement>"),
  ],
  [
    "unexpected cash child",
    xml(
      '<FlexStatement><CashTransactions><Unknown amount="200"/></CashTransactions></FlexStatement>'
    ),
  ],
  [
    "nested row data",
    xml(
      "<FlexStatement><CashTransactions><CashTransaction><amount>200</amount></CashTransaction></CashTransactions></FlexStatement>"
    ),
  ],
  [
    "section text",
    xml("<FlexStatement><CashTransactions>private-text</CashTransactions></FlexStatement>"),
  ],
  ["duplicate transfer section", xml("<FlexStatement><Transfers/><Transfers/></FlexStatement>")],
  [
    "unknown transfer child",
    xml("<FlexStatement><Transfers><Unknown/></Transfers></FlexStatement>"),
  ],
  ["DTD", '<!DOCTYPE FlexQueryResponse [<!ENTITY x "private-data">]>' + xml(statement)],
  ["external entity", '<!DOCTYPE x SYSTEM "file:///private-file">' + xml(statement)],
  [
    "too deep",
    xml(
      `<FlexStatement accountId="SYNTHETIC"><CashTransactions/><Transfers/><Other>${"<a>".repeat(40)}${"</a>".repeat(40)}</Other></FlexStatement>`
    ),
  ],
];
for (const [name, body] of malformed) {
  void test(`refuses ${name} without leaking source values`, () => {
    assert.throws(
      () => parseFlexStatement(body),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-text|private-data|private-file/);
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  });
}

void test("direct XML input is bounded by UTF-8 bytes", () => {
  assert.throws(() => parseFlexStatement("é".repeat(4 * 1024 * 1024 + 1)), /safe input limits/);
});

void test("whitespace-only target sections remain explicit empty sections", () => {
  const rows = parseFlexStatement(
    xml(`<FlexStatement accountId="SYNTHETIC">
    <CashTransactions>  \n </CashTransactions><Transfers> \n </Transfers>
  </FlexStatement>`)
  );
  assert.deepEqual(rows[0]?.cashTransactions, []);
  assert.deepEqual(rows[0]?.transfers, []);
});
