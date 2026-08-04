# Account Margin Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose typed aggregate, securities, and commodities margin snapshots from `getAccountBalances()` while preserving zero-versus-unavailable semantics.

**Architecture:** Keep the raw IBKR summary response open and normalize a fixed set of documented margin keys at the `IbkrClient` provider boundary. Add `AccountMarginSnapshot` and `AccountMargin` to the broker-neutral public types, attach `margin` to `AccountBalances`, and map unsuffixed, `-s`, and `-c` keys into `total`, `securities`, and `commodities` snapshots.

**Tech Stack:** TypeScript ESNext, Node `node:test`, Yarn Classic, Prettier, ESLint, and the existing `IbkrClient` fake-request test seam.

## Global Constraints

- Use Yarn Classic and the repository's existing scripts.
- Keep strict TypeScript compatibility, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Treat IBKR response values as untrusted; malformed, missing, null, and non-finite margin amounts become `null`, while numeric zero remains `0`.
- Preserve the existing `netLiquidation`, `availableFunds`, `buyingPower`, and `cashBalance` fields and the single `/portfolio/{accountId}/summary` request.
- Export all new public types from `src/index.ts` and document the behavior in `README.md`.
- Do not expose an untyped raw summary map or infer a Schwab-style debit/credit `marginBalance`.

---

### Task 1: Add the failing account-margin behavior test

**Files:**
- Modify: `test/ibkrClient.brokerFeatures.test.ts`

**Interfaces:**
- Consumes: Existing `FakeIbkrClient` request responder and `IbkrClient.getAccountBalances()`.
- Produces: A regression test proving the intended `AccountBalances.margin` shape and nullable normalization.

- [ ] **Step 1: Add a test with representative aggregate and segment summary keys**

Append this test to `test/ibkrClient.brokerFeatures.test.ts`:

```ts
void test("getAccountBalances exposes typed total and segment margin snapshots", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId: "U123" }];
    if (input.path === "portfolio/U123/summary") {
      return {
        netliquidation: { amount: 12_000 },
        availablefunds: { amount: 8_000 },
        buyingpower: { amount: 32_000 },
        totalcashvalue: { amount: 4_000 },
        equitywithloanvalue: { amount: 11_500 },
        "equitywithloanvalue-s": { amount: 10_000 },
        regtequity: { amount: 9_500 },
        "regtmargin-s": { amount: 5_000 },
        initmarginreq: { amount: 2_000 },
        "maintmarginreq-s": { amount: 1_500 },
        excessliquidity: { amount: 0 },
        "availablefunds-c": { amount: "bad-value" },
        sma: { amount: Number.POSITIVE_INFINITY },
        fullavailablefunds: { amount: 7_000 },
        lookaheadnextchange: { amount: 1_754_000_000 },
        "leverage-s": { amount: 1.25 },
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.deepEqual(await client.getAccountBalances(), {
    netLiquidation: 12_000,
    availableFunds: 8_000,
    buyingPower: 32_000,
    cashBalance: 4_000,
    margin: {
      total: {
        equityWithLoanValue: 11_500,
        regTEquity: 9_500,
        regTMargin: null,
        initialMarginRequirement: 2_000,
        maintenanceMarginRequirement: null,
        availableFunds: 8_000,
        excessLiquidity: 0,
        cushion: null,
        sma: null,
        buyingPower: 32_000,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: 7_000,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: 1_754_000_000,
        leverage: null,
      },
      securities: {
        equityWithLoanValue: 10_000,
        regTEquity: null,
        regTMargin: 5_000,
        initialMarginRequirement: null,
        maintenanceMarginRequirement: 1_500,
        availableFunds: null,
        excessLiquidity: null,
        cushion: null,
        sma: null,
        buyingPower: null,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: null,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: null,
        leverage: 1.25,
      },
      commodities: {
        equityWithLoanValue: null,
        regTEquity: null,
        regTMargin: null,
        initialMarginRequirement: null,
        maintenanceMarginRequirement: null,
        availableFunds: null,
        excessLiquidity: null,
        cushion: null,
        sma: null,
        buyingPower: null,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: null,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: null,
        leverage: null,
      },
    },
  });
  assert.equal(client.calls.filter(({ path }) => path === "portfolio/U123/summary").length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing public field**

Run: `yarn test test/ibkrClient.brokerFeatures.test.ts`

Expected: FAIL because `getAccountBalances()` currently returns no `margin` property and the new expected nested result does not match.

### Task 2: Implement the typed margin contract and normalization

**Files:**
- Modify: `src/helpers.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/ibkr/ibkrClient.ts:1430-1439`

**Interfaces:**
- Consumes: The failing behavior test from Task 1 and `IbkrPortfolioSummary` keyed response values.
- Produces: Exported `AccountMarginSnapshot`, `AccountMargin`, and `AccountBalances.margin` with normalized nullable values.

- [ ] **Step 1: Add a nullable finite-number helper**

Add `toNullableNumber(value: unknown): number | null` to `src/helpers.ts`. Return the number unchanged only when it is finite; parse numeric strings with `Number.parseFloat`; return `null` for all other values.

- [ ] **Step 2: Add public margin interfaces**

Add these exported interfaces to `src/types.ts`:

```ts
export interface AccountMarginSnapshot {
  equityWithLoanValue: number | null;
  regTEquity: number | null;
  regTMargin: number | null;
  initialMarginRequirement: number | null;
  maintenanceMarginRequirement: number | null;
  availableFunds: number | null;
  excessLiquidity: number | null;
  cushion: number | null;
  sma: number | null;
  buyingPower: number | null;
  fullInitialMarginRequirement: number | null;
  fullMaintenanceMarginRequirement: number | null;
  fullAvailableFunds: number | null;
  fullExcessLiquidity: number | null;
  lookAheadInitialMarginRequirement: number | null;
  lookAheadMaintenanceMarginRequirement: number | null;
  lookAheadAvailableFunds: number | null;
  lookAheadExcessLiquidity: number | null;
  lookAheadNextChange: number | null;
  leverage: number | null;
}

export interface AccountMargin {
  total: AccountMarginSnapshot;
  securities: AccountMarginSnapshot;
  commodities: AccountMarginSnapshot;
}
```

Add `margin: AccountMargin` to `AccountBalances`, and export `AccountMargin` and `AccountMarginSnapshot` from `src/index.ts`.

- [ ] **Step 3: Map aggregate and segment summary keys**

Import `toNullableNumber` into `src/ibkr/ibkrClient.ts`. Add a local `marginSnapshot(suffix: "" | "-s" | "-c")` helper inside `getAccountBalances()` that reads these lower-case IBKR keys with the supplied suffix:

`equitywithloanvalue`, `regtequity`, `regtmargin`, `initmarginreq`, `maintmarginreq`, `availablefunds`, `excessliquidity`, `cushion`, `sma`, `buyingpower`, `fullinitmarginreq`, `fullmaintmarginreq`, `fullavailablefunds`, `fullexcessliquidity`, `lookaheadinitmarginreq`, `lookaheadmaintmarginreq`, `lookaheadavailablefunds`, `lookaheadexcessliquidity`, `lookaheadnextchange`, and `leverage`.

Use `toNullableNumber(summary[`${key}${suffix}`]?.amount)` for each value, then return `margin: { total: marginSnapshot(""), securities: marginSnapshot("-s"), commodities: marginSnapshot("-c") }` alongside the existing fields.

### Task 3: Update README and public-contract coverage

**Files:**
- Modify: `README.md:66-72`
- Modify: `test/packageBoundary.test.ts`

**Interfaces:**
- Consumes: The exported `AccountBalances` and margin interfaces from Task 2.
- Produces: Documentation and compile-time coverage that the package boundary exposes the new typed contract.

- [ ] **Step 1: Document the margin snapshots**

Update the account API section to state that `getAccountBalances()` returns `margin.total`, `margin.securities`, and `margin.commodities`, list the categories of available metrics, and explain that absent or invalid provider values are `null` while zero remains zero.

- [ ] **Step 2: Add a public type compile assertion**

Import `AccountBalances` as a type from `../src/index.js` in `test/packageBoundary.test.ts`, declare a type-only assertion using `AccountBalances["margin"]["securities"]["excessLiquidity"]`, and keep the existing manifest assertions unchanged. The test must compile against the package entry point rather than the internal types module.

### Task 4: Format, verify, and commit

**Files:**
- Modify: `src/helpers.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/ibkr/ibkrClient.ts`
- Modify: `test/ibkrClient.brokerFeatures.test.ts`
- Modify: `test/packageBoundary.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Run the focused behavior and package-boundary tests**

Run: `yarn test test/ibkrClient.brokerFeatures.test.ts test/packageBoundary.test.ts`

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Run formatting and static checks**

Run: `yarn format:check && yarn lint && yarn typecheck`

Expected: each command exits 0 with no formatting errors, lint errors, or TypeScript errors.

- [ ] **Step 3: Run the complete test suite and build**

Run: `yarn test && yarn build`

Expected: the complete Node test suite and production TypeScript build exit 0.

- [ ] **Step 4: Inspect the final diff and commit the implementation**

Run: `git diff --check && git status --short && git diff --stat`

Then commit with:

```bash
git add README.md src/helpers.ts src/index.ts src/types.ts src/ibkr/ibkrClient.ts test/ibkrClient.brokerFeatures.test.ts test/packageBoundary.test.ts
git commit -m "feat: expose IBKR account margin values"
```
