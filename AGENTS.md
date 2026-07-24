# Repository Guide

## Toolchain

- Use Yarn Classic (`yarn.lock` v1); install with `yarn install --frozen-lockfile`.

## Conventions

- TypeScript targets ES2025 with strict options including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use `import type` for type-only imports. Prefix intentionally unused variables with `_`.
- Use conventional commit and PR titles (`feat:`, `fix:`, `chore:`).
- Write automated tests to verify any relevant code changes.

## Codex specific

- Run `gh` issue/PR commands outside the sandbox; sandboxed GitHub calls fail in this environment.
