import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AccountBalances } from "../src/index.js";

interface PackageManifest {
  bin?: unknown;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

void test("public account balance types expose margin snapshots", () => {
  const balance = undefined as AccountBalances | undefined;
  const excessLiquidity: number | null = balance?.margin.securities.excessLiquidity ?? null;
  assert.equal(excessLiquidity, null);
});

test("package exposes only the library and no CLI entry point", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as PackageManifest;

  assert.equal(manifest.bin, undefined);
  for (const script of Object.values(manifest.scripts ?? {})) {
    assert.doesNotMatch(script, /(?:src|dist)\/cli(?:\/|\s|$)/);
  }
  assert.equal(manifest.dependencies?.["chalk"], undefined);
  assert.equal(manifest.dependencies?.["commander"], undefined);
});
