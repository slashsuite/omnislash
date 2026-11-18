import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import {
  defaultVisionEngine,
  DESCRIBE_PROMPT,
  resolveVisionEngineKind,
  stripGenerateBanner,
  VISION_MAX_TOKENS,
  VISION_MODEL_DEFAULT,
  VISION_TIMEOUT_DEFAULT_MS,
  type ProcLike,
  type SpawnProc,
} from "../src/whatsapp/describe.ts";
import { suggestWhatsappReply, type ClaudeRunner } from "../src/whatsapp/suggest.ts";

// Ticket 378 — mlx-vlm becomes the DEFAULT WhatsApp image describer. NO real mlx_vlm.generate, no
// model download, no network: every engine is exercised through the injectable spawn seam (a fake proc
// returning canned stdout/stderr/exit), and the settings are real config rows on a fresh store. Covers
// engine selection, argv construction, banner-stripping, empty output, non-zero exit, timeout kill,
// missing binary, the model-missing error path, the claude opt-in, and the suggest path with the new
// default engine.

const PG_BUDGET = spawnBudget(2);

/** A fake spawn: records the argv/opts and returns the given canned procs. Never starts a process. */
function recordSpawn(...procs: ProcLike[]): { spawn: SpawnProc; calls: Array<{ cmd: string[]; opts?: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string[]; opts?: Record<string, unknown> }> = [];
  const spawn: SpawnProc = (cmd, opts) => {
    calls.push({ cmd, opts });
    return procs[Math.min(calls.length, procs.length) - 1] ?? exitProc(0, "");
  };
  return { spawn, calls };
}

const enc = new TextEncoder();

/** A fake subprocess whose stdout/stderr are real web streams with the given canned text. */
function fakeProc(
  stdoutText: string,
  stderrText = "",
  exitCode: number | null = 0,
  signalCode: string | null = null,
): ProcLike {
  const stream = (text: string): ReadableStream<Uint8Array> | null =>
    text === null
      ? null
      : new ReadableStream<Uint8Array>({
          start(c) {
            if (text) c.enqueue(enc.encode(text));
            c.close();
          },
        });
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode,
    stdin: { write: () => {}, end: () => {} }, // no-op by default; claude tests override to capture
  };
}

function exitProc(code: number, stderr = ""): ProcLike {
  return fakeProc("", stderr, code);
}

/** A realistic mlx_vlm.generate stdout on a machine where verbose/banner printing is on (older CLIs). */
function bannerStdout(gen = "A photo of a leaking sink, with water pooling on the floor."): string {
  return (
    `==========\nPrompt: ${DESCRIBE_PROMPT}\n==========\n${gen}\n` +
    "Prompt: 512 tokens, 34.5 tokens-per-sec\nGeneration: 21 tokens, 12.3 tokens-per-sec\nPeak memory: 6.2 GB"
  );
}

async function setup(): Promise<{ lease: PgStoreLease; db: Store }> {
  const lease = await freshPgStore();
  return { lease, db: lease.store };
}

const IMG = join(tmpdir(), "ob-vision-test.jpg");

/**
 * Point vision_bin_path at a REAL existing absolute executable (Bun's own binary) so the mlx engine's
 * cheap pre-flight passes and it reaches the injected fake spawn. Deterministic on every machine: the
 * binary exists, the process is never actually started (the spawn seam is faked).
 */
function withExistingBin(db: Store): Promise<void> {
  return setConfig(db, "vision_bin_path", process.execPath);
}

describe("vision engine selection (378)", () => {
  test("unset vision_engine → mlx-vlm (the default)", async () => {
    const { lease, db } = await setup();
    expect(await resolveVisionEngineKind(db)).toBe("mlx-vlm");
    await lease.release();
  }, PG_BUDGET);

  test("explicit vision_engine=claude is the only way to opt back in", async () => {
    const { lease, db } = await setup();
    await setConfig(db, "vision_engine", "claude");
    expect(await resolveVisionEngineKind(db)).toBe("claude");
    await lease.release();
  }, PG_BUDGET);

  test("mlx-vlm / auto / unknown values all resolve to mlx-vlm", async () => {
    const { lease, db } = await setup();
    for (const v of ["mlx-vlm", "auto", "SomeOtherEngine"]) {
      await setConfig(db, "vision_engine", v);
      expect(await resolveVisionEngineKind(db)).toBe("mlx-vlm");
    }
    await lease.release();
  }, PG_BUDGET);
});

describe("default mlx-vlm engine (378)", () => {
  test("default engine is mlx-vlm and builds the verified argv", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn, calls } = recordSpawn(
      fakeProc("A photo of a leaking sink, water pooling on the floor."),
    );
    const engine = await defaultVisionEngine(db, spawn);
    expect(engine.available()).toEqual({ ok: true });
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res).toEqual({ ok: true, text: "A photo of a leaking sink, water pooling on the floor." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual([
      process.execPath, // vision_bin_path row (the withExistingBin stand-in for the default bin)
      "--model",
      VISION_MODEL_DEFAULT,
      "--prompt",
      DESCRIBE_PROMPT,
      "--image",
      IMG,
      "--max-tokens",
      String(VISION_MAX_TOKENS),
    ]);
    expect(calls[0]!.opts!.timeout).toBe(VISION_TIMEOUT_DEFAULT_MS);
    await lease.release();
  }, PG_BUDGET);

  test("vision_model / vision_bin_path / vision_timeout settings override the argv", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    await setConfig(db, "vision_model", "mlx-community/moondream2");
    await setConfig(db, "vision_timeout", "5000");
    const { spawn, calls } = recordSpawn(fakeProc("A cat on a couch."));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res.ok).toBe(true);
    expect(calls[0]!.cmd[0]).toBe(process.execPath); // vision_bin_path row, not the default bin
    expect(calls[0]!.cmd[2]).toBe("mlx-community/moondream2");
    expect(calls[0]!.opts!.timeout).toBe(5000);
    await lease.release();
  }, PG_BUDGET);

  test("banner chrome (verbose/older stdout) is stripped; generation survives", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn } = recordSpawn(fakeProc(bannerStdout("Two people at a restaurant table with plates of food.")));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res).toEqual({ ok: true, text: "Two people at a restaurant table with plates of food." });
    await lease.release();
  }, PG_BUDGET);

  test("stdout of ONLY banner chrome → no usable output", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn } = recordSpawn(fakeProc("==========\nPrompt: x\n==========\n"));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res).toEqual({ ok: false, reason: "image description produced no usable output" });
    await lease.release();
  }, PG_BUDGET);

  test("empty stdout on exit 0 → no usable output", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn } = recordSpawn(fakeProc(""));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res).toEqual({ ok: false, reason: "image description produced no usable output" });
    await lease.release();
  }, PG_BUDGET);

  test("non-zero exit names the binary + model and carries the download-remedy", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn } = recordSpawn(
      exitProc(1, "Cannot find model mlx-community/Qwen2.5-VL-7B-Instruct-4bit\nSome details..."),
    );
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/exited 1/);
      expect(res.reason).toContain(VISION_MODEL_DEFAULT);
      expect(res.reason).toContain(`--prompt test --image <any-image>`);
    }
    await lease.release();
  }, PG_BUDGET);

  test("exitCode null (SIGKILL — the Bun.spawn timeout path) names model + vision_timeout remedy", async () => {
    const { lease, db } = await setup();
    await withExistingBin(db);
    const { spawn } = recordSpawn(fakeProc("", "", null, "SIGKILL"));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/killed by SIGKILL after 300000ms/);
      expect(res.reason).toContain(VISION_MODEL_DEFAULT);
      expect(res.reason).toContain("bigger config vision_timeout");
    }
    await lease.release();
  }, PG_BUDGET);

  test("missing binary: available() says so calmly and describe() short-circuits without spawning", async () => {
    const { lease, db } = await setup();
    await setConfig(db, "vision_bin_path", "/definitely/not/installed/mlx_vlm.generate");
    const { spawn, calls } = recordSpawn(fakeProc("ignored"));
    const engine = await defaultVisionEngine(db, spawn);
    const avail = engine.available();
    expect(avail.ok).toBe(false);
    if (!avail.ok) expect(avail.reason).toMatch(/mlx-vlm not found/);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
    await lease.release();
  }, PG_BUDGET);
});

describe("claude opt-in engine (378 — explicit vision_engine=claude only; 536 opencode spawn)", () => {
  test("uses opencode run with the vision-exp model and --file", async () => {
    const { lease, db } = await setup();
    await setConfig(db, "vision_engine", "claude");
    if (!Bun.which("opencode")) {
      const engine = await defaultVisionEngine(db, () => fakeProc(""));
      expect((await engine.describe(IMG, "image/jpeg")).ok).toBe(false);
      expect(engine.available().ok).toBe(false);
      await lease.release();
      return;
    }
    const { spawn, calls } = recordSpawn(fakeProc("A birthday cake with lit candles."));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res).toEqual({ ok: true, text: "A birthday cake with lit candles." });
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.cmd;
    expect(cmd[0]).toBe("opencode");
    expect(cmd).toContain("run");
    expect(cmd[cmd.indexOf("-m") + 1]).toBe("opencode-go/deepseek-v4-flash-vision-exp");
    expect(cmd[cmd.indexOf("--file") + 1]).toBe(IMG);
    expect(cmd).toContain(DESCRIBE_PROMPT);
    await lease.release();
  }, PG_BUDGET);

  test("a non-zero opencode exit still returns a graceful ok:false", async () => {
    const { lease, db } = await setup();
    await setConfig(db, "vision_engine", "claude");
    if (!Bun.which("opencode")) {
      await lease.release();
      return;
    }
    const { spawn } = recordSpawn(exitProc(2, "auth expired"));
    const engine = await defaultVisionEngine(db, spawn);
    const res = await engine.describe(IMG, "image/jpeg");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/headless run exited 2/);
    await lease.release();
  }, PG_BUDGET);
});

describe("stripGenerateBanner (378) — pure unit", () => {
  test("drops the classic banner shape, keeps the generation", () => {
    expect(
      stripGenerateBanner("==========\nPrompt: something\n==========\nThe image shows a red car.\n=========="),
    ).toBe("The image shows a red car.");
  });
  test("drops verbose tail stats", () => {
    expect(
      stripGenerateBanner(
        "The image shows a red car.\nPrompt: 512 tokens, 34.3 tokens-per-sec\nGeneration: 12 tokens, 9.1 tokens-per-sec\nPeak memory: 5.1 GB",
      ),
    ).toBe("The image shows a red car.");
  });
  test("drops [WARNING] wired-limit lines and blank separator lines", () => {
    expect(
      stripGenerateBanner(
        "[WARNING] Generating with a model that requires 6144 MB which is close to the maximum recommended size of 6144 MB. This can be slow. See the documentation for possible work-arounds: https://github.com/ml-explore/mlx-lm/tree/main#large-models\n\nThe image shows a red car.",
      ),
    ).toBe("The image shows a red car.");
  });
  test("whitespace-only input strips to empty", () => {
    expect(stripGenerateBanner("   \n\n  ")).toBe("");
  });
  test("plain generation is untouched", () => {
    expect(stripGenerateBanner("The image shows a red car.")).toBe("The image shows a red car.");
  });
});

describe("suggest path with the new DEFAULT engine (378)", () => {
  test("unset config → default mlx-vlm engine; a missing binary degrades to [image], never spawns or crashes", async () => {
    const { lease, db } = await setup();
    const chat = "27000000003@s.whatsapp.net";
    await setConfig(db, "vision_bin_path", "/definitely/not/installed/mlx_vlm.generate");
    await db.q.insert(db.t.whatsappMessage).values({
      id: "pic1",
      chat_jid: chat,
      content: null,
      ts: "2026-07-18T00:00:00.000Z",
      media_type: "image",
      created_at: "2026-07-18T00:00:00.000Z",
    });
    let runs = 0;
    const run: ClaudeRunner = async () => {
      runs++;
      return "Thanks for the photo!"; // canned draft — suggest never shells out to claude here
    };
    const draft = await suggestWhatsappReply(db, { chatJid: chat, run });
    // The vision pre-flight failed gracefully: the draft still landed, the image is a placeholder,
    // and the suggest itself produced exactly one canned output (no real process was ever started).
    expect(draft).toBe("Thanks for the photo!");
    expect(runs).toBe(1);
    const stored = (
      (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='pic1'")) as {
        media_desc: string | null;
      }[]
    )[0]!;
    expect(stored.media_desc).toBeNull();
    await lease.release();
  }, PG_BUDGET);
});