import assert from "node:assert/strict";
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
