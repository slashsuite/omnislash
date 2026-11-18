import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  encodeCwd,
  claudeProjectDir,
  sumSessionTokens,
  formatTokens,
  zeroUsage,
  sessionTokens,
  latestSessionID,
  defaultOpencodeDbPath,
  readOpencodeSpinoffTokens,
  rootOpencodeSessionId,
  capturedOpencodeSessionId,
  parseOpencodeApiSessionList,
  readOpencodeSessionWeight,
} from "../src/spinoff-tokens.ts";

// A single assistant transcript event carrying a usage block, as Claude Code writes it.
const assistantEvent = (u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): string => JSON.stringify({ type: "assistant", message: { role: "assistant", usage: u } });

describe("encodeCwd — Claude Code project-dir naming", () => {
  test("replaces every '/' and '.' with '-' (leading slash becomes leading dash)", () => {
    expect(encodeCwd("/Users/j/dev/acme.build-55-x")).toBe("-Users-j-dev-acme-build-55-x");
  });
  test("claudeProjectDir joins the base dir with the encoded cwd", () => {
    expect(claudeProjectDir("/base", "/w.t")).toBe(join("/base", "-w-t"));
  });
});

describe("formatTokens — compact human formatting", () => {
  test("null/zero/negative render as a dash", () => {
    expect(formatTokens(null)).toBe("-");
    expect(formatTokens(0)).toBe("-");
    expect(formatTokens(undefined)).toBe("-");
  });
  test("thousands and millions", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(106_500)).toBe("106.5k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

describe("sumSessionTokens — sum a worktree's session transcripts", () => {
  let base: string;
  const worktree = "/Users/j/dev/acme.build-55-x";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ob-tok-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const seed = (files: Record<string, string>) => {
    const dir = claudeProjectDir(base, worktree);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  };

  test("missing project dir returns zeros", () => {
    expect(sumSessionTokens(base, worktree)).toEqual(zeroUsage());
  });

  test("sums usage across all assistant events in a single session file", () => {
    seed({
      "sess-a.jsonl": [
        assistantEvent({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 }),
        JSON.stringify({ type: "user", message: { role: "user" } }), // no usage — ignored
        assistantEvent({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 }),
      ].join("\n"),
    });
    expect(sumSessionTokens(base, worktree)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheCreationTokens: 5,
      cacheReadTokens: 1200,
      totalTokens: 1385,
    });
  });

  test("sums across ALL *.jsonl files in the dir (per-branch worktree may host >1 session)", () => {
    seed({
      "sess-a.jsonl": assistantEvent({ input_tokens: 100, output_tokens: 10 }),
      "sess-b.jsonl": assistantEvent({ input_tokens: 200, output_tokens: 20 }),
      "notes.txt": "ignored — not a jsonl file",
    });
    const u = sumSessionTokens(base, worktree);
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(30);
    expect(u.totalTokens).toBe(330);
  });

  test("skips malformed lines and non-assistant events; returns zeros when nothing usable", () => {
    seed({
      "sess-a.jsonl": ["", "not json at all", "{ broken", JSON.stringify({ type: "system" })].join("\n"),
    });
    expect(sumSessionTokens(base, worktree)).toEqual(zeroUsage());
  });

  test("missing usage fields are treated as 0 (partial usage blocks)", () => {
    seed({ "sess-a.jsonl": assistantEvent({ input_tokens: 42 }) });
    expect(sumSessionTokens(base, worktree)).toEqual({
      inputTokens: 42,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 42,
    });
  });
});

// #142: the per-SESSION variant. `sumSessionTokens` sums every transcript in the project dir, which for
// an architect (whose cwd is the repo root) is an all-time repo total rather than a session total. These read
// one session instead.
describe("sessionTokens / latestSessionID: one session, not the whole repo dir", () => {
  let base: string;
  const worktree = "/Users/j/dev/acme";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ob-tok-sess-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const seed = (files: Record<string, string>) => {
    const dir = claudeProjectDir(base, worktree);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  };

  test("sums ONLY the named session, where sumSessionTokens sums both", () => {
    seed({
      "sess-a.jsonl": assistantEvent({ input_tokens: 100 }),
      "sess-b.jsonl": assistantEvent({ input_tokens: 200 }),
    });
    expect(sessionTokens(base, worktree, "sess-a").totalTokens).toBe(100);
    expect(sumSessionTokens(base, worktree).totalTokens).toBe(300);
  });

  test("an unknown session id, or a missing dir, is zeros rather than a throw", () => {
    seed({ "sess-a.jsonl": assistantEvent({ input_tokens: 100 }) });
    expect(sessionTokens(base, worktree, "nope")).toEqual(zeroUsage());
    expect(sessionTokens(join(base, "absent"), worktree, "sess-a")).toEqual(zeroUsage());
  });

  test("latestSessionID picks the most recently written transcript", () => {
    seed({
      "sess-a.jsonl": assistantEvent({ input_tokens: 100 }),
      "sess-b.jsonl": assistantEvent({ input_tokens: 200 }),
    });
    const dir = claudeProjectDir(base, worktree);
    utimesSync(join(dir, "sess-a.jsonl"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(join(dir, "sess-b.jsonl"), new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    expect(latestSessionID(base, worktree)).toBe("sess-b");
  });

  test("latestSessionID is null when there is no project dir at all", () => {
    expect(latestSessionID(join(base, "absent"), worktree)).toBeNull();
  });
});

describe("defaultOpencodeDbPath — where the opencode reader looks", () => {
  test("the env override wins when non-empty", () => {
    expect(defaultOpencodeDbPath("/h", { OMNISLASH_OPENCODE_DB_PATH: "/override/opencode.db" })).toBe("/override/opencode.db");
  });

  test("an empty override falls through to XDG_DATA_HOME, then the home fallback", () => {
    const env = { OMNISLASH_OPENCODE_DB_PATH: "" };
    expect(defaultOpencodeDbPath("/h", { ...env, XDG_DATA_HOME: "/xdg" })).toBe("/xdg/opencode/opencode.db");
    expect(defaultOpencodeDbPath("/h", env)).toBe("/h/.local/share/opencode/opencode.db");
  });
});

// 0023: the opencode engine's token reader. opencode keeps no ~/.claude/projects jsonl — its totals live
// in its own SQLite `session` table, keyed by the session's absolute `directory`, as SUM-able columns.
// The reader must return the same TokenUsage shape as the claude reader, and read zeros (not throw) when
// the engine is wrong for the machine, so a drain never fails on a foreign transcript source.
describe("readOpencodeSpinoffTokens — sum a worktree's opencode sessions", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-opencode-"));
    dbPath = join(dir, "opencode.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fixture opencode.db with the session table the reader queries, and a seeder for its rows. */
  const seed = (rows: Array<{ directory: string; input: number; output: number; cache_write: number; cache_read: number }>) => {
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE session (
         id TEXT PRIMARY KEY,
         directory TEXT,
         tokens_input INTEGER,
         tokens_output INTEGER,
         tokens_cache_write INTEGER,
         tokens_cache_read INTEGER
       )`,
    );
    const insert = db.prepare(
      `INSERT INTO session (id, directory, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((r, i) => insert.run(`sess-${i}`, r.directory, r.input, r.output, r.cache_write, r.cache_read));
    db.close();
  };

  const worktree = "/Users/j/dev/acme.build-opencode-x";

  test("a missing db is zeros rather than a throw (wrong engine, wrong machine)", () => {
    expect(readOpencodeSpinoffTokens(worktree, join(dir, "absent.db"))).toEqual(zeroUsage());
  });

  test("a db with no rows for the directory is zeros", () => {
    seed([{ directory: "/some/other/worktree", input: 100, output: 10, cache_write: 5, cache_read: 1000 }]);
    expect(readOpencodeSpinoffTokens(worktree, dbPath)).toEqual(zeroUsage());
  });

  test("sums the four buckets across every session in the directory (mapped one-for-one)", () => {
    seed([
      { directory: worktree, input: 100, output: 20, cache_write: 5, cache_read: 1000 },
      { directory: worktree, input: 50, output: 10, cache_write: 0, cache_read: 200 },
    ]);
    expect(readOpencodeSpinoffTokens(worktree, dbPath)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheCreationTokens: 5, // tokens_cache_write -> cacheCreation
      cacheReadTokens: 1200, // tokens_cache_read -> cacheRead
      totalTokens: 1385,
    });
  });

  test("ignores sessions in OTHER directories", () => {
    seed([
      { directory: worktree, input: 40, output: 4, cache_write: 0, cache_read: 0 },
      { directory: "/elsewhere", input: 999, output: 999, cache_write: 999, cache_read: 999 },
    ]);
    expect(readOpencodeSpinoffTokens(worktree, dbPath).totalTokens).toBe(44);
  });

  test("matches the directory via realpath too, so a /tmp vs /private/tmp spelling is one worktree", () => {
    const target = mkdtempSync(join(tmpdir(), "ob-opencode-wt-"));
    const link = join(dir, "wt-link");
    symlinkSync(target, link, "dir");
    // The row is keyed to the CANONICAL target; the query comes in under the SYMLINK spelling.
    seed([{ directory: realpathSync(target), input: 60, output: 6, cache_write: 0, cache_read: 0 }]);
    expect(readOpencodeSpinoffTokens(link, dbPath).totalTokens).toBe(66);
    rmSync(target, { recursive: true, force: true });
  });
});

// 384: capture the unique ROOT opencode session for a directory so a tab can resume via --session
// rather than --continue. Children (parent_id set), archived rows, and a second root all refuse:
// 0 or >1 matches is null, never a guess.
describe("rootOpencodeSessionId — unique root, or null", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-opencode-root-"));
    dbPath = join(dir, "opencode.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (
    rows: Array<{
      id: string;
      directory: string;
      parent_id?: string | null;
      time_archived?: number | null;
      time_created?: number;
    }>,
  ) => {
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE session (
         id TEXT PRIMARY KEY,
         directory TEXT,
         parent_id TEXT,
         time_archived INTEGER,
         time_created INTEGER
       )`,
    );
    const insert = db.prepare(
      `INSERT INTO session (id, directory, parent_id, time_archived, time_created) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(r.id, r.directory, r.parent_id ?? null, r.time_archived ?? null, r.time_created ?? 0);
    }
    db.close();
  };

  const worktree = "/Users/j/dev/acme.build-384";

  test("a missing db is null rather than a throw", () => {
    expect(rootOpencodeSessionId(worktree, { dbPath: join(dir, "absent.db") })).toBeNull();
  });

  test("no rows for the directory is null", () => {
    seed([{ id: "ses_other", directory: "/elsewhere" }]);
    expect(rootOpencodeSessionId(worktree, { dbPath })).toBeNull();
  });

  test("the unique root is that id", () => {
    seed([
      { id: "ses_root", directory: worktree },
      { id: "ses_child", directory: worktree, parent_id: "ses_root" },
    ]);
    expect(rootOpencodeSessionId(worktree, { dbPath })).toBe("ses_root");
  });

  test("parent_id children never count as the root, even when they are the only row", () => {
    seed([{ id: "ses_child", directory: worktree, parent_id: "ses_someone" }]);
    expect(rootOpencodeSessionId(worktree, { dbPath })).toBeNull();
  });

  test("two roots is null — do not guess", () => {
    seed([
      { id: "ses_a", directory: worktree },
      { id: "ses_b", directory: worktree },
    ]);
    expect(rootOpencodeSessionId(worktree, { dbPath })).toBeNull();
  });

  test("an archived root is ignored, so the live one can still be unique", () => {
    seed([
      { id: "ses_old", directory: worktree, time_archived: 1 },
      { id: "ses_live", directory: worktree },
    ]);
    expect(rootOpencodeSessionId(worktree, { dbPath })).toBe("ses_live");
  });

  test("notBeforeMs drops roots created before the launch", () => {
    seed([
      { id: "ses_old", directory: worktree, time_created: 1000 },
      { id: "ses_new", directory: worktree, time_created: 5000 },
    ]);
    expect(rootOpencodeSessionId(worktree, { dbPath, notBeforeMs: 4000 })).toBe("ses_new");
    expect(rootOpencodeSessionId(worktree, { dbPath, notBeforeMs: 1000 })).toBeNull();
  });

  test("excludeIds drops known ids so a leftover root does not collide", () => {
    seed([
      { id: "ses_keep", directory: worktree },
      { id: "ses_skip", directory: worktree },
    ]);
    expect(rootOpencodeSessionId(worktree, { dbPath, excludeIds: ["ses_skip"] })).toBe("ses_keep");
  });

  test("matches the directory via realpath too", () => {
    const target = mkdtempSync(join(tmpdir(), "ob-opencode-root-wt-"));
    const link = join(dir, "wt-link");
    symlinkSync(target, link, "dir");
    seed([{ id: "ses_real", directory: realpathSync(target) }]);
    expect(rootOpencodeSessionId(link, { dbPath })).toBe("ses_real");
    rmSync(target, { recursive: true, force: true });
  });
});

describe("capturedOpencodeSessionId — sqlite plus the OpenCode API (932)", () => {
  const dir = "/home/owner/dev/acme";
  const live = {
    id: "ses_live",
    directory: dir,
    agent: "architect",
    timeCreated: 5000,
    parentId: null,
  };

  test("the API session is the one when sqlite has no root since the launch", () => {
    expect(
      capturedOpencodeSessionId(dir, {
        notBeforeMs: 4000,
        kind: "architect",
        dbPath: "/no/such/opencode.db",
        apiSessions: [live, { ...live, id: "ses_old", timeCreated: 1000 }, { ...live, id: "ses_build", agent: "build", timeCreated: 6000 }],
      }),
    ).toBe("ses_live");
  });

  test("0 or more than 1 architect candidates since the launch stay null", () => {
    expect(
      capturedOpencodeSessionId(dir, {
        notBeforeMs: 4000,
        kind: "architect",
        dbPath: "/no/such/opencode.db",
        apiSessions: [],
      }),
    ).toBeNull();
    expect(
      capturedOpencodeSessionId(dir, {
        notBeforeMs: 1000,
        kind: "architect",
        dbPath: "/no/such/opencode.db",
        apiSessions: [live, { ...live, id: "ses_other", timeCreated: 2000 }],
      }),
    ).toBeNull();
  });

  test("an unreadable API does not invent a session, and a child is not a root", () => {
    expect(
      capturedOpencodeSessionId(dir, {
        kind: "architect",
        dbPath: "/no/such/opencode.db",
        apiSessions: null,
      }),
    ).toBeNull();
    expect(
      capturedOpencodeSessionId(dir, {
        kind: "architect",
        dbPath: "/no/such/opencode.db",
        apiSessions: [{ ...live, parentId: "ses_parent" }],
      }),
    ).toBeNull();
  });

  test("parse keeps an architect session from the API wrapper and refuses garbage", () => {
    const parsed = parseOpencodeApiSessionList(
      JSON.stringify({ data: [{ id: "ses_live", agent: "architect", time: { created: 9 }, location: { directory: dir } }] }),
    );
    expect(parsed).toEqual([{ id: "ses_live", directory: dir, agent: "architect", timeCreated: 9, parentId: null }]);
    expect(parseOpencodeApiSessionList("not json")).toBeNull();
  });
});

// 518: the architect checkpoint weighs ONE opencode session (the latest non-archived root), not the SUM
// of every tab on the checkout, and missing db is UNREADABLE (null) rather than a confident 0.
describe("readOpencodeSessionWeight — last completed assistant, not session.tokens_* (545)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-opencode-weight-"));
    dbPath = join(dir, "opencode.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (
    rows: Array<{
      id: string;
      directory: string;
      parent_id?: string | null;
      time_archived?: number | null;
      time_created?: number;
      time_updated?: number;
      input?: number;
      output?: number;
      cache_write?: number;
      cache_read?: number;
    }>,
    messages: Array<{
      id: string;
      session_id: string;
      data: string;
      time_created?: number;
    }> = [],
  ) => {
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE session (
         id TEXT PRIMARY KEY,
         directory TEXT,
         parent_id TEXT,
         time_archived INTEGER,
         time_created INTEGER,
         time_updated INTEGER,
         tokens_input INTEGER,
         tokens_output INTEGER,
         tokens_cache_write INTEGER,
         tokens_cache_read INTEGER
       );
       CREATE TABLE message (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL,
         time_updated INTEGER NOT NULL,
         data TEXT NOT NULL
       )`,
    );
    const insert = db.prepare(
      `INSERT INTO session (id, directory, parent_id, time_archived, time_created, time_updated,
                            tokens_input, tokens_output, tokens_cache_write, tokens_cache_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.directory,
        r.parent_id ?? null,
        r.time_archived ?? null,
        r.time_created ?? 0,
        r.time_updated ?? r.time_created ?? 0,
        r.input ?? 0,
        r.output ?? 0,
        r.cache_write ?? 0,
        r.cache_read ?? 0,
      );
    }
    const insertMsg = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const m of messages) {
      const t = m.time_created ?? 1000;
      insertMsg.run(m.id, m.session_id, t, t, m.data);
    }
    db.close();
  };

  const completedAssistant = (opts: {
    total: number;
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    completed?: number;
  }): string =>
    JSON.stringify({
      role: "assistant",
      time: { created: 1, completed: opts.completed ?? 1000 },
      tokens: {
        total: opts.total,
        input: opts.input ?? 0,
        output: 0,
        cache: { write: opts.cacheWrite ?? 0, read: opts.cacheRead ?? 0 },
      },
    });

  const worktree = "/Users/j/dev/acme";

  test("a missing db is null rather than a confident 0", () => {
    expect(readOpencodeSessionWeight(worktree, { dbPath: join(dir, "absent.db") })).toBeNull();
  });

  test("no rows for the directory is null", () => {
    seed([{ id: "ses_other", directory: "/elsewhere", input: 100 }]);
    expect(readOpencodeSessionWeight(worktree, { dbPath })).toBeNull();
  });

  test("weighs the last completed assistant, not session.tokens_* (545)", () => {
    seed(
      [
        {
          id: "ses_root",
          directory: worktree,
          input: 334_000,
          output: 1,
          cache_write: 1,
          cache_read: 2_000_000,
          time_updated: 5000,
        },
        {
          id: "ses_child",
          directory: worktree,
          parent_id: "ses_root",
          input: 999,
          output: 999,
          cache_write: 999,
          cache_read: 999,
          time_updated: 9000,
        },
      ],
      [
        {
          id: "msg_old",
          session_id: "ses_root",
          time_created: 1000,
          data: completedAssistant({ total: 9_000, input: 100, cacheRead: 8_000, completed: 1000 }),
        },
        {
          id: "msg_last",
          session_id: "ses_root",
          time_created: 2000,
          data: completedAssistant({
            total: 81_000,
            input: 3_000,
            cacheRead: 96_000,
            cacheWrite: 1_000,
            completed: 5000,
          }),
        },
        {
          id: "msg_child",
          session_id: "ses_child",
          time_created: 9000,
          data: completedAssistant({ total: 9_999_999, input: 1, cacheRead: 1, completed: 9000 }),
        },
      ],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath })).toEqual({
      session_id: "ses_root",
      total_tokens: 81_000,
      context_tokens: 3_000 + 96_000 + 1_000,
      turns: 0,
      last_at: new Date(5000).toISOString(),
    });
  });

  test("no completed assistant is UNREADABLE even when the session row has tokens", () => {
    seed(
      [{ id: "ses_root", directory: worktree, cache_read: 2_000_000 }],
      [
        {
          id: "msg_user",
          session_id: "ses_root",
          data: JSON.stringify({ role: "user", time: { created: 1, completed: 2 } }),
        },
        {
          id: "msg_open",
          session_id: "ses_root",
          time_created: 2,
          data: JSON.stringify({
            role: "assistant",
            time: { created: 1 },
            tokens: { total: 81_000, input: 1, cache: { read: 1, write: 0 } },
          }),
        },
      ],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath })).toBeNull();
  });

  test("unparseable assistant data is UNREADABLE, never a confident 0", () => {
    seed(
      [{ id: "ses_root", directory: worktree, cache_read: 2_000_000 }],
      [{ id: "msg_bad", session_id: "ses_root", data: "not-json{" }],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath })).toBeNull();
  });

  test("completed assistant without tokens.total is UNREADABLE", () => {
    seed(
      [{ id: "ses_root", directory: worktree, input: 10 }],
      [
        {
          id: "msg_notokens",
          session_id: "ses_root",
          data: JSON.stringify({ role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 3 } }),
        },
      ],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath })).toBeNull();
  });

  test("two roots picks the latest by time_updated, not the sum", () => {
    seed(
      [
        { id: "ses_old", directory: worktree, input: 100, output: 10, time_updated: 1000 },
        { id: "ses_new", directory: worktree, input: 7, output: 3, time_updated: 9000 },
      ],
      [
        { id: "msg_old", session_id: "ses_old", data: completedAssistant({ total: 110 }) },
        { id: "msg_new", session_id: "ses_new", data: completedAssistant({ total: 10 }) },
      ],
    );
    const weight = readOpencodeSessionWeight(worktree, { dbPath });
    expect(weight?.session_id).toBe("ses_new");
    expect(weight?.total_tokens).toBe(10);
  });

  test("an archived root is ignored even when it is newer", () => {
    seed(
      [
        { id: "ses_live", directory: worktree, input: 4, output: 1, time_updated: 1000 },
        { id: "ses_archived", directory: worktree, input: 999, output: 999, time_archived: 1, time_updated: 9000 },
      ],
      [
        { id: "msg_live", session_id: "ses_live", data: completedAssistant({ total: 5 }) },
        { id: "msg_arch", session_id: "ses_archived", data: completedAssistant({ total: 1998 }) },
      ],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath })?.session_id).toBe("ses_live");
  });

  test("a named session id is used even when it is not the latest root", () => {
    seed(
      [
        { id: "ses_keep", directory: worktree, input: 2, output: 1, time_updated: 1000 },
        { id: "ses_new", directory: worktree, input: 50, output: 5, time_updated: 9000 },
      ],
      [
        { id: "msg_keep", session_id: "ses_keep", data: completedAssistant({ total: 3 }) },
        { id: "msg_new", session_id: "ses_new", data: completedAssistant({ total: 55 }) },
      ],
    );
    expect(readOpencodeSessionWeight(worktree, { dbPath, sessionID: "ses_keep" })?.total_tokens).toBe(3);
  });

  test("a named id in another directory is null", () => {
    seed([{ id: "ses_else", directory: "/elsewhere", input: 8 }]);
    expect(readOpencodeSessionWeight(worktree, { dbPath, sessionID: "ses_else" })).toBeNull();
  });

  test("matches the directory via realpath too", () => {
    const target = mkdtempSync(join(tmpdir(), "ob-opencode-weight-wt-"));
    const link = join(dir, "wt-link");
    symlinkSync(target, link, "dir");
    seed(
      [{ id: "ses_real", directory: realpathSync(target), input: 11, output: 1, time_updated: 1000 }],
      [{ id: "msg_real", session_id: "ses_real", data: completedAssistant({ total: 12, input: 11 }) }],
    );
    expect(readOpencodeSessionWeight(link, { dbPath })?.total_tokens).toBe(12);
    rmSync(target, { recursive: true, force: true });
  });
});
