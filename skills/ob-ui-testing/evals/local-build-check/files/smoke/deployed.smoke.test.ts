import { expect, test } from "vitest";
const base = process.env.SMOKE_BASE_URL!;
test("the deployed site serves the home page", async () => {
  const res = await fetch(base + "/");
  expect(res.status).toBe(200);
});
