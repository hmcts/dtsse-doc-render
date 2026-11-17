import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Dependencies } from "./app.ts";
import { ConversionError } from "./convert.ts";
import { MergeError } from "./merge/index.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const read = async (response: Response) => (await response.json()) as Record<string, string>;

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("TEMPLATE")]);
const T = ZIP.toString("base64");
const MERGED = (data = "{}", dev = "false") => `MERGED ${ZIP.toString()} ${data} dev=${dev}`;

const start = async (overrides: Partial<Dependencies> = {}) => {
  const deps: Dependencies = {
    merge: vi.fn(async (template, data, options) => Buffer.from(`MERGED ${template.toString()} ${JSON.stringify(data)} dev=${options.devMode}`)),
    convert: vi.fn(async (document, extension) => Buffer.from(`PDF(${extension}) ${document.toString()}`)),
    ...overrides
  };
  server = createServer((request, response) => void createHandler(deps)(request, response));
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { deps, base };
};

const json = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const form = (fields: Record<string, string>, file?: { field: string; name: string; content: string }): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.append(key, value);
  }
  if (file) {
    data.append(file.field, new Blob([file.content]), file.name);
  }
  return data;
};

describe("health, status and ping", () => {
  it.each(["/health", "/health/liveness", "/health/readiness"])("reports %s as UP", async (path) => {
    const { base } = await start();
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({ status: "UP" });
  });

  it.each(["/rs/status", "/api/status"])("reports %s as ready", async (path) => {
    const { base } = await start();
    const response = await fetch(base + path);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await read(response)).toMatchObject({ ready: true, service: "dtsse-doc-render" });
  });

  it("reports not ready on /health/readiness, but live, when the converter is down", async () => {
    const { base } = await start({ ready: async () => false });
    const readiness = await fetch(`${base}/health/readiness`);
    expect(readiness.status).toBe(503);
    expect(await read(readiness)).toEqual({ status: "DOWN" });
    expect((await fetch(`${base}/health/liveness`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("reports the converter state on status", async () => {
    const { base } = await start({ ready: async () => false });
    expect(await read(await fetch(`${base}/api/status`))).toMatchObject({ ready: false });
  });

  it.each(["/rs/ping", "/api/ping"])("answers %s with 200", async (path) => {
    const { base } = await start();
    expect((await fetch(base + path)).status).toBe(200);
  });

  it("ignores the query string", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/health?x=1`)).status).toBe(200);
  });
});

describe("routing", () => {
  it("returns 404 in the error shape for an unknown path", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "Not found" });
  });

  it("returns 404 for an unknown operation and for inherited object keys", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/rs/whatever`)).status).toBe(404);
    expect((await fetch(`${base}/rs/constructor`)).status).toBe(404);
  });

  it("returns 405 for other methods", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  it("defaults a missing method and url", async () => {
    const handler = createHandler({ merge: vi.fn(), convert: vi.fn() });
    const writeHead = vi.fn();
    await handler({ headers: {} } as never, { writeHead, end: vi.fn() } as never);
    expect(writeHead.mock.calls[0]?.[0]).toBe(404);
  });
});

describe("render", () => {
  it.each(["/rs/render", "/api/render"])("renders JSON to pdf on %s", async (path) => {
    const { base, deps } = await start();
    const response = await json(base, path, { templateBase64: T, outputName: "out.pdf", data: { a: 1 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"out.pdf\"; filename*=UTF-8''out.pdf");
    expect(await response.text()).toBe(`PDF(docx) ${MERGED('{"a":1}')}`);
    expect(deps.convert).toHaveBeenCalledOnce();
  });

  it("ignores accessKey", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputFormat: "docx", accessKey: "anything" });
    expect(response.status).toBe(200);
  });

  it("returns docx without converting when outputFormat is docx", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName: "named", outputFormat: "docx", data: {} });
    expect(response.headers.get("content-type")).toBe(DOCX);
    expect(response.headers.get("content-disposition")).toContain('filename="named.docx"');
    expect(await response.text()).toBe(MERGED());
    expect(deps.convert).not.toHaveBeenCalled();
  });

  it("infers docx from the outputName extension", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName: "x.DOCX", data: {} });
    expect(response.headers.get("content-type")).toBe(DOCX);
  });

  it("prefers outputFormat over the outputName extension, as Docmosis does, appending the extension", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName: "x.docx", outputFormat: "PDF" });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain('filename="x.docx.pdf"');
  });

  it("defaults to pdf and a default file name", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain('filename="output.pdf"');
  });

  it.each(["x.doc", "x.odt", "x.html"])("refuses %s when no converter for other formats is configured", async (outputName) => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Unsupported outputFormat");
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it.each([
    ["x.doc", undefined, "doc", "application/msword", "x.doc"],
    ["x.odt", undefined, "odt", "application/vnd.oasis.opendocument.text", "x.odt"],
    ["x", "html", "html", "text/html", "x.html"]
  ])("renders %s through convertTo", async (outputName, outputFormat, target, mime, filename) => {
    const convertTo = vi.fn(async (_document: Buffer, _source: string, format: string) => Buffer.from(`AS-${format}`));
    const { base } = await start({ convertTo });
    const response = await json(base, "/rs/render", { templateBase64: T, outputName, outputFormat });
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("content-disposition")).toContain(`filename="${filename}"`);
    expect(await response.text()).toBe(`AS-${target}`);
    expect(convertTo.mock.calls[0]?.slice(1)).toEqual(["docx", target]);
  });

  it.each([{ outputName: "x.xyz" }, { outputName: "noextension" }])("returns 400 for an unknown output extension %j", async (body) => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, ...body });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toContain("known extension");
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("rejects an unsupported outputFormat before decoding the template", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64: "@@@@", outputFormat: "xyz" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Unsupported outputFormat");
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("accepts data as a JSON string", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputFormat: "docx", data: '{"b":2}' });
    expect(await response.text()).toBe(MERGED('{"b":2}'));
  });

  it("rejects data that is a malformed string", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, data: "{nope" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid data");
  });

  it.each([
    [true, "true"],
    ["true", "true"],
    ["TRUE", "true"],
    [false, "false"],
    ["false", "false"],
    [undefined, "false"]
  ])("reads devMode %j", async (devMode, expected) => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputFormat: "docx", devMode });
    expect(await response.text()).toContain(`dev=${expected}`);
  });

  it("renders form-urlencoded bodies", async () => {
    const { base } = await start();
    const body = new URLSearchParams({ templateBase64: T, outputFormat: "docx", data: '{"c":3}', devMode: "true" });
    const response = await fetch(`${base}/rs/render`, { method: "POST", body });
    expect(await response.text()).toBe(MERGED('{"c":3}', "true"));
  });

  it("renders multipart bodies", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, { method: "POST", body: form({ templateBase64: T, outputName: "o.docx", data: '{"d":4}' }) });
    expect(await response.text()).toBe(MERGED('{"d":4}'));
  });

  it("sanitises the file name in Content-Disposition", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName: 'a"b.pdf' });
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"a_b.pdf\"; filename*=UTF-8''a%22b.pdf");
  });

  it("sends a non-ASCII file name as an ASCII fallback plus filename*", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: T, outputName: "Hysbysiad – ŵ.pdf" });
    expect(response.status).toBe(200);
    const header = response.headers.get("content-disposition") ?? "";
    expect(header).toBe(`attachment; filename="Hysbysiad _ _.pdf"; filename*=UTF-8''Hysbysiad%20%E2%80%93%20%C5%B5.pdf`);
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? "")).toBe("Hysbysiad – ŵ.pdf");
  });

  it.each([{}, { templateName: "T.docx" }, { templateName: "" }, { templateBase64: "" }])(
    "returns 400 saying templates must be inline for %j",
    async (body) => {
      const { base, deps } = await start();
      const response = await json(base, "/rs/render", body);
      expect(response.status).toBe(400);
      const error = await read(response);
      expect(error).toMatchObject({ succeeded: false });
      expect(error.shortMsg).toContain("templateBase64 or templateFile");
      expect(error.shortMsg).toContain("render-by-name is not supported");
      expect(deps.merge).not.toHaveBeenCalled();
    }
  );

  it.each(["{broken", "[1]", "null"])("returns 400 for JSON body %s", async (body) => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid request body");
  });

  it("returns 400 for a malformed multipart body", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: "--xyz\r\nbroken"
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for multipart without a boundary", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, { method: "POST", headers: { "content-type": "multipart/form-data" }, body: "x" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid multipart body");
  });

  it("treats an empty body as no fields", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, { method: "POST" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toContain("render-by-name is not supported");
  });

  it("returns 400 with the details of a MergeError", async () => {
    const merge = vi.fn().mockRejectedValue(new MergeError("bad template", ["row 1: no end tag", "row 2: unknown field"]));
    const { base } = await start({ merge });
    const response = await json(base, "/rs/render", { templateBase64: T });
    expect(response.status).toBe(400);
    const body = await read(response);
    expect(body.shortMsg).toBe("row 1: no end tag");
    expect(body.longMsg).toBe("bad template\nrow 1: no end tag\nrow 2: unknown field");
  });

  it("uses the error message as shortMsg when a MergeError has no details", async () => {
    const merge = vi.fn().mockRejectedValue(new MergeError("bad template"));
    const { base } = await start({ merge });
    const body = await read(await json(base, "/rs/render", { templateBase64: T }));
    expect(body).toEqual({ succeeded: false, shortMsg: "bad template", longMsg: "bad template" });
  });

  it("returns 500 for a conversion failure", async () => {
    const convert = vi.fn().mockRejectedValue(new ConversionError("soffice died"));
    const { base } = await start({ convert });
    const response = await json(base, "/rs/render", { templateBase64: T });
    expect(response.status).toBe(500);
    expect(await read(response)).toEqual({ succeeded: false, shortMsg: "Conversion failed", longMsg: "soffice died" });
  });

  it("returns 503 with Retry-After when the conversion queue is full", async () => {
    const busy = Object.assign(new Error("queue full"), { name: "ConversionBusyError" });
    const convert = vi.fn().mockRejectedValue(busy);
    const { base } = await start({ convert });
    const response = await json(base, "/rs/render", { templateBase64: T });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await read(response)).toMatchObject({ succeeded: false, longMsg: "queue full" });
  });

  it.each([new Error("boom"), "string failure"])("returns 500 for an unexpected error %s", async (failure) => {
    const merge = vi.fn().mockRejectedValue(failure);
    const { base } = await start({ merge });
    const response = await json(base, "/rs/render", { templateBase64: T });
    expect(response.status).toBe(500);
    expect((await read(response)).shortMsg).toBe("Internal error");
  });
});

describe("inline template", () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0xfb, 0xff, 0xfe, 0x3e, 0x3f, 0x00, 0x41])]);
  const standard = zip.toString("base64");
  const urlSafe = zip.toString("base64url");
  const merged = `MERGED ${zip.toString()} {"a":1} dev=false`;

  it("uses bytes that differ between the two alphabets", () => {
    expect(standard).not.toBe(urlSafe);
  });

  it.each([
    ["standard", standard],
    ["URL-safe without padding", urlSafe],
    ["URL-safe with padding", urlSafe.padEnd(standard.length, "=")],
    ["with newlines", standard.replace(/(.{4})/g, "$1\n")],
    ["with a data URL prefix", `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${standard}`],
    ["with a data URL prefix and CRLFs", `data:;base64,${standard.replace(/(.{4})/g, "$1\r\n")}`]
  ])("renders templateBase64 %s on both prefixes", async (_label, templateBase64) => {
    const { base } = await start();
    for (const path of ["/rs/render", "/api/render"]) {
      const response = await json(base, path, { templateBase64, outputFormat: "docx", data: { a: 1 } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(merged);
    }
  });

  it("converts an inline template to a PDF", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: standard, data: { a: 1 } });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe(`PDF(docx) ${merged}`);
  });

  it("renders a multipart templateFile with data as a field", async () => {
    const { base } = await start();
    const body = new FormData();
    body.append("templateFile", new Blob([zip]), "T.docx");
    body.append("data", '{"a":1}');
    body.append("outputFormat", "docx");
    const response = await fetch(`${base}/api/render`, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(merged);
  });

  it("renders a multipart templateFile with data as a file part", async () => {
    const { base } = await start();
    const body = new FormData();
    body.append("templateFile", new Blob([zip]), "T.docx");
    body.append("data", new Blob(['{"a":1}'], { type: "application/json" }), "payload.json");
    body.append("outputFormat", "docx");
    const response = await fetch(`${base}/rs/render`, { method: "POST", body });
    expect(await response.text()).toBe(merged);
  });

  it("uses templateName only in messages", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "../x.docx", templateBase64: standard, outputFormat: "docx", data: { a: 1 } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(merged);
  });

  it.each(["not base64!", "A", "   ", "data:;base64,"])("returns 400 for bad base64 %j", async (templateBase64) => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64 });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toMatch(/templateBase64/);
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("names the template in the base64 error", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "Mine.docx", templateBase64: "@@@@" });
    const body = await read(response);
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ succeeded: false, shortMsg: "Invalid templateBase64" });
    expect(body.longMsg).toContain("Mine.docx");
  });

  it("returns 400 when templateBase64 is not a string", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: 5 });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid templateBase64");
  });

  it("returns 400 when the decoded bytes are not a zip", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64: Buffer.from("hello world").toString("base64") });
    expect(response.status).toBe(400);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "Invalid template" });
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("returns 400 when a multipart templateFile is not a zip", async () => {
    const { base } = await start();
    const body = new FormData();
    body.append("templateFile", new Blob(["plain text"]), "T.docx");
    const response = await fetch(`${base}/rs/render`, { method: "POST", body });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid template");
  });
});

describe("convert", () => {
  it.each(["/rs/convert", "/api/convert"])("converts an upload on %s", async (path) => {
    const { base, deps } = await start();
    const response = await fetch(base + path, {
      method: "POST",
      body: form({ accessKey: "k", outputName: "doc.rtf.pdf" }, { field: "file", name: "doc.RTF", content: "BYTES" })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"doc.rtf.pdf\"; filename*=UTF-8''doc.rtf.pdf");
    expect(await response.text()).toBe("PDF(rtf) BYTES");
    expect(deps.convert).toHaveBeenCalledWith(Buffer.from("BYTES"), "rtf");
  });

  it("defaults the extension to docx and the output name", async () => {
    const { base, deps } = await start();
    const response = await fetch(`${base}/rs/convert`, { method: "POST", body: form({}, { field: "file", name: "noext", content: "X" }) });
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"output.pdf\"; filename*=UTF-8''output.pdf");
    expect(deps.convert).toHaveBeenCalledWith(Buffer.from("X"), "docx");
  });

  it("returns 400 without a file", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/convert`, { method: "POST", body: form({ outputName: "a.pdf" }) });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Missing file");
  });
});

describe("removed endpoints", () => {
  it.each(["listTemplates", "uploadTemplate"])("answers %s with 404", async (operation) => {
    const { base } = await start();
    expect((await json(base, `/api/${operation}`, {})).status).toBe(404);
  });

  it.each(["getTemplateStructure", "getSampleData"])("answers %s with 501", async (operation) => {
    const { base } = await start();
    const response = await json(base, `/api/${operation}`, { templateName: "T.docx" });
    expect(response.status).toBe(501);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "not supported by dtsse-doc-render" });
  });
});

describe("body limit", () => {
  it("accepts a multipart data field larger than 1 MB", async () => {
    const { base } = await start();
    const big = JSON.stringify({ text: "x".repeat(1_500_000) });
    const response = await fetch(`${base}/rs/render`, { method: "POST", body: form({ templateBase64: T, outputFormat: "docx", data: big }) });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBe(MERGED(big).length);
  });

  it("returns 413 rather than truncating a multipart field over the limit", async () => {
    const { base, deps } = await start({ maxBodyBytes: 2000 });
    const response = await fetch(`${base}/rs/render`, { method: "POST", body: form({ templateBase64: T, data: "x".repeat(2500) }) });
    expect(response.status).toBe(413);
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("returns 413 for a multipart file part over the limit", async () => {
    const { base } = await start({ maxBodyBytes: 2000 });
    const response = await fetch(`${base}/rs/convert`, { method: "POST", body: form({}, { field: "file", name: "a.docx", content: "x".repeat(2500) }) });
    expect(response.status).toBe(413);
  });

  it("returns 413 when Content-Length exceeds the limit", async () => {
    const { base } = await start({ maxBodyBytes: 50 });
    const response = await json(base, "/rs/render", { templateBase64: T, data: "x".repeat(200) });
    expect(response.status).toBe(413);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "Request body too large" });
  });

  it("returns 413 for a chunked body that grows past the limit", async () => {
    const { base } = await start({ maxBodyBytes: 50 });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{".padEnd(40, " ")));
        controller.enqueue(new TextEncoder().encode("}".padStart(40, " ")));
        controller.close();
      }
    });
    const response = await fetch(`${base}/rs/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half"
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("accepts a body at the limit", async () => {
    const { base } = await start({ maxBodyBytes: 10_000 });
    const response = await json(base, "/rs/render", { templateBase64: T, outputFormat: "docx", data: { text: "x".repeat(200) } });
    expect(response.status).toBe(200);
  });
});
