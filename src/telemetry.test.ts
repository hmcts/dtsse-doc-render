import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./app.ts";
import { ConversionError } from "./convert.ts";
import { LimitError } from "./merge/errors.ts";
import { MergeError } from "./merge/index.ts";
import { noTelemetry, scrubbed, startTelemetry, type Telemetry } from "./telemetry.ts";

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("T")]);
const T = ZIP.toString("base64");

const fake = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const telemetry: Telemetry = {
    request: (...args) => calls.push(["request", ...args]),
    exception: (...args) => calls.push(["exception", ...args]),
    event: (...args) => calls.push(["event", ...args]),
    metric: (...args) => calls.push(["metric", ...args])
  };
  return { calls, telemetry };
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

const start = async (overrides: Parameters<typeof createHandler>[0] extends infer D ? Partial<D> : never = {}) => {
  const { calls, telemetry } = fake();
  const handler = createHandler({
    merge: async () => Buffer.from("docx"),
    convert: async () => Buffer.from("pdf"),
    convertTo: async () => Buffer.from("odt"),
    telemetry,
    ...overrides
  });
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const names = () => calls.map(([kind, name, props]) => [kind, name, props]);
  const requests = () => calls.filter(([kind]) => kind === "request");
  return { base, post, calls, names, requests };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("telemetry", () => {
  it("reports a request by route, status and duration", async () => {
    const { post, requests } = await start();
    await post("/rs/render?secret=1", { templateBase64: T, outputFormat: "docx" });
    await settle();
    expect(requests()).toEqual([["request", "POST /rs/render", 200, expect.any(Number)]]);
  });

  it("labels an unknown path or method without echoing it", async () => {
    const { base, requests } = await start();
    await fetch(`${base}/some/secret-id`);
    await fetch(`${base}/rs/render`, { method: "DELETE" });
    await settle();
    expect(requests().map((call) => call[1])).toEqual(["unmatched", "OTHER /rs/render"]);
    expect(requests().map((call) => call[2])).toEqual([404, 405]);
  });

  it.each([
    ["pdf", "convert.duration"],
    ["docx", "render.duration"]
  ])("times a %s render", async (format, metric) => {
    const { post, calls } = await start();
    await post("/rs/render", { templateBase64: T, outputFormat: format });
    expect(calls.filter(([kind, name]) => kind === "metric" && name === metric)).toHaveLength(1);
    expect(calls.find(([, name]) => name === "render.duration")?.[3]).toEqual({ outputFormat: format });
  });

  it("times a conversion to another format and an upload conversion", async () => {
    const { base, post, calls } = await start();
    await post("/rs/render", { templateBase64: T, outputFormat: "odt" });
    const body = new FormData();
    body.append("file", new Blob(["x"]), "a.docx");
    await fetch(`${base}/rs/convert`, { method: "POST", body });
    expect(calls.filter(([, name]) => name === "convert.duration").map((call) => call[3])).toEqual([{ outputFormat: "odt" }, { outputFormat: "pdf" }]);
  });

  it("counts merge errors by kind and limit trips by type", async () => {
    const limit = new MergeError("Template exceeds the merge limits", ["x"], "limit", "repeatItems");
    const { post, names } = await start({
      merge: vi
        .fn()
        .mockRejectedValueOnce(limit)
        .mockRejectedValueOnce(new MergeError("Template merge failed", ["m"]))
    });
    await post("/rs/render", { templateBase64: T });
    await post("/rs/render", { templateBase64: T });
    expect(names().filter(([kind]) => kind === "event")).toEqual([
      ["event", "merge.error", { kind: "limit" }],
      ["event", "limit.tripped", { type: "repeatItems" }],
      ["event", "merge.error", { kind: "merge" }]
    ]);
  });

  it("counts body limit trips and too many includes", async () => {
    const { post, names } = await start({ maxBodyBytes: 100 });
    await post("/rs/render", { templateBase64: "A".repeat(500) }).catch(() => undefined);
    await settle();
    expect(names()).toContainEqual(["event", "limit.tripped", { type: "body" }]);
    await server?.close();
  });

  it("counts queue-busy 503s", async () => {
    const busy = Object.assign(new Error("queue full"), { name: "ConversionBusyError" });
    const { post, names } = await start({ convert: vi.fn().mockRejectedValue(busy) });
    expect((await post("/rs/render", { templateBase64: T })).status).toBe(503);
    expect(names()).toContainEqual(["event", "conversion.busy", undefined]);
  });

  it("counts LibreOffice timeouts and reports the exception without its message", async () => {
    const { post, names, calls } = await start({ convert: vi.fn().mockRejectedValue(new ConversionError("LibreOffice timed out after 5ms", true)) });
    expect((await post("/rs/render", { templateBase64: T })).status).toBe(500);
    expect(names()).toContainEqual(["event", "libreoffice.timeout", undefined]);
    expect(calls.some(([kind]) => kind === "exception")).toBe(true);
  });

  it("reports other conversion failures and unexpected errors as exceptions", async () => {
    const { post, names } = await start({ convert: vi.fn().mockRejectedValueOnce(new ConversionError("bad")).mockRejectedValueOnce("not an error") });
    await post("/rs/render", { templateBase64: T });
    await post("/rs/render", { templateBase64: T });
    const seen = names().map(([kind, name]) => `${kind}:${name instanceof Error ? name.message : name}`);
    expect(seen).toContain("event:conversion.failed");
    expect(seen).toContain("exception:bad");
    expect(seen).toContain("exception:non-error thrown");
  });

  it("never passes template content or data to telemetry", async () => {
    const { post, calls } = await start({ merge: vi.fn().mockRejectedValue(new MergeError("secret-message", ["secret-detail"])) });
    await post("/rs/render", { templateBase64: T, data: { name: "SECRET-DATA" }, outputName: "SECRET-NAME.pdf" });
    await settle();
    expect(JSON.stringify(calls)).not.toMatch(/SECRET|secret/);
  });
});

describe("scrubbed", () => {
  it("keeps the stack frames and drops the message", () => {
    const error = new Error("quotes SECRET template text");
    const safe = scrubbed(error);
    expect(safe.message).toBe("Error");
    expect(safe.stack).not.toContain("SECRET");
    expect(safe.stack).toMatch(/\n\s+at /);
  });

  it("keeps the error name", () => {
    expect(scrubbed(new LimitError("x SECRET", "entries")).name).toBe("LimitError");
  });
});

describe("startTelemetry", () => {
  it("does nothing without a connection string", async () => {
    expect(await startTelemetry(undefined)).toBe(noTelemetry);
    expect(await startTelemetry("")).toBe(noTelemetry);
    expect(() => noTelemetry.request("r", 200, 1)).not.toThrow();
    expect(() => noTelemetry.exception(new Error("e"))).not.toThrow();
    expect(() => noTelemetry.event("e")).not.toThrow();
    expect(() => noTelemetry.metric("m", 1)).not.toThrow();
  });

  it("starts Application Insights for a connection string and sends nothing to a closed port", async () => {
    const telemetry = await startTelemetry("InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=http://127.0.0.1:1/");
    expect(telemetry).not.toBe(noTelemetry);
    expect(() => {
      telemetry.request("GET /health", 200, 1);
      telemetry.request("POST /rs/render", 503, 1);
      telemetry.exception(new Error("SECRET"), { a: "b" });
      telemetry.event("e", { a: "b" });
      telemetry.metric("m", 1, { a: "b" });
    }).not.toThrow();
  });

  it("falls back to doing nothing, and says why without the message, when Application Insights cannot start", async () => {
    vi.resetModules();
    vi.doMock("applicationinsights", () => {
      throw new Error("SECRET");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = await import("./telemetry.ts");
    expect(await fresh.startTelemetry("InstrumentationKey=x")).toBe(fresh.noTelemetry);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("SECRET");
    warn.mockRestore();
    vi.doUnmock("applicationinsights");
  });
});
