# Repository Guide

## Toolchain

- Use Yarn Classic (`yarn.lock` v1); install with `yarn install --frozen-lockfile`.

## Conventions

- TypeScript targets ESNext with strict options including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use `import type` for type-only imports. Prefix intentionally unused variables with `_`.
- Use conventional commit and PR titles (`feat:`, `fix:`, `chore:`).
- Write automated tests to verify any relevant code changes.
- This is a public repository, so make any changes with that constraint in mind, the goal is for it
  to be a general purpose ibkr client.
- Make sure the project README.md is kept up to date with features and behavior changes.

## Codex specific

- Run `gh` issue/PR commands outside the sandbox; sandboxed GitHub calls fail in this environment.
