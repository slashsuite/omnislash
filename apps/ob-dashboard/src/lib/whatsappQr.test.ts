import { describe, expect, it } from "bun:test";
import {
  QR_EXPOSURE_NOTICE,
  QR_POLL_IDLE_MS,
  QR_POLL_LIVE_MS,
  qrPanel,
  type WhatsappQrView,
} from "./whatsappQr.ts";

// 274. The pairing panel is the one place on the tokens page that SHOWS a secret instead of hiding one,
// so what these tests hold is the two rules that make that defensible: it is never on screen when nothing
// is pairing, and it never presents a code as scannable when the phone would refuse it.

function view(over: Partial<WhatsappQrView> = {}): WhatsappQrView {
  return {
    state: "unset",
    image: null,
    emitted_at: null,
    age_s: null,
    detail: "",
    insecure_mode: false,
    path: "/store/qr.json",
    ...over,
  };
}

describe("when the pairing panel is on screen at all (274)", () => {
  it("hides itself when no QR file exists AND the session is linked: nothing to do", () => {
    expect(qrPanel(view({ state: "unset" }), { linked: true }).show).toBe(false);
  });

  // The gap that made the panel unusable: not linked and no QR file is exactly the moment somebody comes
  // to this page to pair, and the panel used to render NOTHING there — no card, no button, no explanation.
  it("shows, with a button, when the session is not linked and there is no QR yet", () => {
    const panel = qrPanel(view({ state: "unset" }), { linked: false });
    expect(panel.show).toBe(true);
    expect(panel.showStart).toBe(true);
    expect(panel.headline).toContain("Not linked");
    // The reader's own sentence hedges ("either the session is linked, or the bridge predates the patch")
    // because a file cannot know. Here the panel DOES know, and a card headed "Not linked" above a
    // sentence guessing it probably is linked is the page contradicting itself in two lines.
    expect(panel.detail).not.toBeNull();
    expect(panel.detail).toContain("no stored WhatsApp pairing");
  });

  it("defers to the file's own sentence everywhere the panel knows no better", () => {
    for (const state of ["live", "expired", "paired", "timeout", "unreadable"] as const) {
      expect(qrPanel(view({ state }), { linked: false }).detail).toBeNull();
    }
  });

  it("hides itself when the read has not happened yet, rather than flashing an empty card", () => {
    expect(qrPanel(null).show).toBe(false);
  });

  it("shows for every state that has something to say", () => {
    for (const state of ["live", "expired", "paired", "timeout", "unreadable"] as const) {
      expect(qrPanel(view({ state })).show).toBe(true);
    }
  });
});

describe("when the Start pairing button is offered (274)", () => {
  it("offers it for the states where only a bridge start can produce a code", () => {
    for (const state of ["unset", "expired", "timeout"] as const) {
      expect(qrPanel(view({ state }), { linked: false }).showStart).toBe(true);
    }
  });

  it("never offers it beside a live code: the thing to do is scan, and a start would discard it", () => {
    expect(qrPanel(view({ state: "live" }), { linked: false }).showStart).toBe(false);
  });

  it("offers it on a paired read the credential row says is not linked (OB-1942)", () => {
    // `paired` is what the bridge last WROTE. It survives a logout, and the bridge never reports one, so a
    // paired file on an unlinked session is exactly the case where Start is the only way forward.
    expect(qrPanel(view({ state: "paired" }), { linked: false }).showStart).toBe(true);
  });

  it("never offers it while the session is linked", () => {
    for (const state of ["paired", "expired", "timeout"] as const) {
      expect(qrPanel(view({ state }), { linked: true }).showStart).toBe(false);
    }
  });

  it("never offers it over an unreadable file: that would stack an unknown on an unread one", () => {
    expect(qrPanel(view({ state: "unreadable" }), { linked: false }).showStart).toBe(false);
  });

  it("assumes linked when nothing says otherwise, so a missing signal cannot conjure a button", () => {
    expect(qrPanel(view({ state: "unset" })).show).toBe(false);
    expect(qrPanel(view({ state: "timeout" })).showStart).toBe(false);
  });
});

describe("what it promises about a code (274)", () => {
  it("a live code is offered, green, with its age in the headline", () => {
    const panel = qrPanel(view({ state: "live", age_s: 4, image: "data:image/png;base64,AAA" }));
    expect(panel.showImage).toBe(true);
    expect(panel.tone).toBe("positive");
    expect(panel.headline).toContain("4s ago");
  });

  it("an expired code is shown but never called scannable", () => {
    const panel = qrPanel(view({ state: "expired", age_s: 90 }));
    expect(panel.tone).toBe("warn");
    expect(panel.headline).toContain("expired");
  });

  it("paired, timeout and unreadable render no image: there is nothing to scan", () => {
    for (const state of ["paired", "timeout", "unreadable"] as const) {
      expect(qrPanel(view({ state })).showImage).toBe(false);
    }
  });

  it("a closed window and an unreadable file are red — both need a human, differently", () => {
    expect(qrPanel(view({ state: "timeout" })).tone).toBe("danger");
    expect(qrPanel(view({ state: "unreadable" })).tone).toBe("danger");
    expect(qrPanel(view({ state: "timeout" })).headline).not.toBe(qrPanel(view({ state: "unreadable" })).headline);
  });
});

describe("the poll cadence (274)", () => {
  it("polls faster than the ~20s rotation while a code is on screen", () => {
    expect(qrPanel(view({ state: "live" })).pollMs).toBe(QR_POLL_LIVE_MS);
    expect(QR_POLL_LIVE_MS).toBeLessThan(20_000);
  });

  it("keeps looking slowly when there is nothing to show, so a restart is noticed without a reload", () => {
    expect(qrPanel(view({ state: "unset" }), { linked: false }).pollMs).toBe(QR_POLL_IDLE_MS);
    expect(qrPanel(view({ state: "paired" })).pollMs).toBe(QR_POLL_IDLE_MS);
    expect(qrPanel(null).pollMs).toBe(QR_POLL_IDLE_MS);
  });

  it("re-reads an expired code at the live cadence: the bridge may be one rotation behind, not stopped", () => {
    expect(qrPanel(view({ state: "expired" })).pollMs).toBe(QR_POLL_LIVE_MS);
  });

  // OB-1942: the panel hid itself for the healthy linked case but kept re-reading a pairing secret off disk
  // every 20 seconds, forever. There is nothing left to look for there.
  it("stops polling once the panel is hidden because the session is linked", () => {
    expect(qrPanel(view({ state: "unset" }), { linked: true }).pollMs).toBeNull();
  });
});

describe("the exposure notice (274)", () => {
  it("says plainly what scanning it does, because that is the whole risk of the panel", () => {
    expect(QR_EXPOSURE_NOTICE).toContain("links their WhatsApp to this account");
  });
});
