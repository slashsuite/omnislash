// Component test (happy-dom). Named *.vitest.tsx so `bun test` never matches it.
// @vitest-environment happy-dom
// OB-2205: the update notice names the app it is in, so the OB Home Screen app does not say "OmniSlash was updated".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Report an update as soon as the component registers, so the notice shows.
vi.mock("../src/lib/registerSw.ts", () => ({ registerServiceWorker: (onUpdate: () => void) => onUpdate() }));

import { PwaRegister } from "../src/components/PwaRegister.tsx";

afterEach(cleanup);

describe("PwaRegister's update notice (OB-2205)", () => {
  it("names OmniSlash by default, as the personal dashboard renders it", async () => {
    render(<PwaRegister />);
    expect(await screen.findByText("OmniSlash was updated. Reload to use the new version.")).toBeTruthy();
  });

  it("names the app it is given", async () => {
    render(<PwaRegister appName="OB" />);
    expect(await screen.findByText("OB was updated. Reload to use the new version.")).toBeTruthy();
    expect(screen.queryByText(/OmniSlash/)).toBeNull();
  });
});
