import { describe, expect, it } from "vitest";

const baseUrl = (process.env.TEST_URL ?? "http://localhost:8080").replace(/\/$/, "");

describe("smoke", () => {
  it("reports healthy", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it("reports live and ready", async () => {
    expect((await fetch(`${baseUrl}/health/liveness`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/readiness`)).status).toBe(200);
  });

  it("reports ready on the Docmosis status endpoint", async () => {
    const response = await fetch(`${baseUrl}/rs/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
  });
});
