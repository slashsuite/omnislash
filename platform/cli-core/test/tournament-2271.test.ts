// OB-2271: `ob tournament` records persona tournaments: add, candidate, record a match file, pick, list, show.
// The local half runs through `runCli` on a throwaway SQLite store; the API half sends the CLI's own requests
// through `createObApi` on a real Postgres store (the ob 325 harness), so the route, the handler and the client
// are one path. Candidates and personas are invented.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { finalistsOf, validateMatchFile, type TournamentMatch, type TournamentView } from "../../../apps/cli/src/tournament.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { RunDeps } from "../../../apps/cli/src/cli.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

const CRITERIA = ["contrast", "warmth"];
const DIR = mkdtempSync(join(tmpdir(), "ob-tournament-2271-"));
let fileN = 0;

function score(a: number, b: number, why = "reads clearly") {
  return { a, b, why };
}

function call(a: string, b: string, winnerId: string, over: Record<string, unknown> = {}) {
  return {
    persona: "nandi",
    model: "sonnet",
    fallback: false,
    order: 1,
    a,
    b,
    winner: winnerId === a ? "A" : "B",
    winnerId,
    why: "the calmer one",
    changes: { [winnerId === a ? b : a]: "lift the contrast" },
    scores: { contrast: score(4, 3), warmth: score(3, 3, "even") },
    ...over,
  };
}

function match(name: string, round: string, x: string, y: string, winner: string, over: Record<string, unknown> = {}) {
  return {
    name,
    round,
    x,
    y,
    winner,
    calls: [call(x, y, winner), call(y, x, winner, { persona: "pieter", order: 2 })],
    ...over,
  };
}

function file(content: unknown): string {
  const p = join(DIR, `m${++fileN}.json`);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

type Run = (args: string[]) => ReturnType<typeof runCli>;

/** The whole flow, on whichever path `run` reaches: Done when 1 and 3. */
async function flow(run: Run): Promise<void> {
  const add = await run(["tournament", "add", "--subject", "Night theme", "--repo", "acme-site", "--criteria", "contrast,warmth", "--ref", "AC-9"]);
  expect(add.code).toBe(0);
  const id = add.out.trim();
  expect(id).toMatch(/^\d+$/);

  const cand = await run(["tournament", "candidate", id, "t1", "--label", "Ink", "--image", "docs/t1.png", "--image", "docs/t1-dark.png"]);
  expect(cand.code).toBe(0);
  expect(cand.out).toContain(`tournament ${id}: candidate t1 (Ink)`);
  expect((await run(["tournament", "candidate", id, "t2"])).code).toBe(0);
  expect((await run(["tournament", "candidate", id, "t2b", "--revises", "t2"])).code).toBe(0);

  // Three matches, a Final and a Rematch; t3 and t4 are not registered and are created by the record.
  for (const m of [
    match("R1-1", "R1", "t1", "t2", "t1"),
    match("R1-2", "R1", "t3", "t4", "t3", { tally: { t3: 1.5, t4: 0.5 } }),
    match("SF-1", "SF", "t1", "t3", "t1"),
    match("Final", "Final", "t1", "t2b", "t1"),
    match("Rematch", "Rematch", "t2b", "t1", "t2b"),
  ]) {
    const r = await run(["tournament", "record", id, "--match", file(m)]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`recorded ${m.round} '${m.name}'`);
  }

  // A repeated name is refused (exit 1) unless --replace, which keeps the match's place.
  const dup = await run(["tournament", "record", id, "--match", file(match("R1-2", "R1", "t3", "t4", "t4"))]);
  expect(dup.code).toBe(1);
  expect(dup.err).toContain("already has match 'R1-2'; pass --replace");
  const rep = await run(["tournament", "record", id, "--match", file(match("R1-2", "R1", "t3", "t4", "t4")), "--replace"]);
  expect(rep.code, rep.err).toBe(0);

  const pick = await run(["tournament", "pick", id, "t2b", "--note", "warmer at night"]);
  expect(pick.code).toBe(0);
  expect(pick.out).toContain(`tournament ${id}: picked t2b`);

  const show = await run(["tournament", "show", id, "--json"]);
  expect(show.code).toBe(0);
  const v = JSON.parse(show.out) as TournamentView;
  expect(v).toMatchObject({ subject: "Night theme", repo: "acme-site", ref: "AC-9", criteria: CRITERIA, status: "picked", picked: "t2b", picked_note: "warmer at night" });
  expect(v.candidates.map((c) => c.key)).toEqual(["t1", "t2", "t2b", "t3", "t4"]);
  expect(v.candidates[0]).toEqual({ key: "t1", label: "Ink", images: ["docs/t1.png", "docs/t1-dark.png"], revises: null });
  expect(v.candidates[2]!.revises).toBe("t2");
  expect(v.candidates[3]!.label).toBeNull();
  expect(v.matches.map((m) => m.name)).toEqual(["R1-1", "R1-2", "SF-1", "Final", "Rematch"]);
  // The replaced R1-2 is the new file: winner t4, no tally.
  expect(v.matches[1]).toMatchObject({ winner: "t4", tally: null });
  expect(v.matches[1]!.calls).toHaveLength(2);
  expect(v.matches[0]!.calls[1]).toEqual({
    persona: "pieter",
    model: "sonnet",
    fallback: false,
    order: 2,
    a: "t2",
    b: "t1",
    winner_key: "t1",
    why: "the calmer one",
    changes: { t2: "lift the contrast" },
    scores: { contrast: { a: 4, b: 3, why: "reads clearly" }, warmth: { a: 3, b: 3, why: "even" } },
  });
  expect(v.finalists).toEqual({ round: "Rematch", match: "Rematch", x: "t2b", y: "t1" });

  const plain = await run(["tournament", "show", id]);
  expect(plain.out).toContain("finalists: t2b v t1 (from Rematch 'Rematch')");
  expect(plain.out).toContain("pick: t2b");

  // A tally survives on a match that was not replaced.
  const add2 = await run(["tournament", "add", "--subject", "Ground", "--repo", "other-repo", "--criteria", "contrast,warmth"]);
  const id2 = add2.out.trim();
  expect((await run(["tournament", "record", id2, "--match", file(match("Final", "Final", "g1", "g2", "g2", { tally: { g1: 0, g2: 2 } }))])).code).toBe(0);
  const v2 = JSON.parse((await run(["tournament", "show", id2, "--json"])).out) as TournamentView;
  expect(v2.matches[0]!.tally).toEqual({ g1: 0, g2: 2 });
  expect(v2.finalists).toEqual({ round: "Final", match: "Final", x: "g1", y: "g2" });
  expect(v2.status).toBe("open");

  const list = JSON.parse((await run(["tournament", "list", "--json"])).out) as Array<{ id: number; matches: number; candidates: number }>;
  expect(list.map((r) => String(r.id))).toEqual([id, id2]);
  expect(list[0]).toMatchObject({ matches: 5, candidates: 5 });
  expect((await run(["tournament", "list", "--repo", "other-repo", "-q"])).out.trim()).toBe(id2);
  expect((await run(["tournament", "list"])).out).toContain(`${id}\tacme-site\tpicked t2b\tNight theme (AC-9)\t5 candidates, 5 matches`);

  // Done when 2: each refusal names its reason, and none writes.
  const refuse = async (body: unknown, needle: string, code = 2) => {
    const r = await run(["tournament", "record", id2, "--match", file(body)]);
    expect(r.code, `${needle}: ${r.err}`).toBe(code);
    expect(r.err).toContain(needle);
  };
  const bad = (over: Record<string, unknown>) => match("Bad", "R1", "g1", "g2", "g1", { calls: [call("g1", "g2", "g1", over)] });
  await refuse(bad({ scores: { contrast: score(6, 3), warmth: score(3, 3) } }), "'contrast' score for a must be an integer 1 to 5 (got 6)");
  await refuse(bad({ scores: { contrast: score(4, 2.5), warmth: score(3, 3) } }), "'contrast' score for b must be an integer 1 to 5 (got 2.5)");
  await refuse(bad({ scores: { contrast: score(0, 3), warmth: score(3, 3) } }), "(got 0)");
  await refuse(bad({ scores: { contrast: score(4, 3) } }), "criterion 'warmth' is not scored");
  await refuse(bad({ scores: { contrast: score(4, 3), warmth: { a: 3, b: 3 } } }), "'warmth' has no reason");
  await refuse(bad({ scores: { contrast: score(4, 3), warmth: score(3, 3, "  ") } }), "'warmth' has no reason");
  await refuse(bad({ scores: { contrast: score(4, 3), warmth: score(3, 3), mood: score(1, 1) } }), "'mood' is not a criterion of this tournament");
  await refuse(bad({ scores: undefined }), "'scores' is missing");
  await refuse(bad({ order: 3 }), "'order' must be 1 or 2");
  await refuse(bad({ winnerId: "g9", winner: undefined }), "winnerId 'g9' is neither a ('g1') nor b ('g2')");
  await refuse(bad({ winner: "B" }), "winner 'B' disagrees with winnerId 'g1'");
  await refuse(bad({ a: "g3" }), "must be the match's x and y");
  await refuse(match("Bad", "R1", "g1", "g2", "g7"), "winner 'g7' is neither x ('g1') nor y ('g2')");
  await refuse({ ...match("Bad", "R1", "g1", "g2", "g1"), scores: { g1: 1 } }, "rename it 'tally'");
  await refuse("{not json", "is not JSON");
  await refuse(match("Bad", "R1", "dark ink", "g2", "g2"), "match 'Bad': 'x' has no spaces");
  const after = JSON.parse((await run(["tournament", "show", id2, "--json"])).out) as TournamentView;
  expect(after.matches.map((m) => m.name)).toEqual(["Final"]);
  expect(after.candidates.map((c) => c.key)).toEqual(["g1", "g2"]);

  // Other refusals: an unread flag (before anything is sent), an unknown tournament, an unknown pick.
  const unread = await run(["tournament", "show", id, "--replace"]);
  expect(unread.code).toBe(2);
  expect(unread.err).toContain("tournament show does not take --replace");
  expect((await run(["tournament", "show", "999"])).code).toBe(1);
  const nopick = await run(["tournament", "pick", id2, "zz"]);
  expect(nopick.code).toBe(1);
  expect(nopick.err).toContain(`tournament ${id2} has no candidate 'zz'`);
  expect((await run(["tournament", "add", "--subject", "x", "--repo", "Bad Repo", "--criteria", "a"])).code).toBe(2);
  expect((await run(["tournament", "add", "--subject", "x", "--repo", "r"])).code).toBe(2);
  expect((await run(["tournament", "frob"])).code).toBe(2);
}

describe("ob tournament on SQLite (OB-2271 Done when 1, 2, 3)", () => {
  test("add, candidate, record, replace, pick, list, show, and every refusal", async () => {
    const db = freshDbPath();
    await flow((args) => runCli(db, args));
  });
});

describe("the match file rules (OB-2271)", () => {
  test("finalists: the last Rematch, else the last Final, else none", () => {
    const m = (name: string, round: string, x: string, y: string) => ({ name, round, x, y }) as TournamentMatch;
    expect(finalistsOf([m("a", "R1", "1", "2")])).toBeNull();
    expect(finalistsOf([m("f", "Final", "1", "2"), m("r", "R1", "3", "4")])).toEqual({ round: "Final", match: "f", x: "1", y: "2" });
    expect(finalistsOf([m("r1", "rematch", "1", "2"), m("f", "Final", "3", "4"), m("r2", "Rematch", "5", "6")])).toEqual({ round: "Rematch", match: "r2", x: "5", y: "6" });
  });

  test("a valid file with no optional fields passes", () => {
    const v = validateMatchFile(
      { name: "M", round: "R1", x: "a", y: "b", winner: "b", calls: [{ persona: "p", order: 2, a: "b", b: "a", winnerId: "b", scores: { contrast: score(5, 1), warmth: score(1, 5) } }] },
      CRITERIA,
    );
    expect(v.calls[0]).toMatchObject({ model: null, fallback: null, why: null, changes: null, winner_key: "b", order: 2 });
  });
});

describe("the contract (OB-2271)", () => {
  test("every /tournaments route the client calls is declared in the contract", () => {
    const declared = OB_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const r of ["GET /tournaments", "POST /tournaments", "GET /tournaments/:id", "POST /tournaments/:id/candidates", "POST /tournaments/:id/matches", "POST /tournaments/:id/pick"]) {
      expect(declared).toContain(r);
    }
  });
});

// --- over the API -----------------------------------------------------------------------------------------

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (deps: RunDeps, store: Store) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const obApi = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const transport: ApiTransport = async (req) => {
    const res = await obApi(
      new Request(req.url.replace(BASE, "http://api-host.local"), {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  try {
    await fn({ api: { base: BASE, token: TOKEN, transport } }, store);
  } finally {
    await store.close?.();
  }
}

describe("ob tournament over the API (OB-2271 Done when 1, 2, 3)", () => {
  test("the same flow through the server, with the tournament in Postgres", async () => {
    await withApi(async (deps, store) => {
      await flow((args) => runCli(freshDbPath(), args, deps));
      const rows = (await store.q.select().from(store.t.tournamentCall)) as unknown[];
      expect(rows.length).toBe(12);
    });
  }, 60_000);
});
