# Changelog

## 4.5.1

- Read account summary `cushion`, `lookaheadnextchange`, and `leverage` from the IBKR `value`
  field. These values were `0` before because IBKR states them as strings with a placeholder
  `amount: 0`.

## 4.5.0

- Add `getCashBalances()` and the exported `CashBalance` type for cash by ledger currency.
- Exclude the `BASE` aggregate and keep missing or invalid amounts as `null`.

## 4.1.6

- Request IBKR field `7741` (Prior Close) for quotes and derivative chain and reference snapshots.
- Use a finite, non-negative prior close when IBKR supplies it. Otherwise, keep a `C`-prefixed
  close or calculate close from a real last trade minus field `82` (Change). The calculation
  requires finite values and a finite, non-negative result. Zero remains valid.
- Keep the previous history bar as the first source for `quote.closePrice`. Missing optional
  snapshot fields do not add warm-up reads or remove quotes.
