import { describe, expect, it } from "bun:test";
import { assertSameOrigin, isSameOrigin, CrossSiteRequestError } from "../src/server/same-origin.ts";

const URL_ = "https://dash.example.test/_serverFn/send";
const req = (headers: Record<string, string>) => new Request(URL_, { method: "POST", headers });

describe("isSameOrigin", () => {
  it("passes Sec-Fetch-Site: same-origin", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("refuses cross-site", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });
  it("refuses same-site (another subdomain)", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site", origin: "https://other.example.test" }))).toBe(false);
  });
  it("refuses none", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "none" }))).toBe(false);
  });
  it("Sec-Fetch-Site wins over a matching Origin", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site", origin: "https://dash.example.test" }))).toBe(false);
  });
  it("without Sec-Fetch-Site, a matching Origin passes", () => {
    expect(isSameOrigin(req({ origin: "https://dash.example.test" }))).toBe(true);
  });
  it("without Sec-Fetch-Site, a different Origin refuses", () => {
    expect(isSameOrigin(req({ origin: "https://evil.example.test" }))).toBe(false);
  });
  it("without Sec-Fetch-Site, a different port refuses", () => {
    expect(isSameOrigin(req({ origin: "https://dash.example.test:8443" }))).toBe(false);
  });
  it("without Sec-Fetch-Site, an unparsable Origin refuses", () => {
    expect(isSameOrigin(req({ origin: "null" }))).toBe(false);
  });
  it("with neither header, refuses", () => {
    expect(isSameOrigin(req({}))).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("throws the named error on refusal and returns on pass", () => {
    expect(() => assertSameOrigin(req({}))).toThrow(CrossSiteRequestError);
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).not.toThrow();
  });
});
