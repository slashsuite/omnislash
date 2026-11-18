// ob 337j: the connection url is now the FIRST thing a fresh machine has to get right.
//
// Postgres became the built-in default once the cutover finished, so nothing stands between a new shell
// and this code path. Two failures live here, and both were paid for in real time during the cutover:
// there is no url file at all, and there is a url whose password was not percent-encoded (`openssl rand
// -base64` emits +, / and =, every one of which is url syntax). Bun's driver reports the second as a flat
// "cannot be parsed as a URL" that names no field, no character and no fix.
//
// So these assert the two messages TEACH rather than complain -- and that neither one prints the url,
// because an error is the single most likely thing to be pasted into a chat window and that one carries
// a password.
import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
	checkPgUrl,
	defaultPgUrlPath,
	missingPgUrlMessage,
	PG_URL_ENV,
	PG_URL_FILE_ENV,
	resolvePgUrl,
	STORE_ENV,
} from "../../../apps/cli/src/db/store.ts";

const SECRET = "p+a/ss=word";
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ob-337j-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	delete process.env[PG_URL_ENV];
	delete process.env[PG_URL_FILE_ENV];
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ob 337j: the missing-url refusal is a setup guide", () => {
	test("it names the file it looked for, the mode, and how to write it", () => {
		const path = join(tempDir(), "absent_pg_url");
		process.env[PG_URL_FILE_ENV] = path;
		let message = "";
		try {
			resolvePgUrl();
		} catch (err) {
			message = (err as AppError).message;
		}
		expect(message).toContain(path);
		expect(message).toContain("0600");
		expect(message).toContain("chmod");
		expect(message).toContain("printf");
		// the trap that cost the cutover real time
		expect(message).toContain("PERCENT-ENCODE");
		// and the way out, so a machine with no cluster reachable is not simply stuck
		expect(message).toContain(`${STORE_ENV}=sqlite`);
	});

	test("the default path is the home-directory token file, so a fresh machine needs no variable", () => {
		expect(defaultPgUrlPath().endsWith("/.omnislash_pg_url")).toBe(true);
		expect(missingPgUrlMessage(defaultPgUrlPath())).toContain(defaultPgUrlPath());
	});
});

describe("ob 337j: an unencoded password fails with its own diagnosis, not the driver's", () => {
	test("a url that cannot be parsed says WHY, and names percent-encoding", () => {
		let message = "";
		try {
			checkPgUrl(`postgres://ob:${SECRET}@host:5432/omnislash`, PG_URL_ENV);
		} catch (err) {
			message = (err as AppError).message;
		}
		expect(message).toContain("PERCENT-ENCODE");
		expect(message).toContain("encodeURIComponent");
		expect(message).toContain(PG_URL_ENV);
	});

	test("neither refusal ever prints the url or the password", () => {
		const dir = tempDir();
		const path = join(dir, "pg_url");
		writeFileSync(path, `postgres://ob:${SECRET}@host:5432/omnislash\n`);
		chmodSync(path, 0o600);
		process.env[PG_URL_FILE_ENV] = path;
		let message = "";
		try {
			resolvePgUrl();
		} catch (err) {
			message = (err as AppError).message;
		}
		expect(message).not.toContain(SECRET);
		expect(message).not.toContain("postgres://ob:");
		// it still names the SOURCE, which is what a human needs in order to go and fix it
		expect(message).toContain(path);
	});

	test("a properly encoded password passes straight through", () => {
		const dir = tempDir();
		const path = join(dir, "pg_url");
		const url = `postgres://ob:${encodeURIComponent(SECRET)}@host:5432/omnislash`;
		writeFileSync(path, `${url}\n`);
		chmodSync(path, 0o600);
		process.env[PG_URL_FILE_ENV] = path;
		expect(resolvePgUrl()).toBe(url);
	});

	test("the environment variable wins over the file, for a one-off elsewhere", () => {
		const dir = tempDir();
		const path = join(dir, "pg_url");
		writeFileSync(path, "postgres://ob:filepw@filehost:5432/omnislash\n");
		process.env[PG_URL_FILE_ENV] = path;
		process.env[PG_URL_ENV] = "postgres://ob:envpw@envhost:5432/omnislash";
		expect(resolvePgUrl()).toBe("postgres://ob:envpw@envhost:5432/omnislash");
	});

	test("a wrong SCHEME is refused by name rather than handed to the driver", () => {
		let message = "";
		try {
			checkPgUrl("mysql://ob:pw@host:3306/omnislash", PG_URL_ENV);
		} catch (err) {
			message = (err as AppError).message;
		}
		expect(message).toContain("mysql");
		expect(message).toContain("not postgres");
	});
});
