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
  // todoBearingFiles() unconditionally yields the root "Makefile" path (it is not optional the way
  // apps/packages/infra directory contents are) — every real checkout has one, so the fixture must
  // too, or every test below fails on an unrelated ENOENT rather than the thing it is testing.
  Makefile: "demo:\n\techo hi\n",

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

// ── check 2b: the balance trigger's account read must show the lock it actually takes ────────────
//
// The first version of this check shipped broken: `markdownFiles()` was a flat `readdirSync("docs")`
// with no recursion, so `docs/decisions/` — where the ADR this check exists to police lives — was
// never scanned, and a doc claiming the wrong lock mode passed silently. Twice. Both the kinds scan
// and the lock scan were made recursive in the same commit; the tests below hold that fix in place
// for both checks, then exercise check 2b's own logic (the parser, and which of the migration's two
// copies of the trigger function it trusts).

/**
 * A migration reproducing 1754006400007's actual shape: the trigger function is defined twice as
 * template-literal constants — `lockingFn` (what `up()` installs) and `unlockedFn` (what `down()`
 * restores) — and docs-check.mjs's `newestMigrationDefining()` trusts whichever copy appears FIRST
 * in the file's source text, on the unstated assumption that that is always the up() copy. `order`
 * lets a test flip which copy is textually first without changing what up()/down() actually call,
 * to prove that assumption is doing real work rather than being vacuously true.
 */
function triggerMigrationSource(upLockClause, { order = "up-first" } = {}) {
  const lockingFn = [
    "const lockingFn = `",
    "  CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS trigger AS $$",
    "  BEGIN",
    "    SELECT normal_side, allows_negative",
    "      INTO account_normal_side, account_allows_negative",
    "      FROM ledger_accounts",
    `     WHERE id = NEW.account_id${upLockClause};`,
    "  END;",
    "  $$ LANGUAGE plpgsql",
    "`;",
  ].join("\n");

  const unlockedFn = [
    "const unlockedFn = `",
    "  CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS trigger AS $$",
    "  BEGIN",
    "    SELECT normal_side, allows_negative",
    "      INTO account_normal_side, account_allows_negative",
    "      FROM ledger_accounts",
    "     WHERE id = NEW.account_id;",
    "  END;",
    "  $$ LANGUAGE plpgsql",
    "`;",
  ].join("\n");

  const definitions = order === "up-first" ? [lockingFn, unlockedFn] : [unlockedFn, lockingFn];

  return [
    "export class Trigger1700000000004 {",
    "  async up(q) { return q.query(lockingFn); }",
    "  async down(q) { return q.query(unlockedFn); }",
    "}",
    "",
    ...definitions,
    "",
  ].join("\n");
}

/** A markdown fixture showing the trigger's account read with a given (possibly absent) lock. */
function docShowingLock(lockClause) {
  return [
    "# Some doc",
    "",
    "```sql",
    "SELECT normal_side, allows_negative",
    "  FROM ledger_accounts",
    ` WHERE id = NEW.account_id${lockClause};`,
    "```",
    "",
  ].join("\n");
}

const TRIGGER_MIGRATION_PATH = "apps/indexer/src/migrations/1700000000004-Trigger.ts";
const REAL_LOCK_CLAUSE = "\n       FOR NO KEY UPDATE";

test("check 2b (lock): passes when the doc shows the same lock the migration actually takes", () => {
  // Positive control: if this ever goes red, check 2b false-positives on a correct doc, which is as
  // useless as never firing.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock(REAL_LOCK_CLAUSE),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 0, `a correct doc must not be flagged; got:\n${output}`);
    },
  );
});

test("check 2b (lock): catches a doc claiming FOR UPDATE against a migration that takes FOR NO KEY UPDATE", () => {
  // This is the exact divergence ADR-0017 exists to prevent: FOR UPDATE deadlocks against the
  // composite FK's KEY SHARE lock (measured: 49 of 50 postings deadlocked). A doc telling a reader
  // the trigger takes FOR UPDATE is actively dangerous, not just stale.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock("\n FOR UPDATE"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(
        output,
        /shows the balance trigger reading ledger_accounts FOR UPDATE, but it takes FOR NO KEY UPDATE/,
      );
    },
  );
});

test("check 2b (lock): catches a doc claiming FOR SHARE against a migration that takes FOR NO KEY UPDATE", () => {
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock("\n FOR SHARE"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(
        output,
        /shows the balance trigger reading ledger_accounts FOR SHARE, but it takes FOR NO KEY UPDATE/,
      );
    },
  );
});

test("check 2b (lock): catches a doc that shows the account read with no lock clause at all", () => {
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock(""),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(
        output,
        /shows the balance trigger reading ledger_accounts with no lock, but it takes FOR NO KEY UPDATE/,
      );
    },
  );
});

test("check 2b (lock) — recursion regression: catches a wrong-lock doc that lives in docs/decisions/", () => {
  // This is the bug that shipped: markdownFiles() was `readdirSync("docs")` with no
  // `withFileTypes`/recursion, so docs/decisions/ — where ADR-0017 itself lives — was never read. A
  // revert of markdownFiles() to a flat scan must turn this test red.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/decisions/0099-fake-adr.md": docShowingLock("\n FOR UPDATE"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a violation inside docs/decisions/ must be caught; got:\n${output}`);
      assert.match(output, /docs\/decisions\/0099-fake-adr\.md/);
    },
  );
});

test("check 2b (lock) — recursion regression: catches a wrong-lock doc nested two levels deep", () => {
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/reviews/2026-01-01/deep-dive.md": docShowingLock("\n FOR SHARE"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `a violation two directories deep under docs/ must be caught; got:\n${output}`,
      );
      assert.match(output, /docs\/reviews\/2026-01-01\/deep-dive\.md/);
    },
  );
});

test("check 1 (kinds) — recursion regression: catches a bad posting kind that lives in docs/decisions/", () => {
  withFixture(
    {
      "docs/decisions/0099-fake-adr.md": [
        "# ADR",
        "",
        "```ts",
        "await ledger.post({ kind: 'onramp.not_real', cause: { type: 'fiat_event', id: 'e' } });",
        "```",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a bad kind inside docs/decisions/ must be caught; got:\n${output}`);
      assert.match(output, /docs\/decisions\/0099-fake-adr\.md posts kind 'onramp\.not_real'/);
    },
  );
});

test("check 1 (kinds) — recursion regression: catches a bad posting kind nested two levels deep", () => {
  withFixture(
    {
      "docs/reviews/2026-01-01/deep-dive.md": [
        "# Review",
        "",
        "```ts",
        "await ledger.post({ kind: 'onramp.also_not_real', cause: { type: 'fiat_event', id: 'e' } });",
        "```",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `a bad kind two directories deep under docs/ must be caught; got:\n${output}`,
      );
      assert.match(
        output,
        /docs\/reviews\/2026-01-01\/deep-dive\.md posts kind 'onramp\.also_not_real'/,
      );
    },
  );
});

test("check 2b (lock) — an ADR's table of rejected alternatives naming FOR UPDATE in prose is not flagged", () => {
  // ADR-0017's real "Alternatives considered" table names `FOR UPDATE` as a rejected alternative.
  // That is legitimate prose, not a claim about what the trigger reads, and must not fail the build.
  withFixture(
    {
      "docs/decisions/0017-non-negative-enforcement.md": [
        "# ADR-0017",
        "",
        "The lock is `FOR NO KEY UPDATE`:",
        "",
        "```sql",
        "SELECT normal_side, allows_negative INTO ...",
        "  FROM ledger_accounts WHERE id = NEW.account_id",
        "  FOR NO KEY UPDATE;",
        "```",
        "",
        "## Alternatives considered",
        "",
        "| Alternative | Why it lost |",
        "| --- | --- |",
        "| `SELECT ... FOR UPDATE` on the `ledger_entries` rows instead | You cannot lock rows that do not exist yet. |",
        "| `FOR UPDATE` conflicts with the `KEY SHARE` lock the composite FK takes | Deadlocks by construction. |",
        "",
      ].join("\n"),
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `prose discussing FOR UPDATE as a rejected alternative must not fail the build; got:\n${output}`,
      );
    },
  );
});

test("check 2b (lock) — an unrelated FOR UPDATE lock on a different table is not flagged", () => {
  // The walkthrough's §9 describes a genuine `SELECT ... FOR UPDATE` — on chain_accounts, for nonce
  // allocation, nothing to do with the ledger balance trigger. The table name must matter: the
  // pattern requires `ledger_accounts` specifically, so this must pass untouched.
  withFixture(
    {
      "docs/extra.md": [
        "# Chain writer",
        "",
        "### The FOR UPDATE row lock on nonces",
        "",
        "```sql",
        "SELECT next_nonce FROM chain_accounts WHERE id = NEW.chain_account_id FOR UPDATE;",
        "```",
        "",
      ].join("\n"),
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `a FOR UPDATE lock on an unrelated table must not be mistaken for the ledger trigger's; got:\n${output}`,
      );
    },
  );
});

test("check 2b (lock) — normaliseLock() treats whitespace, newlines and case as insignificant", () => {
  // A doc reproducing the migration's own multi-line, indented SQL formatting — lowercase, with the
  // clause split across a line break — must still be recognised as matching FOR NO KEY UPDATE.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock("\n       for no   key\n         update"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `lowercase, re-wrapped whitespace must still normalise to FOR NO KEY UPDATE; got:\n${output}`,
      );
    },
  );
});

test("check 2b (lock) — normaliseLock() does not confuse FOR NO KEY UPDATE with plain FOR UPDATE", () => {
  // Guards the alternation order in normaliseLock()'s regex: `NO\s+KEY\s+UPDATE` must be tried before
  // the bare `UPDATE` alternative, or a real `FOR NO KEY UPDATE` clause risks being reported back as
  // the (wrong, deadlock-prone) `FOR UPDATE`.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE),
      "docs/extra.md": docShowingLock("\n FOR UPDATE"), // deliberately the wrong clause
    },
    (root) => {
      const { status, output } = run(root);
      // Must be reported as an actual FOR UPDATE vs FOR NO KEY UPDATE mismatch, not misparsed into
      // some other pair of strings (which would still fail, but for the wrong stated reason and
      // would mask a parser regression under a coincidentally-still-failing test).
      assert.equal(status, 1);
      assert.match(output, /reading ledger_accounts FOR UPDATE, but it takes FOR NO KEY UPDATE/);
    },
  );
});

test("check 2b (lock) — newestMigrationDefining() trusts the FIRST definition in the file, which is up()'s", () => {
  // 1754006400007 defines the trigger function twice: `lockingFn` (installed by up(), textually
  // first in the file) and `unlockedFn` (restored by down(), textually second). docs-check.mjs reads
  // whichever definition comes first in the source text and assumes it is up()'s — a positional
  // assumption, not a semantic one. With the real (up-first) ordering, a doc matching the locked
  // clause must pass.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE, { order: "up-first" }),
      "docs/extra.md": docShowingLock(REAL_LOCK_CLAUSE),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `up-first ordering must compare against the locked version; got:\n${output}`,
      );
    },
  );
});

test("check 2b (lock) — regression canary: reordering the migration's two function copies silently flips what the check trusts", () => {
  // Same migration content as the previous test, only the two `const` definitions swapped so the
  // *unlocked* (down()) copy is textually first. docs-check.mjs has no way to tell up() from down()
  // by meaning — it just reads the first CREATE OR REPLACE it finds — so this flips its ground truth
  // to "no lock" even though up() still installs the locked function. A doc that correctly says
  // FOR NO KEY UPDATE now gets flagged as wrong.
  //
  // This is not asserting docs-check.mjs is broken today — the real migration file happens to define
  // the locked copy first. It is a canary: if a future edit to 1754006400007-LedgerNonNegativeLock.ts
  // (or to newestMigrationDefining()) ever changes which copy is textually first, this test's twin
  // above and this one demonstrate exactly how the check's ground truth would silently flip with it,
  // with nothing in the check itself able to notice.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(REAL_LOCK_CLAUSE, { order: "down-first" }),
      "docs/extra.md": docShowingLock(REAL_LOCK_CLAUSE),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `reordering the two definitions must flip the check's ground truth to "no lock"; got:\n${output}`,
      );
      assert.match(
        output,
        /shows the balance trigger reading ledger_accounts FOR NO KEY UPDATE, but it takes no lock/,
      );
    },
  );
});

// ── check 1 (kinds): proseLedgerKindsIn() — SQL-style `kind='x'` literals outside posting samples ──

test("check 1 (kinds) — prose: catches a `kind='x'` literal outside any fenced code block", () => {
  // This is the exact gap the runbook hit: a kind named in a sentence, not a `kind:` field inside a
  // ```ts posting sample, was invisible to postingKindsIn() entirely. If proseLedgerKindsIn() regresses
  // to a no-op, this must go from red back to green.
  withFixture(
    {
      "docs/extra.md": [
        "# Runbook",
        "",
        "If you see a transaction with kind='onramp.not_real', page the on-call.",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `a bare SQL-style kind literal in prose must be caught; got:\n${output}`,
      );
      assert.match(output, /posts kind 'onramp\.not_real'/);
    },
  );
});

test("check 1 (kinds) — prose: catches `kind = 'x'` with spaces around the equals sign", () => {
  withFixture(
    {
      "docs/extra.md": "Any row where kind = 'onramp.spaced_out' is a bug.\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `spaced '=' must still match; got:\n${output}`);
      assert.match(output, /posts kind 'onramp\.spaced_out'/);
    },
  );
});

test("check 1 (kinds) — prose: a double-quoted kind literal is caught too", () => {
  // Found by adversarial-tester: the first version matched single quotes only, mirroring SQL, so a
  // bad kind written as kind="x" in prose passed. Prose authors do not reliably follow SQL quoting.
  withFixture(
    {
      "docs/extra.md": 'Any row where kind="onramp.double_quoted_escape" is a bug.\n',
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a double-quoted bad kind must be flagged; got:\n${output}`);
      assert.match(output, /onramp\.double_quoted_escape/);
    },
  );
});

test("check 1 (kinds) — prose: a line mentioning 'outbox' is exempt even though it names a bad ledger-shaped kind", () => {
  // outbox_messages has its own kind vocabulary (chain.gas_refill etc.) — a line describing it must
  // not be checked against the ledger_transactions CHECK at all.
  withFixture(
    {
      "docs/extra.md": "The outbox row has kind='chain.gas_refill', which is not a ledger kind.\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `an outbox-mentioning line must be skipped entirely; got:\n${output}`,
      );
    },
  );
});

test("check 1 (kinds) — prose: the outbox exemption is case-insensitive ('Outbox', 'OUTBOX')", () => {
  withFixture(
    {
      "docs/extra.md": [
        "The Outbox row has kind='chain.gas_refill', fine.",
        "The OUTBOX table also uses kind='chain.another_bad_one', also fine.",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `mixed-case 'Outbox'/'OUTBOX' must still exempt the line; got:\n${output}`,
      );
    },
  );
});

test("check 1 (kinds) — prose: a fenced SQL block is still scanned line-by-line (not exempted just for being fenced)", () => {
  // proseLedgerKindsIn() operates on markdown.split("\n") with no fence-tracking at all — unlike
  // postingKindsIn(), it does not require (or check for) being inside or outside a code fence. A bad
  // kind inside a fenced SQL example must still be caught; this pins that behavior so a future
  // "only scan prose outside fences" rewrite doesn't silently start skipping fenced SQL examples.
  withFixture(
    {
      "docs/extra.md": [
        "# Example query",
        "",
        "```sql",
        "SELECT * FROM ledger_transactions WHERE kind='onramp.fenced_but_still_checked';",
        "```",
        "",
      ].join("\n"),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        1,
        `a fenced SQL block is not exempt from the prose scan; got:\n${output}`,
      );
      assert.match(output, /onramp\.fenced_but_still_checked/);
    },
  );
});

test("check 1 (kinds) — prose: a valid kind='x' literal naming a real CHECK kind does not false-positive", () => {
  // Positive control for proseLedgerKindsIn(): if this regresses to flagging every match regardless
  // of whether the kind is real, this must go red.
  withFixture(
    {
      "docs/extra.md": "Every row with kind='onramp.capture' is a deposit leg.\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 0, `a real kind named in prose must not be flagged; got:\n${output}`);
    },
  );
});

// ── check 3 (todos): expanded file-type scan (.yml/.yaml/.json/.toml/.sh/Makefile) ─────────────────

test("check 3 (todos) — a repository with no root Makefile is checked normally, not crashed", () => {
  // Found by adversarial-tester: todoBearingFiles() yielded "Makefile" unconditionally, so a missing
  // root Makefile — the one hand-named path in the scan — crashed docs:check with an uncaught ENOENT
  // stack trace instead of running the check. A missing Makefile carries no TODOs, so it is skipped.
  withFixture(
    {
      Makefile: null, // delete the fixture's default Makefile
    },
    (root) => {
      const { status, output } = run(root);
      assert.doesNotMatch(
        output,
        /ENOENT|Node\.js v\d/,
        `docs:check must not crash; got:\n${output}`,
      );
      assert.equal(status, 0, `the fixture is otherwise consistent; got:\n${output}`);
    },
  );
});

test("check 3 (todos) — scans a .yml file for a dangling TODO(Block N.M)", () => {
  withFixture(
    {
      "infra/prometheus/rules.yml": "# TODO(Block 99.1): tune this alert threshold\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a .yml file must be scanned; got:\n${output}`);
      assert.match(output, /infra\/prometheus\/rules\.yml has TODO\(Block 99\.1\)/);
    },
  );
});

test("check 3 (todos) — scans a .yaml file (the other spelling of the same extension)", () => {
  withFixture(
    {
      "infra/grafana/dash.yaml": "# TODO(Block 99.2): fix this panel\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a .yaml file must be scanned; got:\n${output}`);
      assert.match(output, /infra\/grafana\/dash\.yaml has TODO\(Block 99\.2\)/);
    },
  );
});

test("check 3 (todos) — scans a .toml file for a retired TODO(Phase N) marker", () => {
  withFixture(
    {
      "packages/contracts/foundry.toml": "# TODO(Phase 3): raise the optimizer runs\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a .toml file must be scanned; got:\n${output}`);
      assert.match(output, /packages\/contracts\/foundry\.toml still uses TODO\(Phase 3\)/);
    },
  );
});

test("check 3 (todos) — scans a .sh file for a dangling TODO(Part N)", () => {
  withFixture(
    {
      "infra/loadgen/run.sh": "#!/bin/sh\n# TODO(Part 99): wire up the new generator\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a .sh file must be scanned; got:\n${output}`);
      assert.match(output, /infra\/loadgen\/run\.sh has TODO\(Part 99\)/);
    },
  );
});

test("check 3 (todos) — a TODO string embedded inside a .json value is still scanned and caught", () => {
  // JSON has no comment syntax, so a lingering TODO can only live inside a string value (e.g. a
  // dashboard panel description). The scan is a dumb regex over file bytes, so this must still match
  // — proving the .json extension add isn't vacuous (matching the extension list but never actually
  // finding anything because real .json files never contain the substring in a way the regex sees).
  withFixture(
    {
      "infra/grafana/dashboards/fake.json": JSON.stringify({
        panels: [{ description: "TODO(Block 99.3): replace this stub panel" }],
      }),
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a TODO inside a JSON string value must be caught; got:\n${output}`);
      assert.match(output, /infra\/grafana\/dashboards\/fake\.json has TODO\(Block 99\.3\)/);
    },
  );
});

test("check 3 (todos) — the root Makefile itself is scanned", () => {
  withFixture(
    {
      Makefile: "demo:\n\t# TODO(Block 99.4): wire the real compose command\n\techo hi\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `the root Makefile must be scanned; got:\n${output}`);
      assert.match(output, /\[todos\] Makefile has TODO\(Block 99\.4\)/);
    },
  );
});

test("check 3 (todos) — a Makefile nested under apps/packages/infra is also scanned, not just the root one", () => {
  // TODO_BEARING_FILE matches `^Makefile$` against entry.name during the directory walk, which also
  // catches a nested Makefile — this is not exclusive to the hand-added root entry.
  withFixture(
    {
      "apps/indexer/Makefile": "run:\n\t# TODO(Block 99.5): local dev shortcut\n\techo hi\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1, `a nested Makefile must be scanned; got:\n${output}`);
      assert.match(output, /apps\/indexer\/Makefile has TODO\(Block 99\.5\)/);
    },
  );
});

test("check 3 (todos) — a file merely named similarly to Makefile ('notMakefile') is not scanned", () => {
  // TODO_BEARING_FILE's Makefile branch is anchored (`^Makefile$`), not a substring test. A file that
  // merely contains "Makefile" in its name and has no recognised extension must be left alone.
  withFixture(
    {
      "apps/indexer/notMakefile": "# TODO(Phase 9): this must not be seen\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `a file named 'notMakefile' is not the Makefile and must not be scanned; got:\n${output}`,
      );
    },
  );
});

test("check 3 (todos) — a skipped directory's file (node_modules) is never scanned even with a matching extension", () => {
  withFixture(
    {
      "apps/indexer/node_modules/some-pkg/config.yml": "# TODO(Phase 1): vendored, ignore\n",
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `node_modules must be skipped regardless of file extension; got:\n${output}`,
      );
    },
  );
});

test("check 3 (todos) — every named skip directory (dist/lib/out/cache/.next) is honoured, not just node_modules", () => {
  withFixture(
    {
      "apps/web/.next/cache/x.json": '{"note":"TODO(Phase 1): build artifact"}',
      "apps/web/dist/x.yml": "# TODO(Phase 1): build artifact",
      "apps/indexer/lib/x.toml": "# TODO(Phase 1): build artifact",
      "apps/indexer/out/x.sh": "# TODO(Phase 1): build artifact",
      "packages/contracts/cache/x.json": '{"note":"TODO(Phase 1): build artifact"}',
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(
        status,
        0,
        `every one of dist/lib/out/cache/.next must be skipped; got:\n${output}`,
      );
    },
  );
});

test("check 2b (lock) — a genuinely unlocked trigger (no lock clause at all) is reported, not swallowed as unparseable", () => {
  // Found while writing the canary above: normaliseLock() returns "" for a legitimate "no lock
  // clause" reading, but docs-check.mjs's original `if (!actualLock)` treated that identically to
  // `actual === null` ("the SELECT wasn't found at all"). Empty string is falsy in JS, so the moment
  // the trigger's account read has genuinely no lock — e.g. a regression that silently drops
  // FOR NO KEY UPDATE, exactly the class of bug ADR-0017 exists to prevent — the check printed the
  // generic "could not read the account lock clause" message and skipped the entire per-doc
  // comparison, never naming which docs were wrong. Fixed in the same commit as this test by checking
  // `actual === null` instead of `!actualLock`.
  withFixture(
    {
      [TRIGGER_MIGRATION_PATH]: triggerMigrationSource(""), // the up() copy itself carries no lock
      "docs/extra.md": docShowingLock(REAL_LOCK_CLAUSE), // doc still claims FOR NO KEY UPDATE
    },
    (root) => {
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.match(
        output,
        /docs\/extra\.md shows the balance trigger reading ledger_accounts FOR NO KEY UPDATE, but it takes no lock/,
        `an unlocked trigger must be compared per-doc, not reported as unparseable; got:\n${output}`,
      );
      assert.doesNotMatch(output, /could not read the account lock clause/);
    },
  );
});
