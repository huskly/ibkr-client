# Issue 53 Warning ID Classification Design

## Goal

Allow a caller to approve any exact IBKR warning ID after operator review. Keep malformed warning data fail-closed.

## Current Problem

The warning decoder marks a warning as `known` only when every ID in its `messageIds` array is in a library-owned set containing only `o163`. This prevents a caller's exact `approvedWarningIds` policy from approving other valid IBKR warnings, such as `o10331`.

## Design

Remove the library-owned warning ID set. The decoder will mark `known` as `true` when the raw `messageIds` value is a non-empty array and every array item is a string. It will keep the filtered string IDs in the public warning result. A missing, non-array, empty, or mixed-type value will remain `known: false`.

The library will continue to classify warning shape only. It will not approve or acknowledge warnings automatically. The caller's exact warning-ID allowlist remains the authorization boundary.

## Implementation Scope

- Update `decodeOrderSubmission` in `src/ibkr/ibkrClient.ts`.
- Remove the unused hardcoded warning-ID set.
- Add behavior tests for a non-`o163` warning and malformed warning IDs.
- Update the README to describe shape validation and caller-controlled approval.

## Safety and Error Handling

No broker write path changes. Warning replies remain single-attempt operations. Unknown or malformed warning evidence remains pending or fail-closed for the caller. The change does not infer approval from a warning message, description, or undocumented field.

## Validation

Run the focused warning tests, the full test suite, lint, formatting, type checking, build, and `git diff --check`.
