// ob 1319 -- `ob google auth-url` must be SERVED, and the split that makes it servable must stay split.
//
// Measured 2026-10-18: the hosted mint (`POST /api/ob/google/auth-url`) answered 200 with the consent URL
// while the server's `OB_API_LOCAL_ONLY` still carried a `google` row, so a client asking for the link was
// told `google` "is a LOCAL-ONLY command and is deliberately not served" and the tap-to-reauth URL had to
// be minted with `curl`. Same shape as ob 360: a whole command classified together when only one half
// belongs on this machine -- `auth` (browser + 127.0.0.1) runs here, `auth-url` (an authenticated API
// call) belongs over the wire.
//
// Re-adding that row left the whole `cli-core` suite green -- no neighbouring pin reads this list for a row
// being ADDED -- so this file exists for that one assertion plus the doc claim the acceptance asks for.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OB_API_LOCAL_ONLY } from "../../../apps/cli/src/api/contract.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";

const README = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");

describe("the split, which was the bug (1319)", () => {
	test("the server's not-served list has no `google` row", () => {
		// server.ts consults this list for a path whose `/google` segment matched no route, and this list is
		// the only thing that produces the ticket's refusal. `auth-url` is a bearer-authenticated POST
		// route, so the reason a `google` row carried was about the loopback half, never the family.
		expect(OB_API_LOCAL_ONLY.google).toBeUndefined();
	});
});

describe("docs name which google subcommand is served (1319)", () => {
	test("HELP's google section marks auth-url as served", () => {
		// The entry as `ob --help` prints it: its own line, up to the next entry (the same two-space
		// indent). Scoping to the entry is the point of the test -- the section must say WHICH subcommand
		// is served, not merely contain the word.
		const entry = HELP.match(/\n {2}google auth-url[\s\S]*?(?=\n {2}\S|$)/)?.[0] ?? "";
		expect(entry.length).toBeGreaterThan(0); // renamed or reordered: fail loudly, never "nothing to check"
		expect(entry).toMatch(/served/i);
		// Without this line "not served" would satisfy the one above.
		expect(entry).not.toMatch(/not served/i);
	});

	test("the README says which google subcommand is served", () => {
		// Where it says it is free to move (the split table row today, the hosted section below it): the
		// acceptance asks the README to say it, so the pin is on the claim, not on a row or its punctuation.
		expect(README).toMatch(/`google auth-url`[\s\S]{0,120}?served/i);
	});
});
