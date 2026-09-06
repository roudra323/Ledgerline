#!/usr/bin/env node
/**
 * End-to-end tests for scripts/docs-check.mjs.
 *
 * docs-check.mjs is enforcement code gating `pnpm lint` in CI — nothing has ever run it against a
 * deliberately-broken input, so nobody knows whether its five assertions can actually fail, or
 * whether some of them pass vacuously (find nothing, therefore report nothing).
 *
 * Restructuring the script into importable, unit-testable functions was judged disproportionate:
 * every one of its "functions" closes over module-level regexes and immediately drives
 * process-level side effects (readFileSync off REPO_ROOT, process.exit), and splitting that apart
 * would rewrite the thing under test rather than test it. Instead, each test below builds a
 * complete, minimal, *passing* fixture repository in a temp directory — with the actual,
 * unmodified docs-check.mjs copied into it, so REPO_ROOT resolves inside the fixture — then
 * mutates exactly one fact and asserts the exit code and, where it matters, the message. Every
 * fixture is a fresh temp directory removed in the test's own `finally`.
 *
 * Run with: node --test scripts/docs-check.spec.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = join(__dirname, "docs-check.mjs");

/** A complete, minimal, self-consistent fixture repo — docs-check.mjs must pass this untouched. */
const DEFAULT_FILES = {
  "package.json": JSON.stringify({ scripts: { typecheck: "true", lint: "true" } }, null, 2),

  "docs/progress.md": [
    "# Progress",
    "",
    "| Block | Status |",
    "| --- | --- |",
    "| 1.6 | done |",
    "",
    "## Health check",
    "",
    "- `pnpm typecheck`",
    "",
  ].join("\n"),

  "docs/architecture.md": [
    "# Architecture",
    "",
    "## Chart of accounts",
    "",
    "| 1000 | psp_receivable |",
    "",
  ].join("\n"),

  "docs/ARCHITECTURE-WALKTHROUGH.md": [
    "# Walkthrough",
    "",
    "## The accounts",
    "",
    "| 1000 | psp_receivable |",
    "",
  ].join("\n"),

  "apps/indexer/src/migrations/1700000000001-Seed.ts": [
    "export class Seed1700000000001 {",
    "  async up(q) {",
    "    await q.query(`INSERT INTO ledger_accounts (code, name) VALUES ('1000', 'psp_receivable')`);",
    "  }",
    "}",
    "",
  ].join("\n"),

  "apps/indexer/src/migrations/1700000000002-Kinds.ts": [
    "export class Kinds1700000000002 {",
    "  async up(q) {",
    "    await q.query(`ALTER TABLE ledger_transactions ADD CONSTRAINT k CHECK (kind IN (",
    "      'onramp.capture', 'onramp.settled'",
    "    ))`);",
    "  }",
    "}",
    "",
  ].join("\n"),

  "apps/indexer/src/ledger/entities/ledger-transaction.entity.ts": [
    "export type TransactionKind =",
    '  | "onramp.capture"',
    '  | "onramp.settled";',
    "",
  ].join("\n"),

  "apps/indexer/src/ledger/account-registry.service.ts": [
    "const MERCHANT_ACCOUNT_DEFINITIONS = {",
    '  "2000": { name: "merchant_payable" },',
    "};",
    "",
  ].join("\n"),

  "apps/dummy.ts": "export {};\n",
  "packages/dummy.ts": "export {};\n",
  "infra/dummy.ts": "export {};\n",

  "AGENTS.md": [
    "# pointer",
    "",
    "See CLAUDE.md and docs/conventions.md.",
    "",
    "<!-- ssot:pointer-only -->",
    "",
  ].join("\n"),

  ".agents/rules/conventions.md": [
    "# pointer",
    "",
    "See ../../CLAUDE.md.",
    "",
    "<!-- ssot:pointer-only -->",
    "",
  ].join("\n"),
};

/**
 * Builds a fixture repo: DEFAULT_FILES plus `overrides` (relative path -> content; `null` deletes
 * a default file instead of writing it), with the real docs-check.mjs copied into
 * `<fixture>/scripts/docs-check.mjs` so its REPO_ROOT resolves inside the fixture.
 */
function buildFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "docs-check-fixture-"));
  const files = { ...DEFAULT_FILES, ...overrides };
  for (const [relativePath, content] of Object.entries(files)) {
    if (content === null) continue;
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(root, "scripts", "docs-check.mjs"));
  return root;
}

/** Runs the fixture's copy of docs-check.mjs and returns its exit code and combined output. */
function run(root) {
  try {
    const stdout = execFileSync("node", [join(root, "scripts", "docs-check.mjs")], {
      encoding: "utf8",
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withFixture(overrides, fn) {
  const root = buildFixture(overrides);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the default fixture is self-consistent and passes cleanly", () => {
  withFixture({}, (root) => {
    const { status, output } = run(root);
    assert.equal(status, 0, output);
    assert.match(output, /docs and schema agree/);
  });
});

test("check 1 (kinds): catches a TransactionKind union entry the CHECK does not accept", () => {
  withFixture(
    {
      "apps/indexer/src/ledger/entities/ledger-transaction.entity.ts": [
        "export type TransactionKind =",
        '  | "onramp.capture"',
        '  | "onramp.settled"',
        '  | "onramp.made_up";', // not in the CHECK
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /"onramp.made_up".*TransactionKind union but not in the CHECK/);
    },
  );
});

test("check 1 (kinds) — a single-quoted kind in a posting sample is caught, not skipped", () => {
  // Was a bug: the documented-kind scan was `/kind:\s*"([^"]+)"/g` — double quotes only — so a
  // sample written with single quotes (equally plausible prose) could post a kind the CHECK
  // rejects and docs-check reported zero divergences. A vacuous pass in the check whose entire job
  // is catching exactly that.
  //
  // The fix does not simply widen the quote class: a bare `kind:` is ordinary TypeScript and
  // appears in docs describing unrelated discriminated unions (`{ kind: 'live' | 'backfill' }` in
  // conventions.md §3), which widening alone turns into a false positive. The discriminator is the
  // surrounding fenced block — it must actually be a posting, carrying a `cause:` or calling
  // `ledger.post(`. Both halves are asserted below.
  withFixture(
    {
      "docs/extra.md": [
        "# Extra",
        "",
        "```ts",
        "await ledger.post({",
        "  kind: 'not_a_real_kind',",
        "  cause: { type: 'fiat_event', id: 'evt_1' },",
        "});",
        "```",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `a single-quoted kind inside a posting sample must be caught; got:\n${output}`,
      );
      assert.match(output, /not_a_real_kind/);
    },
  );
});

test("check 1 (kinds) — a bare `kind:` outside a posting block is not mistaken for a ledger kind", () => {
  // The other half of the same fix: widening the quote class without scoping to posting blocks
  // makes every TypeScript discriminated-union example in the docs a false failure.
  withFixture(
    {
      "docs/extra.md": [
        "# Extra",
        "",
        "Prefer discriminated unions over boolean flags:",
        "",
        "```ts",
        "type SyncMode = { kind: 'live' } | { kind: 'backfill' };",
        "```",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 0, `a type example is not a posting; got:\n${output}`);
    },
  );
});

test("check 1 (kinds) — an unrelated column also named 'kind' does not hijack the check", () => {
  // Was a bug: the migration search was `/kind\s+IN\s*\(/i` with no mention of the table, so a
  // later migration adding an unrelated CHECK on some other table's `kind` column outranked the
  // real one (files sort newest-first) and the real TransactionKind union was then compared against
  // a completely different vocabulary. Fixed 2026-09-06 by anchoring the search on
  // `ledger_transactions`; this test locks that in.
  withFixture(
    {
      "apps/indexer/src/migrations/1700000000003-UnrelatedKindColumn.ts": [
        "export class UnrelatedKindColumn1700000000003 {",
        "  async up(q) {",
        "    await q.query(`ALTER TABLE some_other_table ADD CONSTRAINT x CHECK (kind IN ('foo', 'bar'))`);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `the real ledger_transactions CHECK still matches TransactionKind, so this must pass; got:\n${output}`,
      );
      assert.doesNotMatch(output, /1700000000003-UnrelatedKindColumn/);
    },
  );
});

test("check 2 (accounts): catches a documented account code nothing seeds or registers", () => {
  withFixture(
    {
      "docs/architecture.md": [
        "# Architecture",
        "",
        "## Chart of accounts",
        "",
        "| 1000 | psp_receivable |",
        "| 4242 | not_seeded_anywhere |",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /documents account 4242, which nothing creates/);
    },
  );
});

test("check 2 (accounts): sectionLines() fails loudly, not silently, when a heading is renamed", () => {
  withFixture(
    {
      // Renamed "Chart of accounts" -> "Chart Of Accounts" — sectionLines()'s `.includes()` match
      // is case-sensitive, so this heading is no longer found at all.
      "docs/architecture.md": [
        "# Architecture",
        "",
        "## Chart Of Accounts",
        "",
        "| 1000 | x |",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /docs\/architecture\.md has no "Chart of accounts" section to check/);
    },
  );
});

test("check 3 (todos): rejects a TODO(Block N.M) naming a block that doesn't exist in progress.md", () => {
  withFixture(
    {
      "apps/dummy.ts": "// TODO(Block 99.9): this block does not exist\nexport {};\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /TODO\(Block 99\.9\), which is not a block in progress\.md/);
    },
  );
});

test("check 3 (todos): rejects the retired TODO(Phase N) marker style outright", () => {
  withFixture(
    {
      "apps/dummy.ts": "// TODO(Phase 2): old marker style\nexport {};\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /still uses TODO\(Phase 2\)/);
    },
  );
});

test("check 4 (scripts): rejects a health-check command that isn't a real root script", () => {
  withFixture(
    {
      "docs/progress.md": [
        "# Progress",
        "",
        "| Block | Status |",
        "| --- | --- |",
        "| 1.6 | done |",
        "",
        "## Health check",
        "",
        "- `pnpm this-script-does-not-exist`",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /`pnpm this-script-does-not-exist`, which is not a root script/);
    },
  );
});

test("check 5 (pointer files): rejects a pointer file that has grown past the byte ceiling", () => {
  withFixture(
    {
      "AGENTS.md": `# pointer\n\n${"x".repeat(1300)}\n\n<!-- ssot:pointer-only -->\n`,
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /AGENTS\.md is \d+ bytes \(max 1200\)/);
    },
  );
});

test("check 5 (pointer files): rejects a pointer file that lost its marker", () => {
  withFixture(
    {
      "AGENTS.md": "# pointer\n\nSee CLAUDE.md.\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(output, /AGENTS\.md lost its ssot:pointer-only marker/);
    },
  );
});
