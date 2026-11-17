import { describe, expect, it } from "vitest";

const baseUrl = (process.env.TEST_URL ?? "http://localhost:8080").replace(/\/$/, "");

describe("functional", () => {
  it("reports ready on the Docmosis status endpoint", async () => {
    const response = await fetch(`${baseUrl}/rs/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
  });
});
