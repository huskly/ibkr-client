# Repository Guide

## Toolchain

- Use Yarn 4 through Corepack (`packageManager` field in `package.json`); install with `yarn install --immutable`.

## Conventions

- TypeScript targets ESNext with strict options including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use `import type` for type-only imports. Prefix intentionally unused variables with `_`.
- Use conventional commit and PR titles (`feat:`, `fix:`, `chore:`).
- Write automated tests to verify any relevant code changes.
- This is a public repository, so make any changes with that constraint in mind, the goal is for it
  to be a general purpose ibkr client.
- Make sure the project README.md is kept up to date with features and behavior changes.
- Always talk and write documentation markdown files in ASD-STE100 Simplified Technical English.

## Codex specific

- Run `gh` issue/PR commands outside the sandbox; sandboxed GitHub calls fail in this environment.

## Code Review Rules

### Complete the review before reporting

- Review the entire pull request diff plus affected callers, public types, exports, and tests. Do not
  stop after finding the first issue: check for the same defect pattern at analogous call sites, make
  another pass for independent P0/P1 issues, and consolidate all actionable findings into one review.

### Broker writes and recovery

- Flag any placement, warning-reply, or cancellation path that can retry a write automatically, infer
  an account or order identity, discard partial broker evidence, or permit blind resubmission after an
  ambiguous response. The safe path is a single write attempt with explicit identity and a
  fail-closed `recovery_required` result that retains all observed evidence.

### Provider data and public contracts

- Treat IBKR responses as untrusted at runtime. Flag changes that turn missing or non-finite data into
  plausible values, conflate numeric zero with unavailable `null`, or treat incomplete/unknown broker
  states as success.
- Flag public API changes that are not reflected consistently in exported types, package-boundary
  tests, behavior tests, and README documentation. Preserve compatibility unless the change is
  explicitly intended and documented.
