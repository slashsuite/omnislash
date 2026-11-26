import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { fetchWhatsappMedia, isAudioMedia, mediaRow, type FetchMediaOpts } from "./media.ts";

// ── WhatsApp voice-note transcription (158) ───────────────────────────────────────────────────────
// Voice notes are ogg/opus audio. Transcription is ON-DEMAND (a dashboard button), local-first, and
// degrades GRACEFULLY: if no local whisper (or ffmpeg, which whisper needs to decode ogg/opus) is on
// this machine, we return a clear "unavailable" result WITHOUT throwing — the feed keeps working and the
// row shows a "transcription unavailable (install whisper/ffmpeg)" hint instead of failing. The STT
// engine is a seam (SttEngine) so tests never shell out; the default engine shells to whisper. Two whisper
// flavours are supported behind that seam (201) — whisper.cpp (`whisper-cli`, model = a ggml-*.bin PATH,
// ffmpeg pre-decodes ogg→wav) and openai-whisper (`whisper`, model = a NAME) — selected by config
// `whisper_engine` or auto-detected from the whisper binary's basename (default: whisper.cpp).

/** The outcome of a transcription attempt. `ok:false` is the graceful-degrade path — never a throw. */
export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

/** An STT engine seam. `available()` is a cheap pre-flight (binaries present?); `transcribe()` runs it. */
export interface SttEngine {
  available(): { ok: true } | { ok: false; reason: string };
  transcribe(audioPath: string): Promise<TranscribeResult>;
}

/** Resolve a binary on PATH (or an absolute path). Returns the resolved path, or null when absent.
 *  Shared with the describe.ts vision engines (378) — same "bin on PATH" pre-flight. */
export function resolveBin(bin: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  return Bun.which(bin);
}

/**
 * Which local whisper flavour to shell to. Two CLIs exist and take DIFFERENT flags:
 *  - `whisper.cpp` — the `whisper-cli` (older `main`) binary. Light, no Python/torch. Model is a FILE
 *    PATH to a `ggml-*.bin`, and it CANNOT read ogg/opus, so we ffmpeg-decode to 16kHz-mono WAV first.
 *  - `openai-whisper` — the Python `whisper` binary. Model is a NAME (e.g. "base") and it decodes ogg
 *    itself (via ffmpeg on PATH).
 * The selection is decision-driven: explicit `whisper_engine` config wins; else auto-detect from the
 * whisper binary's basename (`whisper-cli`/`main` → whisper.cpp; `whisper` → openai-whisper); else
 * default to whisper.cpp (the flavour installed on this machine).
 */
export type WhisperEngineKind = "whisper.cpp" | "openai-whisper";

/** Resolve the engine flavour from config + the whisper binary basename. Never throws. */
export async function resolveWhisperEngineKind(store: Store): Promise<WhisperEngineKind> {
  const explicit = (await settingFor(store, "whisper_engine")).trim().toLowerCase();
  if (explicit === "whisper.cpp" || explicit === "whisper-cpp" || explicit === "whispercpp") return "whisper.cpp";
  if (explicit === "openai-whisper" || explicit === "openai" || explicit === "whisper") return "openai-whisper";
  const bin = (await settingFor(store, "whisper_bin_path")) || "whisper-cli";
  const base = basename(bin).toLowerCase();
  if (base === "whisper-cli" || base === "main") return "whisper.cpp";
  if (base === "whisper") return "openai-whisper";
  return "whisper.cpp"; // unset/ambiguous → the installed flavour
}

/**
 * The whisper.cpp engine: `whisper-cli` (or `main`) + ffmpeg. whisper.cpp CANNOT read ogg/opus, so we
 * ffmpeg-decode the voice note to 16kHz-mono WAV first, then run whisper-cli against the WAV. `whisper_model`
 * here is a FILE PATH to a `ggml-*.bin` model (NOT a name). available() checks both binaries AND the model
 * file resolve; transcribe() short-circuits to available()'s reason. NEVER throws.
 */
async function whisperCppEngine(store: Store): Promise<SttEngine> {
  const whisperBin = (await settingFor(store, "whisper_bin_path")) || "whisper-cli";
  const ffmpegBin = (await settingFor(store, "ffmpeg_bin_path")) || "ffmpeg";
  // whisper.cpp: whisper_model is a PATH to a ggml-*.bin file (not a name). Default to the OmniSlash
  // model dir so an unconfigured-but-installed machine still finds the base model.
  const model =
    (await settingFor(store, "whisper_model")) ||
    `${homedir()}/.local/share/omnislash/whisper-models/ggml-base.bin`;

  const available = (): { ok: true } | { ok: false; reason: string } => {
    if (!resolveBin(whisperBin)) {
      return { ok: false, reason: `transcription unavailable — whisper not found (install whisper.cpp, or set config whisper_bin_path)` };
    }
    if (!resolveBin(ffmpegBin)) {
      return { ok: false, reason: `transcription unavailable — ffmpeg not found (whisper.cpp needs it to decode voice notes; install ffmpeg, or set config ffmpeg_bin_path)` };
    }
    if (!existsSync(model)) {
      return { ok: false, reason: `transcription unavailable — whisper.cpp model not found at ${model} (set config whisper_model to a ggml-*.bin path)` };
    }
    return { ok: true };
  };

  return {
    available,
    async transcribe(audioPath: string): Promise<TranscribeResult> {
      const pre = available();
      if (!pre.ok) return pre;
      let tmp: string | null = null;
      try {
        tmp = mkdtempSync(join(tmpdir(), "ob-whisper-cpp-"));
        const wavPath = join(tmp, "audio.wav");
        // 1) ffmpeg-decode ogg/opus → 16kHz mono WAV (whisper.cpp only reads WAV).
        const ff = Bun.spawn([ffmpegBin, "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const ffCode = await ff.exited;
        if (ffCode !== 0) {
          const err = (await new Response(ff.stderr).text()).trim();
          return { ok: false, reason: `transcription failed (ffmpeg exited ${ffCode})${err ? `: ${err.slice(0, 200)}` : ""}` };
        }
        // 2) whisper-cli -m <model.bin> -f <wav> -otxt -np -of <stem> → writes "<stem>.txt".
        const stem = join(tmp, "audio");
        const proc = Bun.spawn([whisperBin, "-m", model, "-f", wavPath, "-otxt", "-np", "-of", stem], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = (await new Response(proc.stderr).text()).trim();
          return { ok: false, reason: `transcription failed (whisper exited ${code})${err ? `: ${err.slice(0, 200)}` : ""}` };
        }
        const txtPath = `${stem}.txt`;
        if (!existsSync(txtPath)) return { ok: false, reason: "transcription produced no output" };
        const text = readFileSync(txtPath, "utf8").trim();
        if (!text) return { ok: false, reason: "transcription produced an empty transcript" };
        return { ok: true, text };
      } catch (e) {
        return { ok: false, reason: `transcription unavailable — ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The openai-whisper engine: the Python `whisper` CLI (`whisper <audio> --model <name> --output_format txt`),
 * which itself needs ffmpeg to decode the ogg/opus voice note. `whisper_model` here is a NAME (e.g. "base").
 * Both binaries are configurable (whisper_bin_path / ffmpeg_bin_path). If either is missing, available()
 * reports a clear reason and transcribe() short-circuits to it — it NEVER throws.
 */
async function openaiWhisperEngine(store: Store): Promise<SttEngine> {
  const whisperBin = (await settingFor(store, "whisper_bin_path")) || "whisper";
  const ffmpegBin = (await settingFor(store, "ffmpeg_bin_path")) || "ffmpeg";
  const model = (await settingFor(store, "whisper_model")) || "base";

  const available = (): { ok: true } | { ok: false; reason: string } => {
    if (!resolveBin(whisperBin)) {
      return { ok: false, reason: `transcription unavailable — whisper not found (install whisper, or set config whisper_bin_path)` };
    }
    if (!resolveBin(ffmpegBin)) {
      return { ok: false, reason: `transcription unavailable — ffmpeg not found (whisper needs it to decode voice notes; install ffmpeg, or set config ffmpeg_bin_path)` };
    }
    return { ok: true };
  };

  return {
    available,
    async transcribe(audioPath: string): Promise<TranscribeResult> {
      const pre = available();
      if (!pre.ok) return pre;
      try {
        const outDir = mkdtempSync(join(tmpdir(), "ob-whisper-"));
        const proc = Bun.spawn(
          [whisperBin, audioPath, "--model", model, "--output_format", "txt", "--output_dir", outDir],
          { stdout: "pipe", stderr: "pipe" },
        );
        const code = await proc.exited;
        if (code !== 0) {
          const err = (await new Response(proc.stderr).text()).trim();
          return { ok: false, reason: `transcription failed (whisper exited ${code})${err ? `: ${err.slice(0, 200)}` : ""}` };
        }
        // whisper writes "<basename-without-ext>.txt" into outDir.
        const stem = basename(audioPath).replace(/\.[^.]+$/, "");
        const txtPath = join(outDir, `${stem}.txt`);
        if (!existsSync(txtPath)) return { ok: false, reason: "transcription produced no output" };
        const text = readFileSync(txtPath, "utf8").trim();
        if (!text) return { ok: false, reason: "transcription produced an empty transcript" };
        return { ok: true, text };
      } catch (e) {
        return { ok: false, reason: `transcription unavailable — ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

/**
 * The default local STT engine. Picks whisper.cpp or openai-whisper via `resolveWhisperEngineKind` (config
 * `whisper_engine`, else auto-detected from the whisper binary basename, else whisper.cpp). Both flavours
 * degrade gracefully — available() reports a clear reason and transcribe() short-circuits to it, never throws.
 */
export async function defaultSttEngine(store: Store): Promise<SttEngine> {
  return (await resolveWhisperEngineKind(store)) === "openai-whisper"
    ? openaiWhisperEngine(store)
    : whisperCppEngine(store);
}

/** Persist a transcript on the message row (writable handle). Idempotent. */
export async function storeTranscript(
  store: Store,
  chatJid: string,
  id: string,
  transcript: string,
): Promise<void> {
  await store.q
    .update(store.t.whatsappMessage)
    .set({ transcript })
    .where(and(eq(store.t.whatsappMessage.chat_jid, chatJid), eq(store.t.whatsappMessage.id, id)));
}

export interface TranscribeMessageOpts extends Omit<FetchMediaOpts, "chatJid" | "id"> {
  chatJid: string;
  id: string;
  /** STT engine seam — tests inject a mock so nothing shells out. Defaults to defaultSttEngine(db). */
  engine?: SttEngine;
}

/**
 * Transcribe one WhatsApp voice note on demand: verify it's an audio message, reuse a cached transcript
 * if present, download the audio through the media proxy (token stays server-side), run the STT engine,
 * and store the result. Returns the transcript (ok) or a clear reason (ok:false) — the caller renders the
 * reason inline. Only a real message that isn't audio (or is unknown) throws; a missing STT engine is a
 * graceful ok:false, never a throw, so the feed never breaks.
 */
export async function transcribeWhatsappMessage(
  store: Store,
  opts: TranscribeMessageOpts,
): Promise<TranscribeResult> {
  const { chatJid, id, engine, ...mediaOpts } = opts;
  const row = await mediaRow(store, chatJid, id);
  if (!row) throw new AppError(`no WhatsApp message ${id} in chat ${chatJid}`);
  if (!isAudioMedia(row.media_type)) throw new AppError(`WhatsApp message ${id} is not a voice note`);

  // Already transcribed → return it (no bridge call, no STT).
  const existingRows = (await store.q
    .select({ transcript: store.t.whatsappMessage.transcript })
    .from(store.t.whatsappMessage)
    .where(and(eq(store.t.whatsappMessage.chat_jid, chatJid), eq(store.t.whatsappMessage.id, id)))
    .limit(1)) as Array<{ transcript: string | null }>;
  if (existingRows[0]?.transcript) return { ok: true, text: existingRows[0].transcript };

  const stt = engine ?? (await defaultSttEngine(store));
  const pre = stt.available();
  if (!pre.ok) return pre; // graceful: engine/ffmpeg absent — don't download, don't store, don't throw

  const media = await fetchWhatsappMedia(store, { chatJid, id, ...mediaOpts });
  const result = await stt.transcribe(media.path);
  if (result.ok) await storeTranscript(store, chatJid, id, result.text);
  return result;
}
