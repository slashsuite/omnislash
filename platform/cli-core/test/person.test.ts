import { describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  addPerson,
  getPerson,
  setPerson,
  rmPerson,
  listPersons,
  resolvePerson,
  resolvePersonArg,
  matchPersonsByName,
  personDisplay,
  normHandle,
} from "../../../apps/cli/src/commands/person.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";

describe("personDisplay / normHandle", () => {
  test("display is 'name (role)' or bare name", () => {
    expect(personDisplay({ real_name: "Sam Sample", role: "cto" } as never)).toBe("Sam Sample (cto)");
    expect(personDisplay({ real_name: "Sam Sample", role: null } as never)).toBe("Sam Sample");
  });
  test("normHandle trims, drops leading @, lowercases", () => {
    expect(normHandle("  @Riley ")).toBe("riley");
    expect(normHandle("CoderabbitAI")).toBe("coderabbitai");
  });
});

describe("addPerson / getPerson", () => {
  test("inserts and reads back all fields", () => {
    const db = freshDb();
    const p = addPerson(db, "Riley Test", {
      role: "engineer",
      github_login: "rileytest-acme",
      linear_user_id: "lin-uuid-1",
      linear_name: "Riley",
      slack_user_id: "U123",
      slack_handle: "@riley",
      email: "riley@example.com",
    });
    expect(p.id).toBeGreaterThan(0);
    const got = getPerson(db, p.id)!;
    expect(got.real_name).toBe("Riley Test");
    expect(got.github_login).toBe("rileytest-acme");
    expect(got.role).toBe("engineer");
    expect(got.created_at).toBe(got.updated_at);
  });

  test("communication profile fields (142) round-trip via add + resolvePerson + set", () => {
    const db = freshDb();
    const p = addPerson(db, "Taylor", {
      whatsapp_jid: "27000000003@s.whatsapp.net",
      relationship: "colleague",
      comms_style: "affectionate",
      comms_notes: "Afrikaans mix, pet name skattie",
    });
    const got = getPerson(db, p.id)!;
    expect(got.relationship).toBe("colleague");
    expect(got.comms_style).toBe("affectionate");
    expect(got.comms_notes).toBe("Afrikaans mix, pet name skattie");
    // resolvable by whatsapp_jid (the suggest path resolves the sender this way)
    expect(resolvePerson(db, "27000000003@s.whatsapp.net")?.id).toBe(p.id);
    // free-text, not uniqueness-constrained; '' clears
    const updated = setPerson(db, p.id, { comms_style: "playful/flirty", comms_notes: "" });
    expect(updated.comms_style).toBe("playful/flirty");
    expect(updated.comms_notes).toBeNull();
    expect(updated.relationship).toBe("colleague"); // untouched
  });

  test("rejects a key handle already owned by someone else", () => {
    const db = freshDb();
    addPerson(db, "A", { github_login: "shared" });
    expect(() => addPerson(db, "B", { github_login: "shared" })).toThrow(/already maps to/);
  });

  test("non-key fields (slack_handle, email) are not uniqueness-constrained", () => {
    const db = freshDb();
    addPerson(db, "A", { slack_handle: "@dup" });
    expect(() => addPerson(db, "B", { slack_handle: "@dup" })).not.toThrow();
  });
});

describe("resolvePerson (ob whois)", () => {
  const seed = () => {
    const db = freshDb();
    addPerson(db, "Riley Test", {
      github_login: "rileytest-acme",
      linear_user_id: "lin-1",
      linear_name: "Riley",
      slack_user_id: "U1",
      slack_handle: "@riley",
      email: "riley@example.com",
    });
    return db;
  };

  test("resolves by every handle kind, case-insensitively", () => {
    const db = seed();
    for (const h of ["rileytest-acme", "RILEYTEST-ACME", "lin-1", "Riley", "U1", "@riley", "riley", "riley@example.com"]) {
      expect(resolvePerson(db, h)?.real_name).toBe("Riley Test");
    }
  });

  test("returns null for an unmapped or empty handle", () => {
    const db = seed();
    expect(resolvePerson(db, "someone-else")).toBeNull();
    expect(resolvePerson(db, "   ")).toBeNull();
  });
});

describe("resolvePersonArg — name lookup (#37)", () => {
  const seed = () => {
    const db = freshDb();
    addPerson(db, "Taylor Demo", { whatsapp_jid: "27000000003@s.whatsapp.net" });
    addPerson(db, "Sam Sample", { github_login: "sam-gh", role: "cto" });
    addPerson(db, "Taylor Smith", { email: "taylor.smith@example.com" }); // shares first name with Taylor Demo
    return db;
  };

  test("id path still works (numeric id → that person; unknown id → null)", () => {
    const db = seed();
    const sam = listPersons(db).find((p) => p.real_name === "Sam Sample")!;
    expect(resolvePersonArg(db, String(sam.id))?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "99999")).toBeNull();
  });

  test("handle path still works (github + whatsapp jid, case-insensitive)", () => {
    const db = seed();
    expect(resolvePersonArg(db, "sam-gh")?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "SAM-GH")?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "27000000003@s.whatsapp.net")?.real_name).toBe("Taylor Demo");
  });

  test("exact full-name match, case-insensitive", () => {
    const db = seed();
    expect(resolvePersonArg(db, "Sam Sample")?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "sam sample")?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "  SAM SAMPLE  ")?.real_name).toBe("Sam Sample");
  });

  test("substring / prefix match resolves a single person", () => {
    const db = seed();
    expect(resolvePersonArg(db, "Sample")?.real_name).toBe("Sam Sample");
    expect(resolvePersonArg(db, "demo")?.real_name).toBe("Taylor Demo"); // prefix-ish substring, one hit
  });

  test("exact full name wins even when it is also a substring of another name", () => {
    const db = freshDb();
    addPerson(db, "Sam", {});
    addPerson(db, "Sammy Davis", {});
    // "Sam" is a substring of "Sammy Davis", but an exact match on "Sam" must win outright.
    expect(resolvePersonArg(db, "Sam")?.real_name).toBe("Sam");
  });

  test("ambiguous name throws UsageError listing every candidate", () => {
    const db = seed();
    try {
      resolvePersonArg(db, "Taylor"); // matches both Taylor Demo and Taylor Smith
      throw new Error("expected resolvePersonArg to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      const msg = (e as Error).message;
      expect(msg).toContain("matches 2 people");
      expect(msg).toContain("Taylor Demo");
      expect(msg).toContain("Taylor Smith");
      expect(msg).toContain("id or handle");
    }
  });

  test("no match → null (caller raises not-found)", () => {
    const db = seed();
    expect(resolvePersonArg(db, "Nobody Here")).toBeNull();
    expect(resolvePersonArg(db, "   ")).toBeNull();
  });

  test("matchPersonsByName: exact set preferred over substring set", () => {
    const db = seed();
    expect(matchPersonsByName(db, "Taylor").map((p) => p.real_name).sort()).toEqual([
      "Taylor Demo",
      "Taylor Smith",
    ]);
    expect(matchPersonsByName(db, "Sam Sample").map((p) => p.real_name)).toEqual(["Sam Sample"]);
    expect(matchPersonsByName(db, "")).toEqual([]);
  });
});

describe("setPerson", () => {
  test("updates provided fields, '' clears, omitted unchanged", () => {
    const db = freshDb();
    const p = addPerson(db, "A", { role: "pm", github_login: "a-gh", email: "a@x.dev" });
    const updated = setPerson(db, p.id, { role: "cto", email: "" });
    expect(updated.role).toBe("cto");
    expect(updated.email).toBeNull(); // cleared
    expect(updated.github_login).toBe("a-gh"); // untouched
    expect(updated.updated_at >= p.updated_at).toBe(true);
  });

  test("key conflict check excludes self (idempotent re-set)", () => {
    const db = freshDb();
    const p = addPerson(db, "A", { github_login: "a-gh" });
    expect(() => setPerson(db, p.id, { github_login: "a-gh", role: "lead" })).not.toThrow();
    addPerson(db, "B", { github_login: "b-gh" });
    expect(() => setPerson(db, p.id, { github_login: "b-gh" })).toThrow(/already maps to/);
  });
});

describe("rmPerson / listPersons", () => {
  test("remove returns whether a row was deleted; list is name-ordered", () => {
    const db = freshDb();
    const z = addPerson(db, "Zoe", {});
    addPerson(db, "Amy", {});
    expect(listPersons(db).map((p) => p.real_name)).toEqual(["Amy", "Zoe"]);
    expect(rmPerson(db, z.id)).toBe(true);
    expect(rmPerson(db, 99999)).toBe(false);
    expect(listPersons(db).map((p) => p.real_name)).toEqual(["Amy"]);
  });
});

describe("CLI: person + whois", () => {
  test("add → whois resolves; unmapped whois exits 1", async () => {
    const dbPath = freshDbPath();
    const add = await runCli(dbPath, ["person", "add", "Sam Sample", "--role", "cto", "--github", "sam-gh"]);
    expect(add.code).toBe(0);

    const hit = await runCli(dbPath, ["whois", "sam-gh"]);
    expect(hit.code).toBe(0);
    expect(hit.out).toContain("Sam Sample (cto)");

    const miss = await runCli(dbPath, ["whois", "nobody"]);
    expect(miss.code).toBe(1);
    expect(miss.err).toContain("no person matches 'nobody'");
  });

  test("comms-profile flags flow through add and show (142)", async () => {
    const dbPath = freshDbPath();
    const add = await runCli(dbPath, [
      "person",
      "add",
      "Taylor",
      "--relationship",
      "colleague",
      "--comms-style",
      "affectionate",
      "--comms-notes",
      "Afrikaans mix",
    ]);
    expect(add.code).toBe(0);
    const list = await runCli(dbPath, ["person", "list", "--json"]);
    const id = JSON.parse(list.out)[0].id;
    const showById = await runCli(dbPath, ["person", "show", String(id), "--json"]);
    const row = JSON.parse(showById.out);
    expect(row.relationship).toBe("colleague");
    expect(row.comms_style).toBe("affectionate");
    expect(row.comms_notes).toBe("Afrikaans mix");
  });

  test("whois --json emits the row, or null when unmapped", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["person", "add", "Sam Sample", "--slack", "U9", "--slack-handle", "@sam"]);
    const hit = await runCli(dbPath, ["whois", "@sam", "--json"]);
    expect(JSON.parse(hit.out).real_name).toBe("Sam Sample");
    const miss = await runCli(dbPath, ["whois", "ghost", "--json"]);
    expect(miss.out.trim()).toBe("null");
    expect(miss.code).toBe(1);
  });
});
