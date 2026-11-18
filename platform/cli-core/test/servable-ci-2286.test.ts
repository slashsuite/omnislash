// OB-2286: `ob ci` and `ob github` are served on the Postgres server. The hourly `ci-main` unit runs
// `ob ci main --notify` directly on the API host, so the servable list is what let it run at all: before this it
// refused with "not ported to the store seam yet". Both commands reach only ci-main.ts through ctx.store.
import { describe, expect, test } from "bun:test";
import { POSTGRES_SERVABLE_COMMANDS } from "../../../apps/cli/src/db/servable.ts";
import { jobForInvocation } from "../../../apps/cli/src/jobs.ts";

describe("OB-2286: ci and github are servable on Postgres", () => {
	test("both commands are on the servable list", () => {
		expect(POSTGRES_SERVABLE_COMMANDS.has("ci")).toBe(true);
		expect(POSTGRES_SERVABLE_COMMANDS.has("github")).toBe(true);
	});

	test("`ob ci main --notify` maps to the ci-main job the hourly unit records", () => {
		expect(jobForInvocation("ci", ["main"], { notify: true })).toBe("ci-main");
	});
});
