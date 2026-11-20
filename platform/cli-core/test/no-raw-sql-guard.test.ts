import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// The rule: database access goes through Drizzle's `orm()` builder; no raw SQL in app queries.
// Named exceptions: FTS5 `MATCH` and the hand-kept `*_fts` tables stay raw `sql`, and `excluded.*`
// upsert sets use `sql` fragments.
//
// This guard reads every non-test `.ts`/`.tsx` source file under apps/cli/src, apps/ob-dashboard/src and
// platform/*/src with the TypeScript parser (so comments never count) and reports:
//   1. a string or template literal, not tagged `sql`, whose text starts with a SQL statement;
//   2. any `sql.raw(...)` call, and any `.unsafe(...)` call (postgres.js runs its string as raw SQL);
//   3. a `sql`-tagged template that starts with a statement and names no `*_fts` table.
// A `sql` fragment that is not a whole statement (an `excluded.*` set, a `COALESCE`) is not reported.
//
// Files that legitimately hold raw SQL (opening the database, pragmas, the migration runners, the export
// tool, schema introspection, reads of databases ob does not own) are listed in EXEMPT with a reason.
// An exemption whose file is gone, or no longer holds any raw SQL, fails the guard as stale.
//
// What it cannot catch: SQL held in a variable or built by concatenation and passed to a call (only
// literals and the call names above are read), and SQL a dependency builds. It is a tripwire for the
// common shape, not a proof.

const REPO = join(import.meta.dir, "../../..");

const EXEMPT: Record<string, string> = {
  "apps/cli/src/db.ts":
    "opens the SQLite database: pragmas, the legacy schema chain, the migration runner and its bookkeeping table",
  "apps/cli/src/db/pg/migrate.ts": "the Postgres migration runner: bookkeeping, advisory lock, lock_timeout, catalog probes",
  "apps/cli/src/db/pg/schema.ts": "schema definition: sql.raw builds the generated tsvector column and trigram index expressions",
  "apps/cli/src/db/store.ts": "the Postgres store's notify(): pg_notify on a validated channel name",
  "apps/cli/src/db/fingerprint.ts": "schema introspection (sqlite_master, PRAGMA table_info) for the schema fingerprint",
  "apps/cli/src/pgexport.ts": "the SQLite to Postgres export tool: catalog reads, bulk copy, sequence resets",
  "apps/cli/src/commands/pgexport.ts": "the export command runs the statements the export tool produced",
  "apps/cli/src/remote.ts": "sets PRAGMA busy_timeout on the connection before an orm() read",
  "apps/cli/src/role-end.ts": "reads T3's own state database, which ob does not own",
  "apps/cli/src/t3/surface-probe.ts": "probe script reading OpenCode's own database, which ob does not own",
  "platform/cli-coord/src/spinoff-tokens.ts": "reads OpenCode's own database (session, message) for token counts",
  "platform/cli-whatsapp/src/ingest/whatsapp.ts": "reads the WhatsApp bridge's own database (messages, whatsmeow tables)",
  "platform/cli-whatsapp/src/whatsapp/bridge.ts": "reads the WhatsApp bridge's own database for health checks",
};

// A literal counts as SQL only when it has the shape of a statement, not merely a leading verb, so UI
// and help strings ("Update available", "delete an item", an HTTP "DELETE") are not reported.
const STATEMENT = new RegExp(
  "^\\s*(?:" +
    [
      "SELECT\\s+(?:\\*|\\d|DISTINCT\\b|[\\w.]+\\s*\\(|[\\s\\S]*?\\bFROM\\s+[\\w\"'`$(])",
      "(?:INSERT|REPLACE)\\s+(?:OR\\s+\\w+\\s+)?INTO\\s",
      "UPDATE\\s+[\\w\"`.$]+\\s+SET\\s",
      "DELETE\\s+FROM\\s",
      "CREATE\\s+(?:UNIQUE\\s+|VIRTUAL\\s+|TEMP(?:ORARY)?\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|EXTENSION)\\b",
      "DROP\\s+(?:TABLE|INDEX|VIEW|TRIGGER)\\b",
      "ALTER\\s+TABLE\\b",
      "PRAGMA\\s+\\w",
      "WITH\\s+(?:RECURSIVE\\s+)?[\\w\"]+(?:\\s*\\([^)]*\\))?\\s+AS\\s*\\(",
    ].join("|") +
    ")",
  "i",
);
const FTS_TABLE = /\b\w+_fts\b/;

function sourceRoots(): string[] {
  const roots = [join(REPO, "apps/cli/src"), join(REPO, "apps/ob-dashboard/src")];
  for (const p of readdirSync(join(REPO, "platform"))) roots.push(join(REPO, "platform", p, "src"));
  return roots.filter((r) => existsSync(r) && statSync(r).isDirectory());
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test" || entry === "tests" || entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listSources(full));
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec|stories)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The literal's text, with each `${...}` substitution read as a placeholder identifier. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `x${s.literal.text}`).join("");
  return null;
}

function isSqlTag(node: ts.Node): boolean {
  const parent = node.parent;
  return !!parent && ts.isTaggedTemplateExpression(parent) && parent.template === node && ts.isIdentifier(parent.tag) && parent.tag.text === "sql";
}

/** Each raw SQL site in one file's source, as `line: what`. */
function rawSqlSites(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const sites: string[] = [];
  const at = (n: ts.Node, what: string) => sites.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { name, expression } = node.expression;
      if (name.text === "unsafe") at(node, ".unsafe() call");
      else if (name.text === "raw" && ts.isIdentifier(expression) && expression.text === "sql") at(node, "sql.raw() call");
    }
    const text = literalText(node);
    if (text !== null && STATEMENT.test(text)) {
      if (!isSqlTag(node)) at(node, `SQL statement in a plain string: ${JSON.stringify(text.trim().slice(0, 60))}`);
      else if (!FTS_TABLE.test(text)) at(node, `whole statement in sql tag on a non-FTS table: ${JSON.stringify(text.trim().slice(0, 60))}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe("no raw SQL in app queries outside the named exceptions", () => {
  const files = sourceRoots().flatMap(listSources);
  const found = new Map<string, string[]>();
  for (const f of files) {
    const sites = rawSqlSites(f, readFileSync(f, "utf8"));
    if (sites.length > 0) found.set(relative(REPO, f), sites);
  }

  test("the scan reads source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("no raw SQL outside the exempt files", () => {
    const offenders = [...found]
      .filter(([f]) => !(f in EXEMPT))
      .flatMap(([f, sites]) => sites.map((s) => `${f}:${s}`));
    expect(
      offenders,
      offenders.length
        ? `Raw SQL found. Use orm() (or a sql fragment, or a *_fts table for full text search): ${offenders.join("; ")}`
        : "",
    ).toEqual([]);
  });

  test("every exemption still names a file that holds raw SQL", () => {
    const stale = Object.keys(EXEMPT).filter((f) => !found.has(f));
    expect(stale, stale.length ? `Stale exemptions, remove them from EXEMPT: ${stale.join(", ")}` : "").toEqual([]);
  });

  test("the detector reports raw SQL and spares FTS statements and fragments", () => {
    expect(rawSqlSites("a.ts", 'db.query("SELECT * FROM item")').length).toBeGreaterThan(0);
    expect(rawSqlSites("a.ts", "db.run(sql`DELETE FROM item WHERE id = ${1}`)").length).toBeGreaterThan(0);
    expect(rawSqlSites("a.ts", 'sql.raw("SELECT 1")').length).toBeGreaterThan(0);
    expect(rawSqlSites("a.ts", "client.unsafe(text)").length).toBeGreaterThan(0);
    expect(rawSqlSites("a.ts", "db.run(sql`DELETE FROM item_fts WHERE item_id = ${1}`)")).toEqual([]);
    expect(rawSqlSites("a.ts", "set({ title: sql`excluded.title` })")).toEqual([]);
    expect(rawSqlSites("a.ts", '// db.query("SELECT * FROM item")\nconst m = "DELETE"; const u = "Update available";')).toEqual([]);
  });
});
