import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Dependencies } from "./app.ts";
import { ConversionError } from "./convert.ts";
import { MergeError } from "./merge/index.ts";
import type { TemplateStore } from "./store.ts";
import { InvalidTemplateName } from "./store.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const read = async (response: Response) => (await response.json()) as Record<string, string>;

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

const fakeStore = (templates: Record<string, string> = { "T.docx": "TEMPLATE" }): TemplateStore => ({
  find: vi.fn(async (name: string) => {
    if (name.includes("..")) {
      throw new InvalidTemplateName("bad name");
    }
    return templates[name] === undefined ? undefined : Buffer.from(templates[name]);
  }),
  list: vi.fn(async () => Object.keys(templates).sort()),
  save: vi.fn(async (name: string, content: Buffer) => {
    if (name.includes("..")) {
      throw new InvalidTemplateName("bad name");
    }
    templates[name] = content.toString();
  })
});

const start = async (overrides: Partial<Dependencies> = {}) => {
  const deps: Dependencies = {
    store: fakeStore(),
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
  it.each(["/health", "/health/liveness"])("reports %s as UP", async (path) => {
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
    const handler = createHandler({ store: fakeStore(), merge: vi.fn(), convert: vi.fn() });
    const writeHead = vi.fn();
    await handler({ headers: {} } as never, { writeHead, end: vi.fn() } as never);
    expect(writeHead.mock.calls[0]?.[0]).toBe(404);
  });
});

describe("render", () => {
  it.each(["/rs/render", "/api/render"])("renders JSON to pdf on %s", async (path) => {
    const { base, deps } = await start();
    const response = await json(base, path, { templateName: "T.docx", outputName: "out.pdf", data: { a: 1 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="out.pdf"');
    expect(await response.text()).toBe('PDF(docx) MERGED TEMPLATE {"a":1} dev=false');
    expect(deps.convert).toHaveBeenCalledOnce();
  });

  it("returns docx without converting when outputFormat is docx", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputName: "IGNORED", outputFormat: "docx", data: {} });
    expect(response.headers.get("content-type")).toBe(DOCX);
    expect(await response.text()).toBe("MERGED TEMPLATE {} dev=false");
    expect(deps.convert).not.toHaveBeenCalled();
  });

  it("infers docx from the outputName extension", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputName: "x.DOCX", data: {} });
    expect(response.headers.get("content-type")).toBe(DOCX);
  });

  it("prefers outputFormat over the outputName extension", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputName: "x.docx", outputFormat: "PDF" });
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("defaults to pdf and a default file name", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx" });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="output.pdf"');
  });

  it("rejects an unsupported outputFormat", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputFormat: "odt" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Unsupported outputFormat");
  });

  it("accepts data as a JSON string", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputFormat: "docx", data: '{"b":2}' });
    expect(await response.text()).toBe('MERGED TEMPLATE {"b":2} dev=false');
  });

  it("rejects data that is a malformed string", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", data: "{nope" });
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
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputFormat: "docx", devMode });
    expect(await response.text()).toContain(`dev=${expected}`);
  });

  it("renders form-urlencoded bodies", async () => {
    const { base } = await start();
    const body = new URLSearchParams({ templateName: "T.docx", outputFormat: "docx", data: '{"c":3}', devMode: "true" });
    const response = await fetch(`${base}/rs/render`, { method: "POST", body });
    expect(await response.text()).toBe('MERGED TEMPLATE {"c":3} dev=true');
  });

  it("renders multipart bodies", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/render`, {
      method: "POST",
      body: form({ templateName: "T.docx", outputName: "o.docx", data: '{"d":4}' })
    });
    expect(await response.text()).toBe('MERGED TEMPLATE {"d":4} dev=false');
  });

  it("sanitises the file name in Content-Disposition", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", outputName: 'a"b.pdf' });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="a_b.pdf"');
  });

  it("returns 400 with 'template does not exist' for a missing template", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "Missing.docx" });
    expect(response.status).toBe(400);
    const body = await read(response);
    expect(body).toMatchObject({ succeeded: false });
    expect(body.shortMsg).toContain("template does not exist");
    expect(body.longMsg).toContain("Missing.docx");
  });

  it.each([{}, { templateName: "" }, { templateName: 5 }])("returns 400 when templateName is %j", async (body) => {
    const { base } = await start();
    const response = await json(base, "/rs/render", body);
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Missing templateName");
  });

  it("returns 400 for a traversing template name", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateName: "../../etc/passwd" });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Invalid template name");
  });

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
    expect((await read(response)).shortMsg).toBe("Missing templateName");
  });

  it("returns 400 with the details of a MergeError", async () => {
    const merge = vi.fn().mockRejectedValue(new MergeError("bad template", ["row 1: no end tag", "row 2: unknown field"]));
    const { base } = await start({ merge });
    const response = await json(base, "/rs/render", { templateName: "T.docx" });
    expect(response.status).toBe(400);
    const body = await read(response);
    expect(body.shortMsg).toBe("row 1: no end tag");
    expect(body.longMsg).toBe("bad template\nrow 1: no end tag\nrow 2: unknown field");
  });

  it("uses the error message as shortMsg when a MergeError has no details", async () => {
    const merge = vi.fn().mockRejectedValue(new MergeError("bad template"));
    const { base } = await start({ merge });
    const body = await read(await json(base, "/rs/render", { templateName: "T.docx" }));
    expect(body).toEqual({ succeeded: false, shortMsg: "bad template", longMsg: "bad template" });
  });

  it("returns 500 for a conversion failure", async () => {
    const convert = vi.fn().mockRejectedValue(new ConversionError("soffice died"));
    const { base } = await start({ convert });
    const response = await json(base, "/rs/render", { templateName: "T.docx" });
    expect(response.status).toBe(500);
    expect(await read(response)).toEqual({ succeeded: false, shortMsg: "Conversion failed", longMsg: "soffice died" });
  });

  it.each([new Error("boom"), "string failure"])("returns 500 for an unexpected error %s", async (failure) => {
    const merge = vi.fn().mockRejectedValue(failure);
    const { base } = await start({ merge });
    const response = await json(base, "/rs/render", { templateName: "T.docx" });
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
    const { base, deps } = await start();
    for (const path of ["/rs/render", "/api/render"]) {
      const response = await json(base, path, { templateBase64, outputFormat: "docx", data: { a: 1 } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(merged);
    }
    expect(deps.store.find).not.toHaveBeenCalled();
  });

  it("converts an inline template to a PDF", async () => {
    const { base } = await start();
    const response = await json(base, "/rs/render", { templateBase64: standard, data: { a: 1 } });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe(`PDF(docx) ${merged}`);
  });

  it("renders a multipart templateFile with data as a field", async () => {
    const { base, deps } = await start();
    const body = new FormData();
    body.append("templateFile", new Blob([zip]), "T.docx");
    body.append("data", '{"a":1}');
    body.append("outputFormat", "docx");
    const response = await fetch(`${base}/api/render`, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(merged);
    expect(deps.store.find).not.toHaveBeenCalled();
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

  it("prefers the inline template over a templateName and never touches the store", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateName: "T.docx", templateBase64: standard, outputFormat: "docx", data: { a: 1 } });
    expect(await response.text()).toBe(merged);
    expect(deps.store.find).not.toHaveBeenCalled();
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.store.list).not.toHaveBeenCalled();
  });

  it("does not validate or look up templateName when a template is inline", async () => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateName: "../x.docx", templateBase64: standard, outputFormat: "docx" });
    expect(response.status).toBe(200);
    expect(deps.store.find).not.toHaveBeenCalled();
  });

  it.each(["not base64!", "A", "   ", "data:;base64,"])("returns 400 for bad base64 %j", async (templateBase64) => {
    const { base, deps } = await start();
    const response = await json(base, "/rs/render", { templateBase64 });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toMatch(/templateBase64|Missing templateName/);
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

  it("enforces the access key for inline templates", async () => {
    const { base, deps } = await start({ accessKey: "secret" });
    const denied = await json(base, "/rs/render", { templateBase64: standard });
    expect(denied.status).toBe(401);
    expect(deps.merge).not.toHaveBeenCalled();
    const allowed = await json(base, "/rs/render", { templateBase64: standard, accessKey: "secret", outputFormat: "docx", data: { a: 1 } });
    expect(allowed.status).toBe(200);
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
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="doc.rtf.pdf"');
    expect(await response.text()).toBe("PDF(rtf) BYTES");
    expect(deps.convert).toHaveBeenCalledWith(Buffer.from("BYTES"), "rtf");
  });

  it("defaults the extension to docx and the output name", async () => {
    const { base, deps } = await start();
    const response = await fetch(`${base}/rs/convert`, { method: "POST", body: form({}, { field: "file", name: "noext", content: "X" }) });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="output.pdf"');
    expect(deps.convert).toHaveBeenCalledWith(Buffer.from("X"), "docx");
  });

  it("returns 400 without a file", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/rs/convert`, { method: "POST", body: form({ outputName: "a.pdf" }) });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Missing file");
  });
});

describe("template management", () => {
  it.each(["GET", "POST"])("lists templates with %s", async (method) => {
    const { base } = await start({ store: fakeStore({ "B.docx": "b", "A.docx": "a" }) });
    const response = await fetch(`${base}/api/listTemplates`, { method });
    expect(await read(response)).toEqual({ succeeded: true, templateList: [{ name: "A.docx" }, { name: "B.docx" }] });
  });

  it("uploads a template from file", async () => {
    const store = fakeStore({});
    const { base } = await start({ store });
    const response = await fetch(`${base}/api/uploadTemplate`, {
      method: "POST",
      body: form({ templateName: "New.docx" }, { field: "file", name: "ignored.docx", content: "NEW" })
    });
    expect(await read(response)).toEqual({ succeeded: true, templateName: "New.docx" });
    expect(store.save).toHaveBeenCalledWith("New.docx", Buffer.from("NEW"));
  });

  it("uploads from templateFile and falls back to the file name", async () => {
    const store = fakeStore({});
    const { base } = await start({ store });
    const response = await fetch(`${base}/rs/uploadTemplate`, {
      method: "POST",
      body: form({}, { field: "templateFile", name: "FromFile.docx", content: "Z" })
    });
    expect((await read(response)).templateName).toBe("FromFile.docx");
    expect(store.save).toHaveBeenCalledWith("FromFile.docx", Buffer.from("Z"));
  });

  it("rejects an upload without a file", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/uploadTemplate`, { method: "POST", body: form({ templateName: "A.docx" }) });
    expect(response.status).toBe(400);
  });

  it("rejects an upload that is not a docx", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/uploadTemplate`, {
      method: "POST",
      body: form({ templateName: "A.txt" }, { field: "file", name: "A.txt", content: "Z" })
    });
    expect(response.status).toBe(400);
    expect((await read(response)).shortMsg).toBe("Unsupported template");
  });

  it("rejects an upload with a traversing name", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/uploadTemplate`, {
      method: "POST",
      body: form({ templateName: "../x.docx" }, { field: "file", name: "x.docx", content: "Z" })
    });
    expect(response.status).toBe(400);
  });

  it.each(["getTemplateStructure", "getSampleData"])("answers %s with 501", async (operation) => {
    const { base } = await start();
    const response = await json(base, `/api/${operation}`, { templateName: "T.docx" });
    expect(response.status).toBe(501);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "not supported by dtsse-doc-render" });
  });
});

describe("access key", () => {
  const protectedStart = () => start({ accessKey: "secret" });

  it("rejects a missing key", async () => {
    const { base, deps } = await protectedStart();
    const response = await json(base, "/rs/render", { templateName: "T.docx" });
    expect(response.status).toBe(401);
    expect(await read(response)).toMatchObject({ succeeded: false, shortMsg: "Invalid access key" });
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("rejects a wrong key, including one of a different length", async () => {
    const { base } = await protectedStart();
    expect((await json(base, "/rs/render", { templateName: "T.docx", accessKey: "secreT" })).status).toBe(401);
    expect((await json(base, "/rs/render", { templateName: "T.docx", accessKey: "s" })).status).toBe(401);
    expect((await json(base, "/rs/render", { templateName: "T.docx", accessKey: 5 })).status).toBe(401);
  });

  it("accepts the key in a JSON body, a form, a multipart field and the query", async () => {
    const { base } = await protectedStart();
    expect((await json(base, "/rs/render", { templateName: "T.docx", accessKey: "secret" })).status).toBe(200);
    const urlencoded = await fetch(`${base}/rs/render`, { method: "POST", body: new URLSearchParams({ templateName: "T.docx", accessKey: "secret" }) });
    expect(urlencoded.status).toBe(200);
    const multipart = await fetch(`${base}/rs/convert`, {
      method: "POST",
      body: form({ accessKey: "secret" }, { field: "file", name: "a.docx", content: "x" })
    });
    expect(multipart.status).toBe(200);
    expect((await fetch(`${base}/api/listTemplates?accessKey=secret`)).status).toBe(200);
  });

  it("protects management endpoints but not health, ping or status", async () => {
    const { base } = await protectedStart();
    expect((await fetch(`${base}/api/listTemplates`)).status).toBe(401);
    expect((await fetch(`${base}/api/getSampleData`)).status).toBe(401);
    expect((await fetch(`${base}/api/uploadTemplate`, { method: "POST", body: form({}) })).status).toBe(401);
    for (const path of ["/health", "/health/liveness", "/rs/ping", "/api/ping", "/rs/status", "/api/status"]) {
      expect((await fetch(base + path)).status).toBe(200);
    }
  });

  it("does not check keys when none is configured", async () => {
    const { base } = await start();
    expect((await json(base, "/rs/render", { templateName: "T.docx", accessKey: "anything" })).status).toBe(200);
    expect((await json(base, "/rs/render", { templateName: "T.docx" })).status).toBe(200);
  });
});

describe("body limit", () => {
  it("returns 413 when Content-Length exceeds the limit", async () => {
    const { base } = await start({ maxBodyBytes: 50 });
    const response = await json(base, "/rs/render", { templateName: "T.docx", data: "x".repeat(200) });
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
    const response = await json(base, "/rs/render", { templateName: "T.docx", data: { text: "x".repeat(200) } });
    expect(response.status).toBe(200);
  });
});
