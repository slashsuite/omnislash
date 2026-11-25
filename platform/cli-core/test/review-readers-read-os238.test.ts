import { describe, expect, test } from "bun:test";
import { loadReaderSetting, ReaderSettingError } from "../../../skills/ob-skeptical-review/review-leg.ts";

const env = { OB_REVIEW_READERS_SKIP: "" };

describe("OS-238: the leg reads the configured readers or fails", () => {
  test("a failed ob read throws, never falls back to built-in models", () => {
    expect(() => loadReaderSetting(env, () => ({ code: 1, out: "", err: "ob: core from x\nno Postgres connection url" }))).toThrow(
      new ReaderSettingError("ob review readers exited 1: no Postgres connection url"),
    );
  });
  test("unreadable JSON throws", () => {
    expect(() => loadReaderSetting(env, () => ({ code: 0, out: "nope" }))).toThrow(ReaderSettingError);
  });
  test("nothing stored returns null", () => {
    expect(loadReaderSetting(env, () => ({ code: 0, out: '{"stored":false}' }))).toBeNull();
  });
});
