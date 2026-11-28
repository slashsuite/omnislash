import { describe, expect, test } from "bun:test";
import { loadReaderSetting, ReaderSettingError } from "../../../skills/ob-skeptical-review/review-leg.ts";

const env = { OB_REVIEW_READERS_SKIP: "" };

describe("OS-238: the leg reads the configured readers or fails", () => {
  test("a failed ob read throws, never falls back to built-in models", () => {
    expect(() => loadReaderSetting(env, () => ({ code: 1, out: "", err: "ob: core from x\nno Postgres connection url" }))).toThrow(
      new ReaderSettingError("ob review readers exited 1: no Postgres connection url"),
    );
  });
  test("OS-304: a dropped-reader warning ahead of the error does not hide it", () => {
    const err = [
      "ob: core from x",
      "/home/u/.config/ob/models.json: review.neon is ignored: profile 'default' has no 'neon' reader (its readers: opus); add it with 'ob review readers set neon --model <id>'",
      "error: no Postgres connection url",
    ].join("\n");
    expect(() => loadReaderSetting(env, () => ({ code: 1, out: "", err }))).toThrow(
      new ReaderSettingError("ob review readers exited 1: error: no Postgres connection url"),
    );
  });
  test("OS-304: with no error: line, the last line is the reason, not the warning before it", () => {
    const err = "ob: warning: models.json: dropped review reader 'luna'\nno Postgres connection url\n";
    expect(() => loadReaderSetting(env, () => ({ code: 1, out: "", err }))).toThrow(
      new ReaderSettingError("ob review readers exited 1: no Postgres connection url"),
    );
  });
  test("unreadable JSON throws", () => {
    expect(() => loadReaderSetting(env, () => ({ code: 0, out: "nope" }))).toThrow(ReaderSettingError);
  });
  test("an answer naming no readers returns null", () => {
    expect(loadReaderSetting(env, () => ({ code: 0, out: '{"stored":false}' }))).toBeNull();
  });
  test("OS-295: ob's own defaults (nothing stored) are what runs, not a table in the leg", () => {
    const out = JSON.stringify({ stored: false, readers: { opus: { model: "claude-opus-5-5" } }, tiers: [{ from: 1, to: 10, legs: ["opus"] }] });
    expect(loadReaderSetting(env, () => ({ code: 0, out }))?.readers.opus).toEqual({ model: "claude-opus-5-5" });
  });
});
