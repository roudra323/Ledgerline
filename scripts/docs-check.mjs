#!/usr/bin/env node
/**
 * docs:check — fails when a document contradicts the thing that actually enforces it.
 *
 * `CLAUDE.md`'s "Where facts live" table says every fact has exactly one owning file, and that for
 * anything the database enforces, the migration is the owner and every doc is a description of it.
 * That rule is only worth writing down if something checks it: the 2026-09-06 audit found the
 * chart of accounts and the ledger `kind` list each copied into three prose docs, with the copies
 * already diverged from the schema.
 *
 * Every assertion below corresponds to a divergence that actually happened. Add one whenever a new
 * fact acquires a second copy.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO_ROOT, "apps/indexer/src/migrations");
const POINTER_FILE_MAX_BYTES = 1200;

const failures = [];

/** Records a failure with the owning file, so the reader knows which side to change. */
function fail(check, message, owner) {
  failures.push({ check, message, owner });
}

function read(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** All matches of a single-capture-group regex, deduplicated, in source order. */
function captureAll(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

/**
 * The lines of a markdown section, from its heading to the next heading of the same or higher
 * level. Used to scope table parsing so an unrelated table elsewhere in the file can't match.
 */
function sectionLines(markdown, headingText) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.includes(headingText) && line.startsWith("#"));
  if (start === -1) return null;
  const depth = (lines[start].match(/^#+/) ?? ["#"])[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => /^#+ /.test(line) && (line.match(/^#+/) ?? [""])[0].length <= depth,
  );
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Ledger kinds named by posting samples in a markdown file.
 *
 * Scoped to fenced blocks that are actually postings — one carrying a `cause:` or calling
 * `ledger.post(` — because `kind:` on its own is ordinary TypeScript and appears in docs describing
 * unrelated discriminated unions. Quote style is not the discriminator; the surrounding block is.
 */
function postingKindsIn(markdown) {
  const kinds = [];
  for (const block of markdown.matchAll(/```[\s\S]*?```/g)) {
    const fenced = block[0];
    if (!/cause:|ledger\.post\(/.test(fenced)) continue;
    kinds.push(...captureAll(fenced, /kind:\s*["']([^"']+)["']/g));
  }
  return kinds;
}

/** Four-digit account codes in the first cell of each markdown table row. */
function accountCodesInTable(lines) {
  const codes = new Set();
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const code of firstCell.matchAll(/\b(\d{4})\b/g)) codes.add(code[1]);
  }
  return codes;
}

/** The migration that most recently defines a fact wins — migrations are ordered by filename. */
function newestMigrationDefining(pattern) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  for (const name of [...files].reverse()) {
    const source = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    if (pattern.test(source)) return { name, source };
  }
  return null;
}

// ── 1. Ledger transaction kinds: the CHECK constraint owns them ──────────────────────────────────

const KIND_CHECK_PATTERN = /ledger_transactions[\s\S]{0,2000}?kind\s+IN\s*\(/i;
const kindMigration = newestMigrationDefining(KIND_CHECK_PATTERN);
if (!kindMigration) {
  fail("kinds", "no migration defines a `kind IN (...)` CHECK", "apps/indexer/src/migrations/");
} else {
  // Anchored on the table name for the same reason the search above is: an unrelated `kind IN (...)`
  // elsewhere in the file must not be mistaken for ledger_transactions' constraint.
  const checkList = kindMigration.source.match(
    /ledger_transactions[\s\S]{0,2000}?kind\s+IN\s*\(([^)]*)\)/i,
  )[1];
  const schemaKinds = new Set(captureAll(checkList, /'([^']+)'/g));

  const entity = read("apps/indexer/src/ledger/entities/ledger-transaction.entity.ts");
  const unionBody = entity.match(/export type TransactionKind\s*=([\s\S]*?);/);
  const unionKinds = new Set(unionBody ? captureAll(unionBody[1], /"([^"]+)"/g) : []);

  for (const kind of schemaKinds) {
    if (!unionKinds.has(kind)) {
      fail(
        "kinds",
        `'${kind}' is in the CHECK but missing from the TransactionKind union`,
        kindMigration.name,
      );
    }
  }
  for (const kind of unionKinds) {
    if (!schemaKinds.has(kind)) {
      fail(
        "kinds",
        `"${kind}" is in the TransactionKind union but not in the CHECK`,
        kindMigration.name,
      );
    }
  }

  // Two shapes carry a ledger kind in the docs: a posting sample's `kind:`, and the worked example's
  // `T<n>  <kind>` lines. Deliberately narrow — PSP webhook event types (`refund.succeeded`,
  // `payout.paid`) look identical and are a different vocabulary, and a bare `kind:` also appears in
  // unrelated TypeScript (`{ kind: 'live' | 'backfill' }` in conventions.md §3), which is why the
  // scan below requires the surrounding fenced block to actually be a posting.
  for (const file of readdirSync(join(REPO_ROOT, "docs")).filter((name) => name.endsWith(".md"))) {
    const markdown = read(join("docs", file));
    const documented = [
      ...postingKindsIn(markdown),
      ...captureAll(markdown, /^T\d+ +([a-z_][a-z_.]*)/gm),
    ];
    for (const kind of documented) {
      if (!schemaKinds.has(kind)) {
        fail(
          "kinds",
          `docs/${file} posts kind '${kind}', which the CHECK rejects`,
          kindMigration.name,
        );
      }
    }
  }
}

// ── 2. Chart of accounts: the seeding migration + the merchant registry own the codes ────────────

const accountsMigration = newestMigrationDefining(/INSERT INTO ledger_accounts/);
if (!accountsMigration) {
  fail("accounts", "no migration seeds ledger_accounts", "apps/indexer/src/migrations/");
} else {
  const seeded = new Set(captureAll(accountsMigration.source, /\(\s*'(\d{4})'\s*,/g));
  const registry = read("apps/indexer/src/ledger/account-registry.service.ts");
  for (const code of captureAll(registry, /"(\d{4})":\s*\{/g)) seeded.add(code);

  const documentedTables = [
    ["docs/architecture.md", "Chart of accounts"],
    ["docs/ARCHITECTURE-WALKTHROUGH.md", "The accounts"],
  ];
  for (const [path, heading] of documentedTables) {
    const lines = sectionLines(read(path), heading);
    if (!lines) {
      fail("accounts", `${path} has no "${heading}" section to check`, accountsMigration.name);
      continue;
    }
    for (const code of accountCodesInTable(lines)) {
      if (!seeded.has(code)) {
        fail(
          "accounts",
          `${path} documents account ${code}, which nothing creates`,
          accountsMigration.name,
        );
      }
    }
  }
}

// ── 3. TODO(Block N.M) markers must name a block that exists ─────────────────────────────────────

const progress = read("docs/progress.md");
const knownBlocks = new Set(captureAll(progress, /^\|\s*(\d+\.\d+)\s*\|/gm));
// A stub standing in for a whole part (an unwritten module) may name the part instead of a block.
const knownParts = new Set([...knownBlocks].map((block) => block.split(".")[0]));

function* sourceFiles(dir) {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "lib") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|sol|mjs)$/.test(entry.name)) yield path;
  }
}

for (const dir of ["apps", "packages", "infra"]) {
  for (const path of sourceFiles(dir)) {
    const source = read(path);
    for (const block of captureAll(source, /TODO\(Block (\d+\.\d+)\)/g)) {
      if (!knownBlocks.has(block)) {
        fail(
          "todos",
          `${path} has TODO(Block ${block}), which is not a block in progress.md`,
          "docs/progress.md",
        );
      }
    }
    for (const part of captureAll(source, /TODO\(Part (\d+)\)/g)) {
      if (!knownParts.has(part)) {
        fail(
          "todos",
          `${path} has TODO(Part ${part}), which is not a part in progress.md`,
          "docs/progress.md",
        );
      }
    }
    for (const phase of captureAll(source, /TODO\((Phase [^)]+)\)/g)) {
      fail(
        "todos",
        `${path} still uses TODO(${phase}) — markers name a Block N.M or a Part N`,
        "CLAUDE.md",
      );
    }
  }
}

// ── 4. Health-check commands in the tracker must be real scripts ─────────────────────────────────

const rootScripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts));
const healthLines = sectionLines(progress, "Health check") ?? [];
for (const line of healthLines) {
  for (const script of captureAll(line, /`pnpm ([a-z:_-]+)`/g)) {
    if (!rootScripts.has(script)) {
      fail(
        "scripts",
        `progress.md's health check says \`pnpm ${script}\`, which is not a root script`,
        "package.json",
      );
    }
  }
}

// ── 5. The pointer files must stay pointers ──────────────────────────────────────────────────────

for (const path of ["AGENTS.md", ".agents/rules/conventions.md"]) {
  const source = read(path);
  if (!source.includes("ssot:pointer-only")) {
    fail("ssot", `${path} lost its ssot:pointer-only marker`, "CLAUDE.md");
  }
  if (Buffer.byteLength(source) > POINTER_FILE_MAX_BYTES) {
    fail(
      "ssot",
      `${path} is ${Buffer.byteLength(source)} bytes (max ${POINTER_FILE_MAX_BYTES}) — it is regrowing into a second rulebook`,
      "CLAUDE.md",
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log("docs:check — docs and schema agree");
  process.exit(0);
}

console.error(`docs:check — ${failures.length} divergence(s):\n`);
for (const { check, message, owner } of failures) {
  console.error(`  [${check}] ${message}`);
  console.error(
    `      owner: ${owner} — change the doc, not the owner, unless the owner is wrong\n`,
  );
}
process.exit(1);
