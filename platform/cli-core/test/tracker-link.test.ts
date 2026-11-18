import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { attachLinear } from "../../../apps/cli/src/items.ts";
import {
  __setGithubGql,
  __setSetIssueState,
  closeIssue,
  reopenIssue,
  type IssueStateChange,
} from "../../../apps/cli/src/github-issues.ts";
import type { GithubIssue } from "../../../apps/cli/src/wayfinder.ts";
import {
  __setListIssues,
  __setSh,
  branchMatches,
  branchSlug,
  branchSlugsAgree,
  candidatePairs,
  commitRefs,
  computeDrift,
  getIssueLink,
  getLinearOnlyRef,
  issueUrl,
  landedIn,
  parseCommitRefs,
  parseGithubIssueUrl,
  parseIssueArg,
  parseMergeSubject,
  readRepoState,
  refLabel,
  sameRepo,
  syncIssueState,
  ticketRefMention,
  titleScore,
  titleTokens,
  unlinkedObItemIds,
  workHasLanded,
  type Commit,
  type MergedBranch,
  type RepoState,
  type Sh,
} from "../../../apps/cli/src/tracker-link.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";

const REPO = "owner/acme";
const REC = "\x1e";
const FLD = "\x1f";

interface GitFixture {
  toplevel?: string;
  remote?: string | null;
  log?: Commit[];
  branches?: Array<{ name: string; tip: string }>;
  firstParent?: string[];
  counts?: Record<string, number>;
  failing?: boolean;
  failLog?: boolean;
}

/** A `git` stub dispatching on argv, so no test ever forks a real git. */
function fakeGit(f: GitFixture): Sh {
  return (cmd) => {
    const joined = cmd.join(" ");
    if (f.failing) return { ok: false, err: "not a git repository", out: "" };
    if (joined.includes("rev-parse --show-toplevel")) {
      return { ok: true, err: "", out: `${f.toplevel ?? "/repo"}\n` };
    }
    if (joined.includes("config --get remote.origin.url")) {
      const remote = f.remote === undefined ? `git@github.com:${REPO}.git` : f.remote;
      return remote === null ? { ok: false, err: "no remote", out: "" } : { ok: true, err: "", out: `${remote}\n` };
    }
    if (cmd.includes("log")) {
      if (f.failLog) return { ok: false, err: "bad revision 'main'", out: "" };
      return {
        ok: true,
        err: "",
        out: (f.log ?? []).map((c) => `${c.sha}${FLD}${c.subject}${FLD}${c.body}${REC}`).join("\n"),
      };
    }
    if (joined.includes("rev-list --first-parent")) {
      return { ok: true, err: "", out: (f.firstParent ?? []).join("\n") };
    }
    if (joined.includes("rev-list --count")) {
      const range = cmd[cmd.length - 2]!;
      return { ok: true, err: "", out: String(f.counts?.[range] ?? 0) };
    }
    if (cmd.includes("branch")) {
      const remote = cmd.includes("-r");
      const rows = remote ? [] : f.branches ?? [];
      return { ok: true, err: "", out: rows.map((b) => `${b.tip}\t${b.name}`).join("\n") };
    }
    return { ok: false, err: `unstubbed git call: ${joined}`, out: "" };
  };
}

async function seedItem(dbPath: string, title: string): Promise<string> {
  // The legacy id (1949): the human echo is now the `OB-<seq>` ref, and these cases are about the number.
  const r = await runCli(dbPath, ["add", title, "--repo", "omnislash", "--kind", "side", "--json"]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.out) as { id: string }).id;
}

const c = (sha: string, subject: string, body = ""): Commit => ({ sha, subject, body });

describe("tracker-link pure helpers (77)", () => {
  test("parseGithubIssueUrl: an issue URL -> repo+number; anything else -> null", () => {
    expect(parseGithubIssueUrl(`https://github.com/${REPO}/issues/122`)).toEqual({ repo: REPO, number: 122 });
    expect(parseGithubIssueUrl(`https://github.com/${REPO}/issues/122/`)).toEqual({ repo: REPO, number: 122 });
    expect(parseGithubIssueUrl("https://linear.app/cue/issue/CUE-1234/thing")).toBeNull();
    expect(parseGithubIssueUrl("https://github.com/o/r/pull/12")).toBeNull();
    expect(parseGithubIssueUrl(null)).toBeNull();
  });

  test("parseIssueArg accepts #n, bare n, and a URL; rejects junk", () => {
    expect(parseIssueArg("#122")).toEqual({ number: 122 });
    expect(parseIssueArg("122")).toEqual({ number: 122 });
    expect(parseIssueArg(issueUrl("o/r", 7))).toEqual({ repo: "o/r", number: 7 });
    expect(() => parseIssueArg("CUE-1")).toThrow(UsageError);
  });

  test("sameRepo is case-insensitive", () => {
    expect(sameRepo("Owner/Acme", REPO)).toBe(true);
    expect(sameRepo("other/repo", REPO)).toBe(false);
  });

  test("refLabel marks the namespace it came from", () => {
    expect(refLabel({ namespace: "ob", number: 55 })).toBe("ob 55");
    expect(refLabel({ namespace: "issue", number: 55 })).toBe("#55");
  });
});

// The whole correctness premise: ob ids and issue numbers are independent sequences. Every case below is a
// real subject from this repo's `main`.
describe("evidence is read WITH its namespace marker (77)", () => {
  test("parseMergeSubject: `ob <n>` is the ob namespace, `#<n>` the issue namespace", () => {
    expect(parseMergeSubject("Merge ob 55: ob theme sync imports a Warp theme")).toEqual([
      { namespace: "ob", number: 55 },
    ]);
    expect(parseMergeSubject("Merge ob 75")).toEqual([{ namespace: "ob", number: 75 }]);
    expect(parseMergeSubject("Merge #102: font size zoom + configurable family")).toEqual([
      { namespace: "issue", number: 102 },
    ]);
    expect(parseMergeSubject("Merge issue #41")).toEqual([{ namespace: "issue", number: 41 }]);
  });

  test("parseMergeSubject: multi-ticket landings resolve EVERY ref, not just the first", () => {
    expect(parseMergeSubject("Merge #123 + #128: sidebar refreshes on a poll, and every open tab is listed")).toEqual([
      { namespace: "issue", number: 123 },
      { namespace: "issue", number: 128 },
    ]);
    expect(parseMergeSubject("Merge #99 + #98: terminal scrollback, selection and copy/paste")).toEqual([
      { namespace: "issue", number: 99 },
      { namespace: "issue", number: 98 },
    ]);
  });

  test("parseMergeSubject: a subject that is not a landing claim yields nothing", () => {
    expect(parseMergeSubject("Merge branch 'bridge-proxy'")).toEqual([]);
    expect(parseMergeSubject("Merge remote-tracking branch 'origin/main' into build-105-tab-reorder")).toEqual([]);
    // what was merged IN is not what landed
    expect(parseMergeSubject("Merge main (#101, #105) into #102: keep all three keybinding lists")).toEqual([]);
    // a COUNT is not a ref, and an unmarked number belongs to no namespace
    expect(parseMergeSubject("Merge 2 branches")).toEqual([]);
    expect(parseMergeSubject("Merge 74: whatever")).toEqual([]);
  });

  test("parseCommitRefs: a LEADING conventional scope, marked, including multi-ticket", () => {
    expect(parseCommitRefs("feat(ob 77): landing closes both", "")).toEqual([{ namespace: "ob", number: 77 }]);
    expect(parseCommitRefs("fix(#123,#128): the sidebar refreshes", "")).toEqual([
      { namespace: "issue", number: 123 },
      { namespace: "issue", number: 128 },
    ]);
    expect(parseCommitRefs("feat(#61,#60): spinoff adopts existing worktree/branch", "")).toEqual([
      { namespace: "issue", number: 61 },
      { namespace: "issue", number: 60 },
    ]);
  });

  test("parseCommitRefs: a BARE scope number belongs to no namespace, so it is not evidence", () => {
    // real subjects: these numbers came from the retired markdown tracker
    expect(parseCommitRefs("docs(27): record self-bio resolution on the whatsapp map", "")).toEqual([]);
    expect(parseCommitRefs("fix(111): capture Android native build", "")).toEqual([]);
    expect(parseCommitRefs("docs(217,218): close cleanup cmd (dogfooded)", "")).toEqual([]);
  });

  test("parseCommitRefs: a mention in PROSE is not a landing claim (the unanchored-paren defect)", () => {
    // `(#26)` appears in this body; before anchoring, `ob issue landed '#26'` reported it as landed
    expect(parseCommitRefs("docs(104): reconcile #24 with the WhatsApp map", "notes about (#26) here")).toEqual([]);
    expect(parseCommitRefs("chore: tidy", "see the discussion in (#83) and (#86)")).toEqual([]);
  });

  test("parseCommitRefs: closing keywords are a claim, and carry their marker", () => {
    expect(parseCommitRefs("fix: whatever", "Closes #41")).toEqual([{ namespace: "issue", number: 41 }]);
    expect(parseCommitRefs("fix: whatever", "resolves #41")).toEqual([{ namespace: "issue", number: 41 }]);
    expect(parseCommitRefs("fix: whatever", "fixes ob 41")).toEqual([{ namespace: "ob", number: 41 }]);
  });

  test("ticketRefMention: `#n` is an issue, a bare `n` is an ob id, `PS-12` a per-project ref (1949)", () => {
    expect(ticketRefMention("#133")).toEqual({ namespace: "issue", number: 133 });
    expect(ticketRefMention("55")).toEqual({ namespace: "ob", number: 55 });
    // A Linear-style key-number ref is ref-shaped too: a commit scoped `(CUE-9882)` names exactly that ticket.
    expect(ticketRefMention("CUE-9882")).toEqual({ namespace: "ref", key: "CUE", number: 9882 });
    expect(ticketRefMention("ps-012")).toEqual({ namespace: "ref", key: "PS", number: 12 });
    expect(ticketRefMention("local-twilio-dev-loop")).toBeNull();
  });

  test("branchMatches is namespace-BLIND, which is why a branch needs separate attribution", () => {
    expect(branchMatches("55-theme-sync", 55)).toBe(true);
    expect(branchMatches("55", 55)).toBe(true);
    expect(branchMatches("550-other", 55)).toBe(false);
    expect(branchMatches("fix/55-thing", 55)).toBe(false);
  });

  test("branchMatches with a key matches only that key's `<key>-<seq>` branch (1949)", () => {
    expect(branchMatches("ps-12", 12, "PS")).toBe(true);
    expect(branchMatches("PS-12-extra", 12, "PS")).toBe(true);
    expect(branchMatches("hc-12", 12, "PS")).toBe(false);
    expect(branchMatches("12-thing", 12, "PS")).toBe(false);
    expect(branchMatches("ps-120", 12, "PS")).toBe(false);
  });

  test("per-project refs are read from scopes, merge subjects and closing keywords, old shapes still (1949)", () => {
    const ps12 = { namespace: "ref" as const, key: "PS", number: 12 };
    expect(parseCommitRefs("feat(PS-12): x", "")).toEqual([ps12]);
    expect(parseCommitRefs("fix(ps-12, HC-3): x", "")).toEqual([ps12, { namespace: "ref" as const, key: "HC", number: 3 }]);
    expect(parseCommitRefs("chore: x", "Closes PS-12")).toEqual([ps12]);
    expect(parseCommitRefs("feat(ob 1949): x", "")).toEqual([{ namespace: "ob", number: 1949 }]);
    expect(parseCommitRefs("docs(27): x", "")).toEqual([]);
    expect(parseMergeSubject("Merge PS-12: x")).toEqual([ps12]);
    expect(parseMergeSubject("Merge PS-12 + PS-13: x")).toEqual([ps12, { namespace: "ref" as const, key: "PS", number: 13 }]);
    expect(parseMergeSubject("Merge PS-12 + 13: x")).toEqual([ps12, { namespace: "ref" as const, key: "PS", number: 13 }]);
    expect(parseMergeSubject("Merge ob 55: x")).toEqual([{ namespace: "ob", number: 55 }]);
    expect(refLabel(ps12)).toBe("PS-12");
  });

  test("workHasLanded: a `PS-12` row lands on `feat(PS-12)`, never on `(HC-12)`, `(ob 12)` or a docs note (1949)", () => {
    expect(workHasLanded("PS-12", { commits: [c("a", "feat(PS-12): x")] })).toBe(true);
    expect(workHasLanded("ps-12", { commits: [c("a", "feat(PS-12): x")] })).toBe(true);
    expect(workHasLanded("PS-12", { commits: [c("a", "feat(HC-12): x")] })).toBe(false);
    expect(workHasLanded("PS-12", { commits: [c("a", "feat(ob 12): x")] })).toBe(false);
    expect(workHasLanded("PS-12", { commits: [c("a", "docs(PS-12): chart")] })).toBe(false);
    // a parked bare-id row keeps landing on its old scope
    expect(workHasLanded("1548", { commits: [c("a", "feat(ob 1548): x")] })).toBe(true);
  });

  test("commitRefs prefers the merge subject, else the scope/closing refs", () => {
    expect(commitRefs(c("a", "Merge ob 55: x", "Closes #99"))).toEqual([{ namespace: "ob", number: 55 }]);
    expect(commitRefs(c("a", "feat(#99,#98): x"))).toEqual([
      { namespace: "issue", number: 99 },
      { namespace: "issue", number: 98 },
    ]);
  });
});

describe("landedIn (77)", () => {
  const branch = (over: Partial<MergedBranch> & { name: string }): MergedBranch => ({
    tip: "tip",
    ownCommits: true,
    proof: "base-sha",
    mention: null,
    ...over,
  });
  const state = (over: Partial<RepoState> = {}): RepoState => ({
    checkout: "/repo",
    main: "main",
    readable: true,
    readError: null,
    commits: [],
    branches: [],
    spinoffs: [],
    unlinkedObItems: new Set<number>(),
    ...over,
  });

  test("no evidence -> not landed, and `fired` is empty while `checked` still lists all four", () => {
    const r = landedIn(state(), [{ namespace: "ob", number: 9, via: "asked" }]);
    expect(r.landed).toBe(false);
    expect(r.hits).toEqual([]);
    expect(r.fired).toEqual([]);
    expect(r.checked).toEqual(["merge-commit", "commit-ref", "merged-branch", "spinoff-row"]);
    expect(r.refs).toEqual(["ob 9"]);
  });

  test("`fired` lists ONLY the signals that produced evidence, never all four", () => {
    const s = state({
      commits: [c("aaaaaaa", "Merge ob 55: theme sync")],
      branches: [branch({ name: "55-theme-sync", mention: { namespace: "ob", number: 55 } })],
    });
    const r = landedIn(s, [{ namespace: "ob", number: 55, via: "asked" }]);
    expect(r.landed).toBe(true);
    expect(r.fired).toEqual(["merge-commit", "merged-branch"]);
    expect(r.fired).not.toContain("spinoff-row");
    expect(r.fired).not.toContain("commit-ref");
  });

  // The live hazard: `main` carries `Merge ob 75` (ob item 75, lease work) while gh#75 is an unrelated OPEN
  // ticket. Reporting one as evidence for the other advised closing real, unbuilt work.
  test("ob-namespace evidence does NOT prove an issue landed, and vice versa", () => {
    const obEvidence = state({
      commits: [c("aaaaaaa", "Merge ob 75: lease release and agent register are symmetric"), c("bbbbbbb", "fix(ob 75): x")],
      branches: [branch({ name: "75-lease-release-holder", mention: { namespace: "ob", number: 75 } })],
      spinoffs: [{ ticket_ref: "75", branch: "75-lease-release-holder", base_sha: "base", ownCommits: true }],
    });
    expect(landedIn(obEvidence, [{ namespace: "issue", number: 75, via: "asked" }]).landed).toBe(false);
    expect(landedIn(obEvidence, [{ namespace: "ob", number: 75, via: "asked" }]).landed).toBe(true);

    const issueEvidence = state({
      commits: [c("ccccccc", "Merge #102: font size zoom")],
      spinoffs: [{ ticket_ref: "#102", branch: "102-font", base_sha: "base", ownCommits: true }],
    });
    expect(landedIn(issueEvidence, [{ namespace: "ob", number: 102, via: "asked" }]).landed).toBe(false);
    expect(landedIn(issueEvidence, [{ namespace: "issue", number: 102, via: "asked" }]).landed).toBe(true);
  });

  test("a LINK is the only bridge: ob evidence answers for an issue ref only when linked", () => {
    const s = state({ commits: [c("aaaaaaa", "Merge ob 55: theme sync")] });
    // asked about #110 alone: nothing, because #110 is a different sequence
    expect(landedIn(s, [{ namespace: "issue", number: 110, via: "asked" }]).landed).toBe(false);
    // asked about #110 WITH the link to ob 55: found, and the hit says it came via the link
    const r = landedIn(s, [
      { namespace: "issue", number: 110, via: "asked" },
      { namespace: "ob", number: 55, via: "link" },
    ]);
    expect(r.landed).toBe(true);
    expect(r.hits[0]!.ref).toBe("ob 55");
    expect(r.hits[0]!.detail).toContain("via the link");
  });

  test("a merged branch with NO namespace attribution is reported ambiguous, never as a hit", () => {
    const s = state({ branches: [branch({ name: "55-theme-sync", mention: null })] });
    const r = landedIn(s, [{ namespace: "issue", number: 55, via: "asked" }]);
    expect(r.landed).toBe(false);
    // ambiguity with no hit is its OWN answer: evidence matched the number, so this is not "no evidence"
    expect(r.answer).toBe("could-not-tell");
    expect(r.ambiguous.join(" ")).toContain("55-theme-sync");
    expect(r.ambiguous.join(" ")).toContain("ob id or an issue number");
  });

  test("a merged `ps-12` branch names its own key, so it is a hit for PS-12 without a row (1949)", () => {
    const s = state({ branches: [branch({ name: "ps-12", mention: null })] });
    expect(landedIn(s, [{ namespace: "ref", key: "PS", number: 12, via: "asked" }]).fired).toEqual(["merged-branch"]);
    expect(landedIn(s, [{ namespace: "ob", number: 12, via: "asked" }]).answer).toBe("no-evidence");
  });

  test("an unreadable checkout can never answer 'landed'", () => {
    const s = state({
      readable: false,
      readError: "bad revision 'main'",
      commits: [c("aaaaaaa", "Merge ob 55: theme sync")],
    });
    const r = landedIn(s, [{ namespace: "ob", number: 55, via: "asked" }]);
    expect(r.landed).toBe(false);
    expect(r.readable).toBe(false);
    expect(r.read_error).toBe("bad revision 'main'");
    expect(r.hits).toEqual([]);
  });

  // gh#133: a spinoff created `133-regression-…` off main minutes ago with zero commits. A branch with no
  // commits of its own is trivially an ancestor of main, so `--merged` lists it.
  test("REGRESSION: a zero-commit branch created off main is NOT landed", () => {
    const zero = branch({
      name: "133-regression-scrolling-has-stopped-working",
      ownCommits: false,
      mention: { namespace: "issue", number: 133 },
    });
    const r = landedIn(state({ branches: [zero] }), [{ namespace: "issue", number: 133, via: "asked" }]);
    expect(r.landed).toBe(false);
    expect(r.fired).toEqual([]);
  });

  test("a spinoff row without the unique-commit proof is not evidence either", () => {
    const unproved = state({ spinoffs: [{ ticket_ref: "#133", branch: "133-x", base_sha: null, ownCommits: false }] });
    expect(landedIn(unproved, [{ namespace: "issue", number: 133, via: "asked" }]).landed).toBe(false);
    const proved = state({ spinoffs: [{ ticket_ref: "#133", branch: "133-x", base_sha: "b", ownCommits: true }] });
    expect(landedIn(proved, [{ namespace: "issue", number: 133, via: "asked" }]).fired).toEqual(["spinoff-row"]);
  });

  // 129: the four real subjects on `main`. ob 120/121/122/127 were landed with a HASH and carry no linked
  // issue, while GitHub #120/#121/#122/#127 are unrelated real tickets, so neither reading can be trusted.
  describe("a `#<n>` that is ALSO an unlinked ob id is COULD NOT TELL (129)", () => {
    const BAD = [
      c("21fea7b", "Merge #122: the app holds its own lease, so a Dock launch is guarded"),
      c("edf9f37", "Merge #120: the build stamp is part of the Nx cache key"),
      c("847d71f", "Merge #121: pgrep cannot see the app"),
      c("325f03e", "Merge #127: render SGR 2 faint, so ghost text stops looking like input"),
    ];
    const unlinked = new Set([120, 121, 122, 127]);

    test("none of the four is a confident GitHub-issue hit, in either numbering", () => {
      const s = state({ commits: BAD, unlinkedObItems: unlinked });
      for (const n of [120, 121, 122, 127]) {
        for (const namespace of ["issue", "ob"] as const) {
          const r = landedIn(s, [{ namespace, number: n, via: "asked" }]);
          expect(r.landed).toBe(false);
          expect(r.fired).toEqual([]);
          expect(r.answer).toBe("could-not-tell");
        }
      }
    });

    test("the ambiguity is spelled out for the ob id, so it stops being a false NEGATIVE", () => {
      const r = landedIn(state({ commits: BAD, unlinkedObItems: unlinked }), [
        { namespace: "ob", number: 122, via: "asked" },
      ]);
      expect(r.answer).not.toBe("no-evidence");
      const note = r.ambiguous.join(" ");
      expect(note).toContain("21fea7b");
      expect(note).toContain("the app holds its own lease");
      expect(note).toContain("ob 122 is an ob item with NO linked GitHub issue");
      expect(note).toContain("an unlinked ob item lands as 'Merge ob <n>', never '#<n>'");
    });

    test("a commit SCOPE spelled the same way is ambiguous too", () => {
      const s = state({
        commits: [c("1efc510", "feat(#127): render SGR 2 faint, so ghost text stops looking like input")],
        unlinkedObItems: unlinked,
      });
      expect(landedIn(s, [{ namespace: "issue", number: 127, via: "asked" }]).answer).toBe("could-not-tell");
      expect(landedIn(s, [{ namespace: "ob", number: 127, via: "asked" }]).answer).toBe("could-not-tell");
    });

    // the measured second half of the defect: `landed #122` cited BOTH 21fea7b (the ob 122 work) and the
    // real landing of gh#122 via its link to ob 68, so one issue read as landed by two unrelated changes.
    test("an issue is never reported as landed by two unrelated changes", () => {
      const s = state({
        commits: [BAD[0]!, c("290fb4c", "Merge ob 68: dashboard has an Nx test target")],
        unlinkedObItems: unlinked,
      });
      const r = landedIn(s, [
        { namespace: "issue", number: 122, via: "asked" },
        { namespace: "ob", number: 68, via: "link" },
      ]);
      expect(r.landed).toBe(true);
      expect(r.hits).toHaveLength(1);
      expect(r.hits[0]!.ref).toBe("ob 68");
      expect(r.hits[0]!.detail).toContain("290fb4c");
      expect(r.ambiguous.join(" ")).toContain("21fea7b");
    });

    test("a LINKED item is untouched: its `#<n>` merge still resolves confidently", () => {
      // ob 145 is linked to #145, so it is not in `unlinkedObItems` and the marker means what it says
      const s = state({
        commits: [c("f7da68a", "Merge #145: the toolbar readout carries severity")],
        unlinkedObItems: unlinked,
      });
      const r = landedIn(s, [
        { namespace: "issue", number: 145, via: "asked" },
        { namespace: "ob", number: 145, via: "link" },
      ]);
      expect(r.answer).toBe("landed");
      expect(r.fired).toEqual(["merge-commit"]);
      expect(r.hits[0]!.ref).toBe("#145");
      expect(r.ambiguous).toEqual([]);
    });

    // The deliberate cost, stated as a test so it is a decision and not a surprise: gh#120 is linked to ob 65
    // and `Merge #120` is the RIGHT spelling for that pair, but ob item 120 also exists unlinked and its own
    // work landed under the same string. Nothing in either subject settles which, so both are ambiguous. The
    // evidence is still printed, and linking ob 120 is what makes the number readable again.
    test("a linked issue COLLIDING with an unlinked ob id is could-not-tell, evidence and all", () => {
      const s = state({
        commits: [
          c("edf9f37", "Merge #120: the build stamp is part of the Nx cache key"),
          c("68fc8f5", "Merge #120: WhatsApp send persists the row + keeps the chat open"),
        ],
        unlinkedObItems: unlinked,
      });
      const r = landedIn(s, [
        { namespace: "issue", number: 120, via: "asked" },
        { namespace: "ob", number: 65, via: "link" },
      ]);
      expect(r.answer).toBe("could-not-tell");
      expect(r.hits).toEqual([]);
      expect(r.ambiguous).toHaveLength(2);
      expect(r.ambiguous.join(" ")).toContain("68fc8f5");
    });

    test("the house-rule spelling, `Merge ob <n>`, still resolves confidently while unlinked", () => {
      const s = state({
        commits: [c("21fea7b", "Merge ob 122: the app holds its own lease")],
        unlinkedObItems: unlinked,
      });
      const r = landedIn(s, [{ namespace: "ob", number: 122, via: "asked" }]);
      expect(r.answer).toBe("landed");
      expect(r.fired).toEqual(["merge-commit"]);
      expect(r.ambiguous).toEqual([]);
      // and it stays evidence about ob only: #122 is a different sequence
      expect(landedIn(s, [{ namespace: "issue", number: 122, via: "asked" }]).answer).toBe("no-evidence");
    });
  });

  test("multi-ticket landings are found under EACH ref they name", () => {
    const s = state({ commits: [c("aaaaaaa", "Merge #123 + #128: sidebar refreshes on a poll")] });
    expect(landedIn(s, [{ namespace: "issue", number: 123, via: "asked" }]).landed).toBe(true);
    expect(landedIn(s, [{ namespace: "issue", number: 128, via: "asked" }]).landed).toBe(true);
    expect(landedIn(s, [{ namespace: "issue", number: 124, via: "asked" }]).landed).toBe(false);
  });
});

describe("readRepoState reads git through the injected seam (77)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("parses the log, and attributes each merged branch a namespace + own-commit proof", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    restore = __setSh(
      fakeGit({
        log: [c("aaaaaaa1", "Merge ob 55: theme sync"), c("bbbbbbb2", "feat(ob 55): theme sync", "Closes #110")],
        branches: [{ name: "55-theme-sync", tip: "b05a7f7" }],
        firstParent: ["main1", "main2"],
      }),
    );
    const s = await readRepoState("/repo", "main", store);
    expect(s.readable).toBe(true);
    expect(s.commits).toHaveLength(2);
    expect(s.unlinkedObItems).toEqual(new Set());
    // no spinoff row names this branch, so it has no namespace and its own-commits came from first-parent
    expect(s.branches[0]).toMatchObject({ ownCommits: true, proof: "first-parent", mention: null });
  });

  // The whole gh#133 shape, end to end through the git seam: the spinoff row's captured base IS the branch
  // tip, so `rev-list --count base..branch` is 0 and reconcile's own gate excludes it.
  test("REGRESSION: a branch whose captured base is its own tip has no own commits", async () => {
    restore = __setSh(
      fakeGit({
        branches: [{ name: "133-regression", tip: "3bd4b5f" }],
        firstParent: ["3bd4b5f"],
        counts: { "3bd4b5f..133-regression": 0 },
      }),
    );
    const s = (await readRepoState("/repo", "main"));
    expect(s.branches[0]!.ownCommits).toBe(false);
  });

  test("a branch tip sitting on main's first-parent line has no own commits (no base captured)", async () => {
    restore = __setSh(
      fakeGit({ branches: [{ name: "46-never-used", tip: "98696fb" }], firstParent: ["b3e894e", "98696fb"] }),
    );
    expect((await readRepoState("/repo", "main")).branches[0]!.ownCommits).toBe(false);
  });

  test("a branch tip OFF main's first-parent line did contribute work", async () => {
    restore = __setSh(
      fakeGit({ branches: [{ name: "55-theme", tip: "b05a7f7" }], firstParent: ["b3e894e", "98696fb"] }),
    );
    expect((await readRepoState("/repo", "main")).branches[0]!).toMatchObject({ ownCommits: true, proof: "first-parent" });
  });

  // 129: the numbers a `#<n>` cannot be trusted to mean. Closed items count, since ob 120-127 are all done
  // and their merge subjects are still on `main`.
  test("unlinkedObItemIds lists every numeric ob id with no issue link, any status", async () => {
    const dbPath = freshDbPath();
    const unlinked = await seedItem(dbPath, "landed as a hash");
    const linked = await seedItem(dbPath, "properly linked");
    const closed = await seedItem(dbPath, "done and unlinked");
    expect((await runCli(dbPath, ["issue", "link", linked, "#110"])).code).toBe(0);
    expect((await runCli(dbPath, ["close", closed, "--no-github"])).code).toBe(0);
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    expect(await unlinkedObItemIds(store)).toEqual(new Set([Number(unlinked), Number(closed)]));
  });

  test("a git failure is REPORTED, not silently turned into 'no evidence'", async () => {
    restore = __setSh(fakeGit({ failLog: true }));
    const s = (await readRepoState("/repo", "main"));
    expect(s.readable).toBe(false);
    expect(s.readError).toContain("bad revision");
  });
});

describe("candidatePairs (77): flags, never links", () => {
  test("surfaces the unlinked ob 55 / gh#110 shape and explains why", () => {
    const pairs = candidatePairs(
      [{ id: "55", title: "theme sync from a Warp theme", status: "open", branch: "55-theme-sync" }],
      [
        { number: 110, title: "ob theme sync", state: "OPEN" },
        { number: 111, title: "import standalone", state: "OPEN" },
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ item_id: "55", issue: 110 });
    expect(pairs[0]!.reasons.join(" ")).toContain("title");
  });

  test("an already-linked issue is never offered again; unrelated titles produce nothing", () => {
    expect(
      candidatePairs(
        [{ id: "55", title: "theme sync", status: "open", branch: null }],
        [{ number: 110, title: "theme sync", state: "OPEN" }],
        new Set([110]),
      ),
    ).toEqual([]);
    expect(
      candidatePairs(
        [{ id: "9", title: "back up the database monthly", status: "open", branch: null }],
        [{ number: 110, title: "theme sync", state: "OPEN" }],
        new Set(),
      ),
    ).toEqual([]);
  });

  test("titleTokens / titleScore / branchSlug behave", () => {
    expect(titleTokens("ob theme sync")).toEqual(["theme", "sync"]);
    expect(titleScore("ob theme sync", "theme sync from a warp theme")).toBeGreaterThan(0.9);
    expect(titleScore("landing closes both trackers", "import standalone")).toBe(0);
    expect(branchSlug("55-theme-sync")).toBe("theme-sync");
    expect(branchSlugsAgree("55-theme-sync", { number: 110, title: "ob theme sync" })).toBe(true);
    expect(branchSlugsAgree("9-fix", { number: 3, title: "fix" })).toBe(false);
  });
});

describe("an item holds ONE reference, and neither kind may eat the other (77)", () => {
  test("issue link REFUSES an item carrying a Linear ref, and leaves it intact", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "a cue reference");
    const linearUrl = "https://linear.app/cue/issue/CUE-1234/make-it-work";
    await attachLinear(openDb(dbPath), id, linearUrl);
    const r = await runCli(dbPath, ["issue", "link", id, "#7"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already carries a Linear reference");
    expect(r.err).toContain("CUE-1234");
    // the Linear ref survived, id and url both
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    expect(await getLinearOnlyRef(db, id)).toEqual({ linear_id: "CUE-1234", url: linearUrl });
    expect(await getIssueLink(db, id)).toBeNull();
    expect((await runCli(dbPath, ["show", id])).out).toContain("CUE-1234");
  });

  test("ob linear is not a command", async () => {
    const r = await runCli(freshDbPath(), ["linear", "1", "--url", "https://linear.app/cue/issue/CUE-1234/x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'linear'");
  });

  test("unlink then issue-link is the sanctioned route off a leftover Linear ref", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "switching kinds");
    await attachLinear(openDb(dbPath), id, "https://linear.app/cue/issue/CUE-1/x");
    expect((await runCli(dbPath, ["issue", "unlink", id])).code).toBe(0);
    expect((await runCli(dbPath, ["issue", "link", id, "#7"])).code).toBe(0);
    expect((await getIssueLink(openDb(dbPath), id))!.number).toBe(7);
  });
});

describe("a wrong reference costs a command, never the item (138)", () => {
  const LINEAR_URL = "https://linear.app/cue/issue/CUE-1234/make-it-work";

  /** An item carrying everything `ob rm` would have taken with it. */
  async function seedFurnishedItem(dbPath: string, title: string): Promise<{ id: string; other: string }> {
    const id = await seedItem(dbPath, title);
    const other = await seedItem(dbPath, "the neighbour");
    expect((await runCli(dbPath, ["note", id, "a note worth keeping"])).code).toBe(0);
    expect((await runCli(dbPath, ["tag", id, "maintenance"])).code).toBe(0);
    expect((await runCli(dbPath, ["link", id, "references", other])).code).toBe(0);
    expect((await runCli(dbPath, ["start", id])).code).toBe(0);
    return { id, other };
  }

  async function expectSurvived(dbPath: string, id: string, other: string): Promise<void> {
    const shown = await runCli(dbPath, ["show", id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("a note worth keeping");
    expect(shown.out).toContain("maintenance");
    expect(shown.out).toContain(`references ${other}`);
    expect(shown.out).toContain("status:    in_progress");
  }

  test("the refusal names 'ob issue unlink', and never suggests deleting the item", async () => {
    const dbPath = freshDbPath();
    const { id, other } = await seedFurnishedItem(dbPath, "a cue reference with history");
    await attachLinear(openDb(dbPath), id, LINEAR_URL);
    const r = await runCli(dbPath, ["issue", "link", id, "#7"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`ob issue unlink ${id}`);
    expect(r.err).toContain(`ob issue link ${id} #7`);
    expect(r.err).not.toContain("ob rm");
    expect(r.err).not.toContain("re-add");
    await expectSurvived(dbPath, id, other);
  });

  test("unlink clears a Linear ref, keeps the item, and writes nothing to Linear", async () => {
    const dbPath = freshDbPath();
    const { id, other } = await seedFurnishedItem(dbPath, "a cue reference to clear");
    await attachLinear(openDb(dbPath), id, LINEAR_URL);
    const r = await runCli(dbPath, ["issue", "unlink", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no longer carries its Linear reference");
    expect(r.out).toContain("nothing in Linear was touched");
    expect(await getLinearOnlyRef(openDb(dbPath), id)).toBeNull();
    expect((await runCli(dbPath, ["show", id])).out).not.toContain("CUE-1234");
    await expectSurvived(dbPath, id, other);
  });

  test("clearing the Linear ref is the whole remedy: the refused link then goes through", async () => {
    const dbPath = freshDbPath();
    const { id, other } = await seedFurnishedItem(dbPath, "switch to the github side");
    await attachLinear(openDb(dbPath), id, LINEAR_URL);
    expect((await runCli(dbPath, ["issue", "link", id, "#7"])).code).toBe(1);
    expect((await runCli(dbPath, ["issue", "unlink", id])).code).toBe(0);
    expect((await runCli(dbPath, ["issue", "link", id, "#7"])).code).toBe(0);
    expect((await getIssueLink(openDb(dbPath), id))!.number).toBe(7);
    await expectSurvived(dbPath, id, other);
  });

  test("unlink clears a GitHub ref and keeps the item and everything attached", async () => {
    const dbPath = freshDbPath();
    const { id, other } = await seedFurnishedItem(dbPath, "a github pairing to clear");
    expect((await runCli(dbPath, ["issue", "link", id, "#7"])).code).toBe(0);
    const r = await runCli(dbPath, ["issue", "unlink", id]);
    expect(r.out).toContain("no longer linked to issue #7");
    expect(await getIssueLink(openDb(dbPath), id)).toBeNull();
    await expectSurvived(dbPath, id, other);
  });

  test("--json reports which kind of reference was cleared", async () => {
    const dbPath = freshDbPath();
    const gh = await seedItem(dbPath, "json github");
    await runCli(dbPath, ["issue", "link", gh, "#7"]);
    expect(JSON.parse((await runCli(dbPath, ["issue", "unlink", gh, "--json"])).out)).toEqual({
      id: gh,
      unlinked: 7,
      cleared: { kind: "issue", url: issueUrl(REPO, 7) },
    });
    const lin = await seedItem(dbPath, "json linear");
    await attachLinear(openDb(dbPath), lin, LINEAR_URL);
    expect(JSON.parse((await runCli(dbPath, ["issue", "unlink", lin, "--json"])).out)).toEqual({
      id: lin,
      unlinked: null,
      cleared: { kind: "linear", url: LINEAR_URL },
    });
  });
});

describe("ob close closes the linked GitHub issue too (77)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  function stubIssueState(): { calls: Array<{ repo: string; number: number; want: string }> } {
    const calls: Array<{ repo: string; number: number; want: string }> = [];
    restores.push(
      __setSetIssueState(async (_db, repo, number, want): Promise<IssueStateChange> => {
        calls.push({ repo, number, want });
        return { number, url: issueUrl(repo, number), title: "t", state: want, already: false };
      }),
    );
    return { calls };
  }

  test("a linked item: the issue is closed and named in the output", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "landing closes both trackers");
    expect((await runCli(dbPath, ["issue", "link", id, "#129"])).code).toBe(0);
    const r = await runCli(dbPath, ["close", id]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ repo: REPO, number: 129, want: "closed" }]);
    expect(r.out).toContain("closed issue #129");
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status).toBe("done");
  });

  test("--json reports the issue it closed", async () => {
    stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "a linked task");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["close", id, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ id, issue: 7, issue_state: "closed", skipped: null, error: null });
  });

  test("no link: nothing is attempted and the output is the item's ref (1949)", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "a purely local task");
    const r = await runCli(dbPath, ["close", id]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out.trim()).toBe("OB-1");
  });

  test("--no-github skips the call but still closes locally", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "skip the github side");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["close", id, "--no-github"]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("--no-github");
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status).toBe("done");
  });

  test("--dry-run writes NOTHING on either side and says what it would have done", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "dry run the github side");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["close", id, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain(`would close ob ${id}`);
    expect(r.out).toContain("would close issue #7");
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status).toBe("open");
  });

  test("--dry-run still validates the transition, so a preview cannot promise an impossible move", async () => {
    stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "already closed");
    await runCli(dbPath, ["close", id, "--no-github"]);
    const r = await runCli(dbPath, ["reopen", id, "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id, dry_run: true, would: "reopen" });
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status).toBe("done");
    await runCli(dbPath, ["reopen", id, "--no-github"]);
    const bad = await runCli(dbPath, ["reopen", id, "--dry-run"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("is not closed");
  });

  test("a link on ANOTHER repo is refused, not followed", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "linked to a foreign repo");
    await runCli(dbPath, ["issue", "link", id, issueUrl("someone/else", 3)]);
    const r = await runCli(dbPath, ["close", id]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("not the tracker repo");
  });

  test("an issue already closed is reported as such, not as a fresh close", async () => {
    restores.push(
      __setSetIssueState(async (_db, repo, number, want) => ({
        number,
        url: issueUrl(repo, number),
        title: "t",
        state: want,
        already: true,
      })),
    );
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "already closed upstream");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    expect((await runCli(dbPath, ["close", id])).out).toContain("was already closed");
  });

  test("a GitHub failure keeps the local close, warns loudly, and exits 1", async () => {
    restores.push(
      __setSetIssueState(async () => {
        throw new Error("no github token");
      }),
    );
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "github is down");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["close", id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("out of sync");
    expect(r.err).toContain("no github token");
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status).toBe("done");
  });

  test("a GitHub failure under --json still prints the report on stdout", async () => {
    restores.push(
      __setSetIssueState(async () => {
        throw new Error("boom");
      }),
    );
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "json failure path");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["close", id, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ id, issue: 7, error: "boom" });
  });

  test("ob reopen reopens the linked issue", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "reopen both sides");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    await runCli(dbPath, ["close", id]);
    const r = await runCli(dbPath, ["reopen", id]);
    expect(r.code).toBe(0);
    expect(calls.map((x) => x.want)).toEqual(["closed", "open"]);
    expect(r.out).toContain("reopened issue #7");
  });

  // `state <id> done` is the same landing, so it must not be a second, unmirrored door.
  test("ob state <id> done mirrors exactly like close", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "closed via state");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["state", id, "done"]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ repo: REPO, number: 7, want: "closed" }]);
    expect(r.out).toContain("closed issue #7");
  });

  test("ob state <id> in_progress is untouched by the mirror", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "just starting");
    await runCli(dbPath, ["issue", "link", id, "#7"]);
    const r = await runCli(dbPath, ["state", id, "in_progress"]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out.trim()).toBe("OB-1");
  });

  // The drift remedy IS `ob close <id>` on an already-done item, so a re-close must not move the date.
  test("re-closing an already-done item preserves the original closed_at", async () => {
    stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "closed twice");
    await runCli(dbPath, ["close", id, "--no-github"]);
    const first = JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).closed_at;
    expect(first).toBeTruthy();
    await runCli(dbPath, ["close", id, "--no-github"]);
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).closed_at).toBe(first);
    // a genuine reopen -> close does stamp a fresh date
    await runCli(dbPath, ["reopen", id, "--no-github"]);
    expect(JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).closed_at).toBeNull();
  });

  // 394: postgres / the API host has no bun:sqlite handle. The GitHub half must still run.
  function storeWithoutSqlite(dbPath: string) {
    const store = sqliteStoreFor(openDb(dbPath));
    return { ...store, sqlite: null };
  }

  test("a store with no sqlite handle still closes the linked issue (394)", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "api host close");
    expect((await runCli(dbPath, ["issue", "link", id, "#183"])).code).toBe(0);
    const outcome = await syncIssueState(storeWithoutSqlite(dbPath), id, "closed");
    expect(outcome.error).toBeNull();
    expect(outcome.skipped).toBeNull();
    expect(outcome.change).toMatchObject({ number: 183, state: "closed", already: false });
    expect(calls).toEqual([{ repo: REPO, number: 183, want: "closed" }]);
  });

  test("a store with no sqlite handle still reopens the linked issue (394)", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "api host reopen");
    await runCli(dbPath, ["issue", "link", id, "#183"]);
    const outcome = await syncIssueState(storeWithoutSqlite(dbPath), id, "open");
    expect(outcome.error).toBeNull();
    expect(outcome.change).toMatchObject({ number: 183, state: "open" });
    expect(calls).toEqual([{ repo: REPO, number: 183, want: "open" }]);
  });

  test("a store with no sqlite handle still honours --no-github (394)", async () => {
    const { calls } = stubIssueState();
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "api host skip");
    await runCli(dbPath, ["issue", "link", id, "#183"]);
    const outcome = await syncIssueState(storeWithoutSqlite(dbPath), id, "closed", { skip: true });
    expect(outcome).toMatchObject({ skipped: "flag", change: null, error: null });
    expect(calls).toEqual([]);
  });

  test("a store with no sqlite handle still reports a GitHub failure as error, not a throw (394)", async () => {
    restores.push(
      __setSetIssueState(async () => {
        throw new Error("no github token");
      }),
    );
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "api host fail");
    await runCli(dbPath, ["issue", "link", id, "#183"]);
    const outcome = await syncIssueState(storeWithoutSqlite(dbPath), id, "closed");
    expect(outcome.error).toBe("no github token");
    expect(outcome.change).toBeNull();
    expect(outcome.link?.number).toBe(183);
  });
});

// The code that DECIDES whether to mutate, exercised through the transport seam: no token, no network.
describe("setIssueStateLive decides correctly (77)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  // The GraphQL transport is STUBBED below, so no request leaves this process and the token's VALUE is
  // irrelevant -- but `readGithubToken` still has to find one, and a seat with no `gh` login, no
  // GITHUB_TOKEN and no legacy token file cannot. Pin one for this block and put it back after, so the
  // suite does not depend on the developer's GitHub login: acquisition is `readGithubToken`'s own
  // subject, not what these decision tests measure.
  const savedToken = process.env.GITHUB_TOKEN;
  beforeAll(() => {
    process.env.GITHUB_TOKEN = "test-token-never-sent";
  });
  afterAll(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  function stubGql(issue: { id: string; number: number; url: string; state: string; title: string } | null) {
    const sent: Array<{ query: string; variables: Record<string, unknown> }> = [];
    restores.push(
      __setGithubGql(async <T,>(_token: string, query: string, variables: Record<string, unknown>): Promise<T> => {
        sent.push({ query, variables });
        if (query.includes("query(")) return { repository: { issue } } as T;
        const key = query.includes("closeIssue") ? "closeIssue" : "reopenIssue";
        return {
          [key]: { issue: { number: issue!.number, url: issue!.url, state: key === "closeIssue" ? "CLOSED" : "OPEN" } },
        } as T;
      }),
    );
    return sent;
  }

  const db = () => openDb(freshDbPath());
  const open = { id: "NODE1", number: 7, url: `https://github.com/${REPO}/issues/7`, state: "OPEN", title: "a task" };

  test("an OPEN issue asked to close sends closeIssue and reports a real change", async () => {
    const sent = stubGql(open);
    const r = await closeIssue(db(), REPO, 7);
    expect(r).toMatchObject({ number: 7, state: "closed", already: false, title: "a task" });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.query).toContain("closeIssue");
    expect(sent[1]!.variables).toEqual({ issueId: "NODE1" });
  });

  test("an ALREADY-closed issue is a no-op: no mutation is sent at all", async () => {
    const sent = stubGql({ ...open, state: "CLOSED" });
    const r = await closeIssue(db(), REPO, 7);
    expect(r).toMatchObject({ number: 7, state: "closed", already: true });
    expect(sent).toHaveLength(1); // the lookup only
    expect(sent[0]!.query).toContain("query(");
  });

  test("an ALREADY-open issue asked to reopen is likewise a no-op", async () => {
    const sent = stubGql(open);
    const r = await reopenIssue(db(), REPO, 7);
    expect(r).toMatchObject({ state: "open", already: true });
    expect(sent).toHaveLength(1);
  });

  test("a CLOSED issue asked to reopen sends reopenIssue", async () => {
    const sent = stubGql({ ...open, state: "CLOSED" });
    const r = await reopenIssue(db(), REPO, 7);
    expect(r).toMatchObject({ state: "open", already: false });
    expect(sent[1]!.query).toContain("reopenIssue");
  });

  test("an issue that does not exist is refused, never blindly mutated", async () => {
    const sent = stubGql(null);
    await expect(closeIssue(db(), REPO, 404)).rejects.toThrow("issue #404 not found");
    expect(sent).toHaveLength(1);
  });

  test("a malformed repo is refused before any request", async () => {
    const sent = stubGql(open);
    await expect(closeIssue(db(), "not-a-slug", 7)).rejects.toThrow("invalid repo");
    expect(sent).toHaveLength(0);
  });
});

describe("ob issue link / unlink / list (77)", () => {
  test("link stores the pairing where ob show renders it, labelled 'issue:'", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "pair me up");
    const r = await runCli(dbPath, ["issue", "link", id, "#122"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`ob ${id} <-> issue #122`);
    const shown = await runCli(dbPath, ["show", id]);
    expect(shown.out).toContain("issue:     #122");
    expect(shown.out).not.toContain("linear:");
  });

  test("a full issue URL links too, and carries its own repo", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "link by url");
    const r = await runCli(dbPath, ["issue", "link", id, issueUrl("o/r", 5), "--json"]);
    expect(JSON.parse(r.out)).toEqual({ id, issue: 5, url: issueUrl("o/r", 5) });
  });

  test("linking an issue already paired elsewhere is refused", async () => {
    const dbPath = freshDbPath();
    const a = await seedItem(dbPath, "first claimant");
    const b = await seedItem(dbPath, "second claimant");
    await runCli(dbPath, ["issue", "link", a, "#122"]);
    const r = await runCli(dbPath, ["issue", "link", b, "#122"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`already linked to ob ${a}`);
  });

  test("re-linking the SAME item to the same issue is idempotent", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "idempotent link");
    await runCli(dbPath, ["issue", "link", id, "#122"]);
    expect((await runCli(dbPath, ["issue", "link", id, "#122"])).code).toBe(0);
  });

  test("unlink drops it; list shows the current pairs", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "pair then unpair");
    await runCli(dbPath, ["issue", "link", id, "#122"]);
    expect(JSON.parse((await runCli(dbPath, ["issue", "list", "--json"])).out)).toHaveLength(1);
    expect((await runCli(dbPath, ["issue"])).out).toContain("#122");
    const r = await runCli(dbPath, ["issue", "unlink", id]);
    expect(r.out).toContain("no longer linked");
    expect(JSON.parse((await runCli(dbPath, ["issue", "list", "--json"])).out)).toEqual([]);
    expect(await getIssueLink(openDb(dbPath), id)).toBeNull();
    expect((await runCli(dbPath, ["issue", "link", id, "#122"])).code).toBe(0);
  });

  test("unlink on an item with no reference says so and changes nothing", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "never linked");
    const r = await runCli(dbPath, ["issue", "unlink", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("carries no reference to clear");
    expect(JSON.parse((await runCli(dbPath, ["issue", "unlink", id, "--json"])).out)).toEqual({
      id,
      unlinked: null,
      cleared: null,
    });
    expect((await runCli(dbPath, ["show", id])).out).toContain("never linked");
  });

  test("an unknown subcommand is a usage error", async () => {
    const r = await runCli(freshDbPath(), ["issue", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown 'issue' subcommand");
  });
});

describe("ob issue landed (77)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a linked pair is checked under BOTH numberings and reports the evidence", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "theme sync");
    await runCli(dbPath, ["issue", "link", id, "#110"]);
    restore = __setSh(fakeGit({ log: [c("b7e53c4", `Merge ob ${id}: theme sync`)] }));
    const r = await runCli(dbPath, ["issue", "landed", "#110", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.landed).toBe(true);
    expect(out.refs).toEqual(["#110", `ob ${id}`]);
    expect(out.fired).toEqual(["merge-commit"]);
  });

  test("the namespace collision: ob evidence alone does NOT mark an issue landed", async () => {
    const dbPath = freshDbPath();
    restore = __setSh(
      fakeGit({
        log: [c("b3e894e", "Merge ob 75: lease release and agent register are symmetric")],
        branches: [{ name: "75-lease-release-holder", tip: "d4e29a4" }],
        firstParent: ["b3e894e"],
      }),
    );
    const r = await runCli(dbPath, ["issue", "landed", "#75"]);
    expect(r.code).toBe(0);
    // the `75-*` branch matches the NUMBER with nothing saying which numbering, so this is COULD NOT TELL
    expect(r.out).toContain("COULD NOT TELL");
    expect(r.out).not.toContain("ALREADY ON MAIN");
    expect(r.out).toContain("signals hit: none");
    expect(r.out).toContain("INDEPENDENT sequences");
  });

  test("the SAME state answers 'landed' for the ob-namespace ref", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "seventy five");
    restore = __setSh(fakeGit({ log: [c("b3e894e", `Merge ob ${id}: lease release`)] }));
    const r = await runCli(dbPath, ["issue", "landed", id]);
    expect(r.out).toContain("ALREADY ON MAIN");
    expect(r.out).toContain("signals hit: merge-commit");
    expect(r.out).toContain("do NOT dispatch");
  });

  test("an unlinked ref checks one numbering and SAYS so", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "unlinked work");
    restore = __setSh(fakeGit({}));
    const r = await runCli(dbPath, ["issue", "landed", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no evidence on main");
    expect(r.out).toContain("only ONE numbering was checked");
    expect((await runCli(dbPath, ["issue", "landed", id, "-q"])).out.trim()).toBe("not-landed");
  });

  test("a --repo that is not a git checkout is an ERROR, never a silent 'no evidence'", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "bad repo flag");
    restore = __setSh(fakeGit({ failing: true }));
    const r = await runCli(dbPath, ["issue", "landed", id, "--repo", "omnislash"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not a git checkout");
  });

  test("a checkout that is NOT the tracker repo is refused, not answered from", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "wrong repo");
    restore = __setSh(fakeGit({ toplevel: "/Users/me/dev/cue-frontend", remote: "git@github.com:acmecorp/cue-frontend.git" }));
    const r = await runCli(dbPath, ["issue", "landed", id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("acmecorp/cue-frontend");
    expect(r.err).toContain(`not the tracker repo '${REPO}'`);
  });

  test("a checkout with no recognisable remote is refused too", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "no remote");
    restore = __setSh(fakeGit({ remote: null }));
    const r = await runCli(dbPath, ["issue", "landed", id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no recognisable GitHub remote");
  });

  test("an unreadable checkout reports COULD NOT READ, distinct from 'no evidence'", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "unreadable");
    restore = __setSh(fakeGit({ failLog: true }));
    const r = await runCli(dbPath, ["issue", "landed", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("COULD NOT READ");
    expect(r.out).toContain("NOT 'no evidence'");
    expect(r.out).not.toContain("ALREADY ON MAIN");
    expect(JSON.parse((await runCli(dbPath, ["issue", "landed", id, "--json"])).out)).toMatchObject({
      readable: false,
      landed: false,
    });
  });

  test("REGRESSION: a zero-commit branch off main is not landed, but a real one is", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "zero commit branch");
    // the branch carries this item's number and is 'merged', but its tip sits on main's own trunk
    restore = __setSh(
      fakeGit({ branches: [{ name: `${id}-fresh-branch`, tip: "3bd4b5f" }], firstParent: ["b3e894e", "3bd4b5f"] }),
    );
    expect((await runCli(dbPath, ["issue", "landed", id])).out).toContain("no evidence on main");
    // the same branch, tip OFF the trunk: real work, and now attributed via a spinoff row
    restore();
    restore = __setSh(
      fakeGit({ branches: [{ name: `${id}-fresh-branch`, tip: "cafe123" }], firstParent: ["b3e894e", "3bd4b5f"] }),
    );
    const out = await runCli(dbPath, ["issue", "landed", id]);
    // still ambiguous: no spinoff row says which namespace `<id>-` means
    expect(out.out).toContain("COULD NOT TELL");
    expect(out.out).toContain("ambiguous");
  });

  test("multi-ticket landings are found for every ref named", async () => {
    const dbPath = freshDbPath();
    restore = __setSh(fakeGit({ log: [c("aaaaaaa", "Merge #123 + #128: sidebar refreshes on a poll")] }));
    expect((await runCli(dbPath, ["issue", "landed", "#128"])).out).toContain("ALREADY ON MAIN");
    expect((await runCli(dbPath, ["issue", "landed", "#123"])).out).toContain("ALREADY ON MAIN");
    expect((await runCli(dbPath, ["issue", "landed", "#124"])).out).toContain("no evidence");
  });

  // 129, end to end: the ob namespace is read from the db, so the collision is detected by the command
  // itself rather than only by `landedIn` over a hand-built state.
  test("a `#<id>` merge for an UNLINKED item answers COULD NOT TELL under BOTH numberings", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "the app holds its own lease");
    restore = __setSh(fakeGit({ log: [c("21fea7b", `Merge #${id}: the app holds its own lease`)] }));

    const byOb = await runCli(dbPath, ["issue", "landed", id]);
    expect(byOb.code).toBe(0);
    expect(byOb.out).toContain("COULD NOT TELL");
    expect(byOb.out).not.toContain("no evidence on main");
    expect(byOb.out).toContain("21fea7b");
    expect(byOb.out).toContain(`Merge ob <n>`);
    expect(byOb.out).toContain("NOT 'no evidence'");

    const byIssue = await runCli(dbPath, ["issue", "landed", `#${id}`]);
    expect(byIssue.out).toContain("COULD NOT TELL");
    expect(byIssue.out).not.toContain("ALREADY ON MAIN");

    expect((await runCli(dbPath, ["issue", "landed", id, "-q"])).out.trim()).toBe("could-not-tell");
    expect(JSON.parse((await runCli(dbPath, ["issue", "landed", id, "--json"])).out)).toMatchObject({
      landed: false,
      answer: "could-not-tell",
      readable: true,
    });
  });

  test("LINKING the item is what makes the same `#<n>` merge confident again", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "the app holds its own lease");
    expect((await runCli(dbPath, ["issue", "link", id, "#110"])).code).toBe(0);
    restore = __setSh(fakeGit({ log: [c("f7da68a", "Merge #110: the app holds its own lease")] }));
    const r = await runCli(dbPath, ["issue", "landed", "#110", "--json"]);
    const out = JSON.parse(r.out);
    expect(out.answer).toBe("landed");
    expect(out.landed).toBe(true);
    expect(out.fired).toEqual(["merge-commit"]);
    expect(out.hits[0].ref).toBe("#110");
    expect(out.ambiguous).toEqual([]);
  });

  test("the house-rule spelling of an unlinked item is confident, and only about ob", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "the build stamp is part of the Nx cache key");
    restore = __setSh(fakeGit({ log: [c("edf9f37", `Merge ob ${id}: the build stamp is part of the Nx cache key`)] }));
    expect((await runCli(dbPath, ["issue", "landed", id])).out).toContain("ALREADY ON MAIN");
    expect((await runCli(dbPath, ["issue", "landed", `#${id}`])).out).toContain("no evidence on main");
  });

  test("a prose mention is not a landing (the unanchored-paren defect)", async () => {
    const dbPath = freshDbPath();
    restore = __setSh(
      fakeGit({ log: [c("5caf518", "docs(104): reconcile #24 with the WhatsApp map", "notes (#26) here")] }),
    );
    expect((await runCli(dbPath, ["issue", "landed", "#26"])).out).toContain("no evidence");
    expect((await runCli(dbPath, ["issue", "landed", "#24"])).out).toContain("no evidence");
  });
});

describe("ob issue reconcile / drift (77)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  function stubIssues(issues: Array<Partial<GithubIssue> & { number: number; title: string }>) {
    restores.push(
      __setListIssues(async (_db, repo) => {
        expect(repo).toBe(REPO);
        return issues.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state ?? "OPEN",
          assignees: i.assignees ?? [],
          labels: i.labels ?? ["wayfinder:task"],
          body: i.body ?? null,
          url: i.url ?? issueUrl(REPO, i.number),
        }));
      }),
    );
  }

  test("reconcile offers the pair and prints the link command; links nothing", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "theme sync from a Warp theme");
    stubIssues([
      { number: 110, title: "ob theme sync" },
      { number: 111, title: "import standalone" },
    ]);
    const r = await runCli(dbPath, ["issue", "reconcile"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#110");
    expect(r.out).not.toContain("#111");
    expect(r.out).toContain(`ob issue link ${id} #110`);
    expect(JSON.parse((await runCli(dbPath, ["issue", "list", "--json"])).out)).toEqual([]);
  });

  test("reconcile reports nothing once the pair is linked", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "theme sync from a Warp theme");
    stubIssues([{ number: 110, title: "ob theme sync" }]);
    await runCli(dbPath, ["issue", "link", id, "#110"]);
    expect(JSON.parse((await runCli(dbPath, ["issue", "reconcile", "--json"])).out).candidates).toEqual([]);
  });

  test("drift: an OPEN issue whose feature is on main is flagged, with the signal that fired", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "theme sync");
    await runCli(dbPath, ["issue", "link", id, "#110"]);
    stubIssues([{ number: 110, title: "ob theme sync" }]);
    restores.push(__setSh(fakeGit({ log: [c("b7e53c4", `Merge ob ${id}: theme sync`)] })));
    const r = await runCli(dbPath, ["issue", "drift"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already on main");
    expect(r.out).toContain("merge-commit");
    expect(r.out).toContain(`ob close ${id}`);
  });

  test("drift: ob-namespace evidence for an UNLINKED issue never advises closing it", async () => {
    const dbPath = freshDbPath();
    stubIssues([{ number: 75, title: "workspace T8: sidebar presentation polish" }]);
    restores.push(
      __setSh(
        fakeGit({
          log: [c("b3e894e", "Merge ob 75: lease release and agent register are symmetric")],
          branches: [{ name: "75-lease-release-holder", tip: "d4e29a4" }],
          firstParent: ["b3e894e"],
        }),
      ),
    );
    const r = await runCli(dbPath, ["issue", "drift"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No tracker drift");
    expect(r.out).not.toContain("gh issue close 75");
  });

  test("drift: the reverse direction, a CLOSED issue whose ob item is still open", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "still open locally");
    await runCli(dbPath, ["issue", "link", id, "#110"]);
    stubIssues([{ number: 110, title: "done upstream", state: "CLOSED" }]);
    restores.push(__setSh(fakeGit({})));
    const rows = JSON.parse((await runCli(dbPath, ["issue", "drift", "--json"])).out).drift;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "issue-closed-but-item-open", issue: 110, item_id: id });
  });

  test("drift: nothing to report reads cleanly", async () => {
    const dbPath = freshDbPath();
    stubIssues([{ number: 110, title: "not built yet" }]);
    restores.push(__setSh(fakeGit({})));
    expect((await runCli(dbPath, ["issue", "drift"])).out).toContain("No tracker drift");
  });

  test("drift: an unreadable checkout yields NO rows rather than bogus advice", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    restores.push(__setSh(fakeGit({ failLog: true })));
    expect(
      await computeDrift({
        checkout: "/repo",
        trackerRepo: REPO,
        store,
        issues: [{ number: 110, title: "x", state: "OPEN", assignees: [], labels: [], body: null, url: "" }],
      }),
    ).toEqual([]);
  });

  test("computeDrift is read-only over an injected issue list", async () => {
    const dbPath = freshDbPath();
    const id = await seedItem(dbPath, "read only");
    await runCli(dbPath, ["issue", "link", id, "#110"]);
    restores.push(__setSh(fakeGit({})));
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    const rows = await computeDrift({
      checkout: "/repo",
      trackerRepo: REPO,
      store,
      issues: [{ number: 110, title: "x", state: "CLOSED", assignees: [], labels: [], body: null, url: "" }],
    });
    expect(rows).toHaveLength(1);
    expect((await getIssueLink(db, id))!.number).toBe(110);
  });
});
