import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OB-1982: runHeadless passed the prompt to `opencode run` as one argv string, and Linux caps one
// argv string at 128 KiB (MAX_ARG_STRLEN), so a long WhatsApp day summary failed to spawn with
// E2BIG before opencode started. The prompt now goes on stdin, as OB-1981 did for the review legs.
//
// Bun resolves a spawned command against the PATH the process STARTED with, so mutating
// process.env.PATH inside the test does not move `opencode`. The test therefore runs a tiny driver
// under a PATH that starts with the fake, and the driver is what calls runHeadless.

const HEADLESS_RUN = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "cli",
  "src",
  "headless-run.ts",
);

// ~224 KB, the same order as the 215 KB brief that broke OB-1981.
const BIG_PROMPT = `Summarise this day:\n${"message line 0123456789abcdef\n".repeat(8000)}`;

// OS-254: each test makes its own scratch dir, so no other test's cleanup can remove the fake bin
// between module load and the run, and each test removes only its own dir.
let scratch: string;
let bin: string;
let report: string;
let driver: string;
let received: string;

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-1982-"));
  bin = join(scratch, "bin");
  report = join(scratch, "report.json");
  driver = join(scratch, "driver.ts");
  received = join(scratch, "stdin.txt");

  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "opencode"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (process.env.OB_1982_EXIT) {
  console.error("fake opencode refused");
  process.exit(Number(process.env.OB_1982_EXIT));
}
const stdin = await Bun.stdin.text();
writeFileSync(process.env.OB_1982_REPORT, JSON.stringify({
  argvMax: Math.max(...argv.map((a) => a.length)),
  argv,
}));
writeFileSync(process.env.OB_1982_STDIN, stdin);
console.log("fake opencode ok");
`,
  );
  chmodSync(join(bin, "opencode"), 0o755);

  writeFileSync(
    driver,
    `import { runHeadless } from ${JSON.stringify(HEADLESS_RUN)};
const prompt = await Bun.stdin.text();
try {
  const out = await runHeadless({ prompt });
  console.log(JSON.stringify({ ok: true, out }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, message: (e as Error).message }));
}
`,
  );
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function drive(prompt: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", driver], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OB_1982_REPORT: report,
      OB_1982_STDIN: received,
      ...extraEnv,
    },
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { result: JSON.parse(out.trim() || "{}"), err, code };
}

describe("runHeadless sends the prompt on stdin (OB-1982)", () => {
  test("a 224 KB prompt resolves with the fake's stdout and arrives whole on stdin", async () => {
    // Over the 128 KiB MAX_ARG_STRLEN cap, which is the size that used to fail with E2BIG.
    expect(Buffer.byteLength(BIG_PROMPT)).toBeGreaterThan(128 * 1024);

    const { result, err, code } = await drive(BIG_PROMPT);
    expect({ result, err, code }).toEqual({
      result: { ok: true, out: "fake opencode ok" },
      err: "",
      code: 0,
    });

    expect(readFileSync(received, "utf8")).toBe(BIG_PROMPT);
    const got = JSON.parse(readFileSync(report, "utf8"));
    expect(got.argvMax).toBeLessThan(1024);
  });

  test("a non-zero exit still throws headless run exited <code> with the stderr text", async () => {
    // The fake exits without reading stdin, so a 224 KB write to a closed pipe is covered too.
    const { result } = await drive(BIG_PROMPT, { OB_1982_EXIT: "3" });
    expect(result).toEqual({ ok: false, message: "headless run exited 3: fake opencode refused" });
  });
});
