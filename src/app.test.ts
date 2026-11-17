import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleRequest } from "./app.ts";

const call = (method: string, url: string) => {
  const result = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const response = {
    writeHead: (status: number, headers: Record<string, unknown>) => {
      result.status = status;
      result.headers = headers;
    },
    end: (body: string) => {
      result.body = body;
    }
  } as unknown as ServerResponse;
  handleRequest({ method, url } as IncomingMessage, response);
  return result;
};

describe("handleRequest", () => {
  it.each(["/health", "/health/liveness"])("reports %s as UP", (path) => {
    const result = call("GET", path);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: "UP" });
  });

  it.each(["/rs/status", "/api/status"])("reports %s as ready", (path) => {
    const result = call("GET", path);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(result.body)).toMatchObject({ ready: true });
  });

  it.each(["/rs/ping", "/api/ping"])("answers %s with 200", (path) => {
    expect(call("GET", path).status).toBe(200);
  });

  it("ignores the query string", () => {
    expect(call("GET", "/health?x=1").status).toBe(200);
  });

  it("returns 404 for an unknown path", () => {
    const result = call("GET", "/nope");
    expect(result.status).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: "Not found" });
  });

  it("returns 404 for a non-GET request to a known path", () => {
    expect(call("POST", "/health").status).toBe(404);
  });

  it("defaults a missing method and url to GET /", () => {
    const result = { status: 0 };
    const response = {
      writeHead: (status: number) => {
        result.status = status;
      },
      end: () => {}
    } as unknown as ServerResponse;
    handleRequest({} as IncomingMessage, response);
    expect(result.status).toBe(404);
  });
});
