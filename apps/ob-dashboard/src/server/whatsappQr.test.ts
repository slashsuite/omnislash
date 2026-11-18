import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWhatsappQr } from "../../../../platform/cli-whatsapp/src/whatsapp/qr.ts";
import { renderWhatsappQr } from "./whatsappQr.ts";

// 274. This is the boundary test: the file on disk holds a pairing secret, the browser gets a picture.
// The assertions are made on the SERIALIZED payload, because a type with no `code` field is only as safe
// as the object actually sent — that is the same line ob 219 drew for the tokens page and the reason it
// held: a `{...view}` spread that forgot to destructure would type-check perfectly.
//
// Reads a real temp file rather than a stubbed reader, so the whole path (file → state → image) is proven
// end to end. No bridge, no network, no live DB: the temp file IS the fixture.

const PAYLOAD = "2@aBcDeF0123456789/qRsTuVwXyZ+abcdef==,ghIJklMNopQRstUV/wxyz0123456789==,AbCdEf01==,1";

function qrFile(fields: Record<string, unknown>, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-qr-"));
  const path = join(dir, "qr.json");
  writeFileSync(path, JSON.stringify(fields), "utf8");
  chmodSync(path, mode);
  return path;
}

describe("rendering the pairing QR for the browser (274)", () => {
  it("turns a live code into a PNG data URL", async () => {
    const path = qrFile({ event: "code", code: PAYLOAD, emitted_at: new Date().toISOString() });
    const view = await renderWhatsappQr(readWhatsappQr(path));
    expect(view.state).toBe("live");
    expect(view.image).toStartWith("data:image/png;base64,");
    // Big enough to be a real QR rather than an empty placeholder.
    expect(view.image!.length).toBeGreaterThan(500);
  });

  it("NEVER puts the payload in the payload", async () => {
    const path = qrFile({ event: "code", code: PAYLOAD, emitted_at: new Date().toISOString() });
    const view = await renderWhatsappQr(readWhatsappQr(path));
    const wire = JSON.stringify(view);
    expect(wire).not.toContain(PAYLOAD);
    // Not even a fragment of it, and not under a differently-named field.
    expect(wire).not.toContain(PAYLOAD.slice(0, 24));
    expect(Object.keys(view)).not.toContain("code");
  });

  it("carries the age and the sentence through, so the page can say how fresh it is", async () => {
    const emitted = new Date(Date.now() - 7_000).toISOString();
    const view = await renderWhatsappQr(readWhatsappQr(qrFile({ event: "code", code: PAYLOAD, emitted_at: emitted })));
    expect(view.emitted_at).toBe(emitted);
    expect(view.age_s).toBeGreaterThanOrEqual(6);
    expect(view.detail).toContain("scan it");
  });

  it("renders an expired code too, still labelled expired", async () => {
    const old = new Date(Date.now() - 300_000).toISOString();
    const view = await renderWhatsappQr(readWhatsappQr(qrFile({ event: "code", code: PAYLOAD, emitted_at: old })));
    expect(view.state).toBe("expired");
    expect(view.image).toStartWith("data:image/png;base64,");
    expect(JSON.stringify(view)).not.toContain(PAYLOAD);
  });

  it("has no image for a state with nothing to scan", async () => {
    for (const event of ["success", "timeout"]) {
      const view = await renderWhatsappQr(readWhatsappQr(qrFile({ event, emitted_at: new Date().toISOString() })));
      expect(view.image).toBeNull();
    }
  });

  it("reports an absent file as unset rather than as a broken read", async () => {
    const view = await renderWhatsappQr(readWhatsappQr("/definitely/not/here/qr.json"));
    expect(view.state).toBe("unset");
    expect(view.image).toBeNull();
  });

  it("flags a world-readable QR file: it holds a pairing secret", async () => {
    const path = qrFile({ event: "code", code: PAYLOAD, emitted_at: new Date().toISOString() }, 0o644);
    const view = await renderWhatsappQr(readWhatsappQr(path));
    expect(view.insecure_mode).toBe(true);
    expect(view.path).toBe(path);
  });
});
