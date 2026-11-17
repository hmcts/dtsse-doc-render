import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./app.ts";
import { ConversionError, ConversionInputError } from "./convert.ts";
import { LimitError } from "./merge/errors.ts";
import { MergeError } from "./merge/index.ts";
import { installCrashHandlers, noTelemetry, type RequestReport, scrubbed, startTelemetry, type Telemetry } from "./telemetry.ts";

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("T")]);
const T = ZIP.toString("base64");

const fake = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const telemetry: Telemetry = {
    request: (...args) => calls.push(["request", ...args]),
    exception: (...args) => calls.push(["exception", ...args]),
    event: (...args) => calls.push(["event", ...args]),
    metric: (...args) => calls.push(["metric", ...args]),
    flush: async () => {}
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
  const requests = () => calls.filter(([kind]) => kind === "request").map(([, report]) => report as RequestReport);
  return { base, post, calls, names, requests };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("telemetry", () => {
  it("reports a request by route, status and duration", async () => {
    const { post, requests } = await start();
    await post("/rs/render?secret=1", { templateBase64: T, outputFormat: "docx" });
    await settle();
    expect(requests()).toEqual([{ method: "POST", route: "/rs/render", status: 200, durationMs: expect.any(Number), success: true }]);
  });

  it("labels an unknown path or method without echoing it", async () => {
    const { base, requests } = await start();
    await fetch(`${base}/some/secret-id`);
    await fetch(`${base}/rs/render`, { method: "DELETE" });
    await settle();
    expect(requests().map(({ method, route, status }) => [method, route, status])).toEqual([
      ["GET", "unmatched", 404],
      ["_OTHER", "/rs/render", 405]
    ]);
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

  it("counts body limit trips", async () => {
    const { post, names } = await start({ maxBodyBytes: 100 });
    await post("/rs/render", { templateBase64: "A".repeat(500) }).catch(() => undefined);
    await settle();
    expect(names()).toContainEqual(["event", "limit.tripped", { type: "body" }]);
  });

  it("counts too many includes", async () => {
    const { post, names } = await start();
    const includes = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`t${index}`, T]));
    expect((await post("/rs/render", { templateBase64: T, includes })).status).toBe(400);
    expect(names()).toContainEqual(["event", "limit.tripped", { type: "includes" }]);
  });

  it.each([
    ["/rs/convert", "a.exe", "source_type"],
    ["/rs/convert", "a.docx", "content_mismatch"]
  ])("counts a rejected conversion input as an event, not an exception", async (path, filename, reason) => {
    const rejected = new ConversionInputError("bad input SECRET", reason as "source_type");
    const { base, names, calls } = await start({ convert: vi.fn().mockRejectedValue(rejected) });
    const body = new FormData();
    body.append("file", new Blob(["x"]), filename);
    expect((await fetch(base + path, { method: "POST", body })).status).toBe(400);
    expect(names()).toContainEqual(["event", "conversion.rejected", { reason }]);
    expect(names().some(([kind, name]) => kind === "event" && name === "conversion.failed")).toBe(false);
    expect(calls.some(([kind]) => kind === "exception")).toBe(false);
  });

  describe("a client that goes away", () => {
    it("is recorded as 499 and failed when it disconnects before the response", async () => {
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { base, requests } = await start({
        convert: async () => {
          await hold;
          return Buffer.from("pdf");
        }
      });
      const controller = new AbortController();
      const body = new FormData();
      body.append("file", new Blob(["x"]), "a.docx");
      const pending = fetch(`${base}/rs/convert`, { method: "POST", body, signal: controller.signal }).catch(() => undefined);
      await settle();
      controller.abort();
      await pending;
      await settle();
      release();
      await settle();
      expect(requests()).toEqual([{ method: "POST", route: "/rs/convert", status: 499, durationMs: expect.any(Number), success: false }]);
    });

    it("is recorded once, with the real status, when the response completed", async () => {
      const { post, requests } = await start();
      await post("/rs/render", { templateBase64: T, outputFormat: "docx" });
      await settle();
      expect(requests()).toHaveLength(1);
      expect(requests()[0]).toMatchObject({ status: 200, success: true });
    });
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
    expect(() => noTelemetry.request({ method: "GET", route: "r", status: 200, durationMs: 1, success: true })).not.toThrow();
    expect(() => noTelemetry.exception(new Error("e"))).not.toThrow();
    expect(() => noTelemetry.event("e")).not.toThrow();
    expect(() => noTelemetry.metric("m", 1)).not.toThrow();
    await expect(noTelemetry.flush()).resolves.toBeUndefined();
  });

  describe("with a connection string", () => {
    const insights = () => {
      const client = {
        trackRequest: vi.fn(),
        trackException: vi.fn(),
        trackEvent: vi.fn(),
        trackMetric: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined)
      };
      const configuration = {
        setAutoCollectRequests: vi.fn().mockReturnThis(),
        setAutoCollectDependencies: vi.fn().mockReturnThis(),
        setAutoCollectConsole: vi.fn().mockReturnThis(),
        setAutoCollectPerformance: vi.fn().mockReturnThis(),
        setAutoCollectExceptions: vi.fn().mockReturnThis(),
        setUseDiskRetryCaching: vi.fn().mockReturnThis(),
        start: vi.fn().mockReturnThis()
      };
      const setup = vi.fn().mockReturnValue(configuration);
      return { client, configuration, setup, module: { setup, defaultClient: client } };
    };

    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_SERVICE_NAME;
      vi.resetModules();
    });
    afterEach(() => {
      if (saved === undefined) {
        delete process.env.OTEL_SERVICE_NAME;
      } else {
        process.env.OTEL_SERVICE_NAME = saved;
      }
      vi.doUnmock("applicationinsights");
      vi.restoreAllMocks();
    });

    const startWith = async (mocked: ReturnType<typeof insights>) => {
      vi.doMock("applicationinsights", () => mocked.module);
      vi.spyOn(process, "on").mockImplementation(() => process);
      const fresh = await import("./telemetry.ts");
      return fresh.startTelemetry("InstrumentationKey=00000000-0000-0000-0000-000000000000");
    };

    it("turns off what would send unscrubbed or unbounded data, and asks for no extended metrics", async () => {
      const mocked = insights();
      const telemetry = await startWith(mocked);
      expect(telemetry).not.toBe(noTelemetry);
      expect(mocked.configuration.setAutoCollectRequests).toHaveBeenCalledWith(false);
      expect(mocked.configuration.setAutoCollectDependencies).toHaveBeenCalledWith(false);
      expect(mocked.configuration.setAutoCollectConsole).toHaveBeenCalledWith(false, false);
      expect(mocked.configuration.setAutoCollectExceptions).toHaveBeenCalledWith(false);
      expect(mocked.configuration.setAutoCollectPerformance).toHaveBeenCalledWith(true, false);
      expect(mocked.configuration.start).toHaveBeenCalledOnce();
    });

    it("names the cloud role dtsse-doc-render unless the chart sets OTEL_SERVICE_NAME", async () => {
      await startWith(insights());
      expect(process.env.OTEL_SERVICE_NAME).toBe("dtsse-doc-render");
      vi.resetModules();
      process.env.OTEL_SERVICE_NAME = "dtsse-doc-render-pr-12";
      await startWith(insights());
      expect(process.env.OTEL_SERVICE_NAME).toBe("dtsse-doc-render-pr-12");
    });

    it("sends a request with the method, route and status that the exporter reads", async () => {
      const mocked = insights();
      const telemetry = await startWith(mocked);
      telemetry.request({ method: "POST", route: "/rs/render", status: 503, durationMs: 12, success: false });
      expect(mocked.client.trackRequest).toHaveBeenCalledWith({
        name: "POST /rs/render",
        url: "/rs/render",
        duration: 12,
        resultCode: "503",
        success: false,
        properties: { "http.method": "POST", "http.route": "/rs/render" }
      });
    });

    it("sends exceptions without their messages, and events and metrics as given", async () => {
      const mocked = insights();
      const telemetry = await startWith(mocked);
      telemetry.exception(new Error("SECRET"), { a: "b" });
      telemetry.event("e", { a: "b" });
      telemetry.metric("m", 1, { a: "b" });
      const sent = mocked.client.trackException.mock.calls[0]?.[0] as { exception: Error; properties: unknown };
      expect(sent.exception.message).toBe("Error");
      expect(sent.exception.stack).not.toContain("SECRET");
      expect(sent.properties).toEqual({ a: "b" });
      expect(mocked.client.trackEvent).toHaveBeenCalledWith({ name: "e", properties: { a: "b" } });
      expect(mocked.client.trackMetric).toHaveBeenCalledWith({ name: "m", value: 1, properties: { a: "b" } });
    });

    it("flushes the client, and gives up after the timeout when the flush hangs", async () => {
      const mocked = insights();
      const telemetry = await startWith(mocked);
      await telemetry.flush();
      expect(mocked.client.flush).toHaveBeenCalledOnce();
      mocked.client.flush.mockReturnValue(new Promise(() => undefined));
      await expect(telemetry.flush(10)).resolves.toBeUndefined();
      mocked.client.flush.mockRejectedValue(new Error("down"));
      await expect(telemetry.flush(10)).resolves.toBeUndefined();
    });

    it("registers crash handlers on the process", async () => {
      vi.doMock("applicationinsights", () => insights().module);
      const on = vi.spyOn(process, "on").mockImplementation(() => process);
      const fresh = await import("./telemetry.ts");
      await fresh.startTelemetry("InstrumentationKey=x");
      expect(on.mock.calls.map(([event]) => event)).toEqual(["uncaughtException", "unhandledRejection"]);
    });
  });

  describe("crash handlers", () => {
    const install = () => {
      const { calls, telemetry } = fake();
      const flush = vi.fn().mockResolvedValue(undefined);
      const exit = vi.fn();
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const handlers = new Map<string, (reason: unknown) => void>();
      vi.spyOn(process, "on").mockImplementation(((event: string, handler: (reason: unknown) => void) => {
        handlers.set(event, handler);
        return process;
      }) as typeof process.on);
      const off = vi.spyOn(process, "off").mockImplementation(() => process);
      const remove = installCrashHandlers({ ...telemetry, flush }, exit);
      return { calls, flush, exit, error, handlers, off, remove };
    };

    afterEach(() => vi.restoreAllMocks());

    it.each(["uncaughtException", "unhandledRejection"])("sends the %s without its message, flushes, prints it and exits with 1", async (event) => {
      const { calls, flush, exit, error, handlers } = install();
      const failure = new TypeError("quotes SECRET template text");
      handlers.get(event)?.(failure);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(calls.filter(([kind]) => kind === "exception")).toHaveLength(1);
      expect(flush).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(failure);
      expect(exit).toHaveBeenCalledOnce();
    });

    it("reports a rejection that is not an error, and only reports the first crash", async () => {
      const { calls, exit, handlers } = install();
      handlers.get("unhandledRejection")?.("a string");
      handlers.get("uncaughtException")?.(new Error("second"));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(calls.filter(([kind]) => kind === "exception")).toHaveLength(1);
    });

    it("exits even when the flush fails", async () => {
      const { exit, handlers, flush } = install();
      flush.mockRejectedValue(new Error("down"));
      handlers.get("uncaughtException")?.(new Error("x"));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    });

    it("can be removed", () => {
      const { remove, off } = install();
      remove();
      expect(off.mock.calls.map(([event]) => event)).toEqual(["uncaughtException", "unhandledRejection"]);
    });
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
