import { describe, expect, it } from "bun:test";
import {
  ageText,
  checkSummary,
  groupByHome,
  pasteAllowedHere,
  presenceSummary,
  refreshHint,
} from "./credentials.ts";
import type { CredentialStatus } from "../../../cli/src/credentials.ts";

// 219: the tokens page's view model. The distinction these tests exist to hold is "never checked" vs
// "checked and bad". The page was built because four credentials looked fine while nothing had ever
// asked them a question.

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function row(over: Partial<CredentialStatus> = {}): CredentialStatus {
  return {
    name: "linear",
    label: "Linear",
    home: "store",
    refresh: "paste",
    command: "ob secret set linear",
    purpose: "Reads Cue tickets.",
    present: true,
    presence_detail: "in the encrypted store",
    updated_at: "2026-08-01T09:00:00.000Z",
    writable: true,
    checkable: true,
    last_check: null,
    ...over,
  };
}

describe("checkSummary (219)", () => {
  it("never checked is its own state, not a failure", () => {
    const s = checkSummary(row(), NOW);
    expect(s.state).toBe("never");
    expect(s.label).toBe("never checked");
    expect(s.tone).not.toBe("danger");
  });

  it("a failed check reads as failed, with the reason and when", () => {
    const s = checkSummary(
      row({ last_check: { name: "linear", checked_at: "2026-08-16T11:57:00.000Z", ok: false, detail: "Linear answered HTTP 401" } }),
      NOW,
    );
    expect(s.state).toBe("failed");
    expect(s.label).toBe("FAILED, checked 3m ago");
    expect(s.detail).toBe("Linear answered HTTP 401");
    expect(s.tone).toBe("danger");
  });

  it("a failed check on a MISSING credential still reads as failed, not as missing", () => {
    const s = checkSummary(
      row({ present: false, last_check: { name: "linear", checked_at: "2026-08-16T11:00:00.000Z", ok: false, detail: "not in the store" } }),
      NOW,
    );
    expect(s.state).toBe("failed");
    expect(s.label).toContain("1h ago");
  });

  it("a passing check says when it passed", () => {
    const s = checkSummary(
      row({ last_check: { name: "linear", checked_at: "2026-08-16T11:59:30.000Z", ok: true, detail: "Linear viewer Alex" } }),
      NOW,
    );
    expect(s).toMatchObject({ state: "ok", label: "valid, checked just now", tone: "positive" });
  });

  it("a credential with no live check says so rather than pretending it was never checked", () => {
    expect(checkSummary(row({ checkable: false }), NOW).state).toBe("unavailable");
  });
});

describe("presenceSummary (219)", () => {
  it("missing is red", () => {
    expect(presenceSummary(row({ present: false }))).toEqual({ label: "missing", tone: "danger" });
  });

  it("present in the store is green", () => {
    expect(presenceSummary(row())).toEqual({ label: "present", tone: "positive" });
  });

  it("a store credential found somewhere else is present BUT flagged (github in the gh CLI, ob 185)", () => {
    const s = presenceSummary(row({ name: "github", updated_at: null, presence_detail: "the `gh` CLI's own login only" }));
    expect(s).toEqual({ label: "present, but not in the store", tone: "warn" });
  });
});

describe("refreshHint (219): refresh is not one action", () => {
  it("names a paste, an OAuth round trip, an interactive login and a file as different things", () => {
    const kinds = (["paste", "oauth", "login", "file", "keychain", "qr"] as const).map((refresh) => refreshHint(row({ refresh })));
    expect(new Set(kinds).size).toBe(6);
    expect(refreshHint(row({ refresh: "login" }))).toContain("terminal");
    expect(refreshHint(row({ refresh: "oauth" }))).toContain("cannot be a paste");
  });

  // 274: the one refresh a web page completes by SHOWING rather than by collecting, so its hint must send
  // the reader to the pairing panel and to their phone — never to a paste box that cannot take a QR.
  it("sends the QR kind to the phone and the pairing panel, not to a terminal or a paste", () => {
    const hint = refreshHint(row({ refresh: "qr" }));
    expect(hint).toContain("phone");
    expect(hint).toContain("pairing panel");
    expect(hint).not.toContain("Paste");
  });
});

describe("grouping and the paste gate (219)", () => {
  it("groups by where the credential lives, store first", () => {
    const groups = groupByHome([
      row({ name: "other-tool", home: "external" }),
      row({ name: "master-key", home: "keychain" }),
      row({ name: "linear", home: "store" }),
    ]);
    expect(groups.map((g) => g.home)).toEqual(["store", "keychain", "external"]);
  });

  it("offers the paste box on https and on loopback, never on plain http over the network", () => {
    expect(pasteAllowedHere({ protocol: "https:", hostname: "ob.example.test" })).toBe(true);
    expect(pasteAllowedHere({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(pasteAllowedHere({ protocol: "http:", hostname: "10.0.0.220" })).toBe(false);
  });
});

describe("ageText (219)", () => {
  it("reads in the units the page needs", () => {
    expect(ageText("2026-08-16T11:59:59.000Z", NOW)).toBe("just now");
    expect(ageText("2026-08-16T11:30:00.000Z", NOW)).toBe("30m ago");
    expect(ageText("2026-08-16T06:00:00.000Z", NOW)).toBe("6h ago");
    expect(ageText("2026-08-01T12:00:00.000Z", NOW)).toBe("15d ago");
  });
});
