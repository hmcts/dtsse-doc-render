import type { IncomingMessage, ServerResponse } from "node:http";
import busboy from "busboy";
import { ConversionError } from "./convert.ts";
import { MergeError, type MergeOptions } from "./merge/index.ts";
import { noTelemetry, type Telemetry } from "./telemetry.ts";

export const MAX_BODY_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  html: "text/html",
  txt: "text/plain; charset=utf-8"
};

const CONVERTED_FORMATS = ["doc", "odt", "html", "txt"];
const KNOWN_EXTENSIONS = ["pdf", "docx", ...CONVERTED_FORMATS];

const PREFIXES = ["rs", "api"];

/** The Docmosis operations served under each prefix, with the methods openapi.yaml documents for them. */
const OPERATIONS: Record<string, string[]> = {
  status: ["GET"],
  ping: ["GET"],
  render: ["POST"],
  convert: ["POST"],
  getTemplateStructure: ["GET", "POST"],
  getSampleData: ["GET", "POST"]
};

/** Every route the service answers. openapi.yaml must document exactly these; app.openapi.test.ts checks it. */
export const ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/health/liveness" },
  { method: "GET", path: "/health/readiness" },
  { method: "GET", path: "/openapi.yaml" },
  ...PREFIXES.flatMap((prefix) =>
    Object.entries(OPERATIONS).flatMap(([operation, methods]) => methods.map((method) => ({ method, path: `/${prefix}/${operation}` })))
  )
];

const routeLabel = (method: string, path: string): string =>
  ROUTES.some((route) => route.path === path) ? `${method === "GET" || method === "POST" ? method : "OTHER"} ${path}` : "unmatched";

export interface Dependencies {
  merge: (template: Buffer, data: unknown, options: MergeOptions) => Promise<Buffer>;
  convert: (document: Buffer, sourceExtension: string) => Promise<Buffer>;
  /** Converts a document to a format other than PDF, for the doc, odt and html output formats. Those formats are refused when it is absent. */
  convertTo?: (document: Buffer, sourceExtension: string, targetFormat: string) => Promise<Buffer>;
  ready?: () => Promise<boolean>;
  maxBodyBytes?: number;
  /** The text served at GET /openapi.yaml; the route answers 404 without it. */
  openapi?: string;
  telemetry?: Telemetry;
}

interface UploadedFile {
  filename: string;
  content: Buffer;
}

interface ParsedRequest {
  params: Record<string, unknown>;
  files: Record<string, UploadedFile>;
  /** Extra file parts named "include", by filename. */
  includeFiles: UploadedFile[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly shortMsg: string,
    readonly longMsg: string = shortMsg,
    readonly headers: Record<string, string> = {}
  ) {
    super(shortMsg);
  }
}

const sendBytes = (response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void => {
  response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  sendBytes(response, status, { "content-type": "application/json" }, JSON.stringify(body));
};

const sendError = (response: ServerResponse, error: HttpError): void => {
  sendBytes(
    response,
    error.status,
    { "content-type": "application/json", ...error.headers },
    JSON.stringify({ succeeded: false, shortMsg: error.shortMsg, longMsg: error.longMsg })
  );
};

const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer> => {
  const tooLarge = new HttpError(413, "Request body too large", `Request bodies are limited to ${limit} bytes`);
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    throw tooLarge;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw tooLarge;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const parseMultipart = (body: Buffer, contentType: string, limit: number): Promise<ParsedRequest> =>
  new Promise((resolve, reject) => {
    const parsed: ParsedRequest = { params: {}, files: {}, includeFiles: [] };
    const tooLarge = new HttpError(413, "Request body too large", `Request bodies are limited to ${limit} bytes`);
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: { "content-type": contentType }, limits: { fieldSize: limit, fileSize: limit } });
    } catch (error) {
      reject(new HttpError(400, "Invalid multipart body", (error as Error).message));
      return;
    }
    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        reject(tooLarge);
        return;
      }
      parsed.params[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => reject(tooLarge));
      stream.on("end", () => {
        const file = { filename: info.filename ?? "", content: Buffer.concat(chunks) };
        if (name === "include") {
          parsed.includeFiles.push(file);
        } else {
          parsed.files[name] = file;
        }
      });
    });
    parser.on("error", (error) => reject(new HttpError(400, "Invalid multipart body", (error as Error).message)));
    parser.on("close", () => resolve(parsed));
    parser.end(body);
  });

const parseBody = async (request: IncomingMessage, limit: number): Promise<ParsedRequest> => {
  const contentType = request.headers["content-type"] ?? "";
  const body = await readBody(request, limit);
  if (/^multipart\/form-data/i.test(contentType)) {
    return parseMultipart(body, contentType, limit);
  }
  if (body.length === 0) {
    return { params: {}, files: {}, includeFiles: [] };
  }
  if (/^application\/x-www-form-urlencoded/i.test(contentType)) {
    return { params: Object.fromEntries(new URLSearchParams(body.toString("utf8"))), files: {}, includeFiles: [] };
  }
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    return { params: value as Record<string, unknown>, files: {}, includeFiles: [] };
  } catch (error) {
    throw new HttpError(400, "Invalid request body", `The request body is not valid JSON: ${(error as Error).message}`);
  }
};

const isTrue = (value: unknown): boolean => value === true || (typeof value === "string" && value.toLowerCase() === "true");

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const outputOf = (params: Record<string, unknown>): { format: string; name: string } => {
  const requested = typeof params.outputName === "string" && params.outputName !== "" ? params.outputName : "output.pdf";
  const explicit = typeof params.outputFormat === "string" ? params.outputFormat.toLowerCase().trim() : "";
  if (!explicit) {
    const extension = extensionOf(requested);
    if (!KNOWN_EXTENSIONS.includes(extension)) {
      throw new HttpError(400, '"outputName" must be specified with a known extension (eg .pdf) if "outputFormat" is not specified.');
    }
    return { format: extension, name: requested };
  }
  if (!["pdf", "docx", ...CONVERTED_FORMATS].includes(explicit)) {
    throw new HttpError(400, "Unsupported outputFormat", `outputFormat must be one of pdf, docx, doc, odt, html or txt, not ${params.outputFormat}`);
  }
  return { format: explicit, name: extensionOf(requested) === explicit ? requested : `${requested}.${explicit}` };
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const decodeBase64 = (value: string, label: string): Buffer => {
  const encoded = value
    .replace(/^\s*data:[^,]*,/i, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (encoded === "" || !/^[A-Za-z0-9+/]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new HttpError(400, "Invalid templateBase64", `${label}: templateBase64 is not valid base64`);
  }
  return Buffer.from(encoded, "base64");
};

const MISSING_TEMPLATE = "Templates must be sent inline (templateBase64 or templateFile); render-by-name is not supported by dtsse-doc-render";

const hasInlineTemplate = ({ params, files }: ParsedRequest): boolean =>
  Boolean(files.templateFile) || (params.templateBase64 !== undefined && params.templateBase64 !== "");

const zipOf = (content: Buffer, name: string): Buffer => {
  if (!content.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw new HttpError(400, "Invalid template", `${name} is not a .docx: the template bytes are not a zip archive`);
  }
  return content;
};

const templateOf = ({ params, files }: ParsedRequest): Buffer => {
  const name = typeof params.templateName === "string" && params.templateName !== "" ? params.templateName : "the inline template";
  let content: Buffer;
  if (files.templateFile) {
    content = files.templateFile.content;
  } else {
    if (typeof params.templateBase64 !== "string") {
      throw new HttpError(400, "Invalid templateBase64", `${name}: templateBase64 must be a base64 string`);
    }
    content = decodeBase64(params.templateBase64, name);
  }
  if (!content.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw new HttpError(400, "Invalid template", `${name} is not a .docx: the template bytes are not a zip archive`);
  }
  return content;
};

const MAX_INCLUDES = 100;

/** The templates a `ref:` or `refLookup:` may name: the JSON `includes` object (name to base64) and any "include" file parts (by filename). */
const includesOf = ({ params, includeFiles }: ParsedRequest): Record<string, Buffer> => {
  const included: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  let declared = params.includes;
  if (typeof declared === "string" && declared !== "") {
    try {
      declared = JSON.parse(declared);
    } catch (error) {
      throw new HttpError(400, "Invalid includes", `includes is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (declared !== undefined && declared !== null && declared !== "") {
    if (typeof declared !== "object" || Array.isArray(declared)) {
      throw new HttpError(400, "Invalid includes", "includes must be an object of template name to base64 .docx");
    }
    for (const [name, value] of Object.entries(declared)) {
      if (typeof value !== "string") {
        throw new HttpError(400, "Invalid includes", `${name}: an include must be a base64 string`);
      }
      included[name] = zipOf(decodeBase64(value, name), name);
    }
  }
  for (const file of includeFiles) {
    if (file.filename === "") {
      throw new HttpError(400, "Invalid includes", "an include file part needs a filename, which is the name a ref: tag uses");
    }
    included[file.filename] = zipOf(file.content, file.filename);
  }
  if (Object.keys(included).length > MAX_INCLUDES) {
    throw new HttpError(400, "Too many includes", `A request may carry at most ${MAX_INCLUDES} includes`);
  }
  return included;
};

const dataOf = ({ params, files }: ParsedRequest): unknown => {
  const data = files.data ? files.data.content.toString("utf8") : params.data;
  if (data === undefined || data === "") {
    return {};
  }
  if (typeof data !== "string") {
    return data;
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new HttpError(400, "Invalid data", `data is not valid JSON: ${(error as Error).message}`);
  }
};

const contentDisposition = (name: string): string => {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

export const createHandler = (deps: Dependencies) => {
  const { merge, convert, convertTo, ready, openapi } = deps;
  const telemetry = deps.telemetry ?? noTelemetry;
  const timed = async <T>(metric: string, format: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await work();
    telemetry.metric(metric, performance.now() - started, { outputFormat: format });
    return result;
  };
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  const render = async (parsed: ParsedRequest, response: ServerResponse): Promise<void> => {
    const output = outputOf(parsed.params);
    if (CONVERTED_FORMATS.includes(output.format) && !convertTo) {
      throw new HttpError(400, "Unsupported outputFormat", `${output.format} output is not supported by dtsse-doc-render; use pdf or docx`);
    }
    if (!hasInlineTemplate(parsed)) {
      throw new HttpError(400, MISSING_TEMPLATE, `${MISSING_TEMPLATE}. The request had no templateBase64 or templateFile.`);
    }
    const template = templateOf(parsed);
    const data = dataOf(parsed);
    const started = performance.now();
    const docx = await merge(template, data, { devMode: isTrue(parsed.params.devMode), includes: includesOf(parsed) });
    let bytes: Buffer;
    if (output.format === "docx") {
      bytes = docx;
    } else if (output.format === "pdf") {
      bytes = await timed("convert.duration", "pdf", () => convert(docx, "docx"));
    } else {
      bytes = await timed("convert.duration", output.format, () => convertTo!(docx, "docx", output.format));
    }
    telemetry.metric("render.duration", performance.now() - started, { outputFormat: output.format });
    sendBytes(
      response,
      200,
      { "content-type": MIME[output.format] ?? "application/octet-stream", "content-disposition": contentDisposition(output.name) },
      bytes
    );
  };

  const convertFile = async ({ params, files }: ParsedRequest, response: ServerResponse): Promise<void> => {
    const file = files.file;
    if (!file) {
      throw new HttpError(400, "Missing file", "The request must include a multipart file part");
    }
    const outputName = typeof params.outputName === "string" && params.outputName !== "" ? params.outputName : "output.pdf";
    const extension = extensionOf(file.filename) || "docx";
    const pdf = await timed("convert.duration", "pdf", () => convert(file.content, extension));
    sendBytes(response, 200, { "content-type": MIME.pdf as string, "content-disposition": contentDisposition(outputName) }, pdf);
  };

  const notSupported = (response: ServerResponse): void => {
    sendError(response, new HttpError(501, "not supported by dtsse-doc-render", "This Docmosis operation is not implemented by dtsse-doc-render"));
  };

  const converterIsReady = async (): Promise<boolean> => (ready ? await ready() : true);

  const status = async (response: ServerResponse): Promise<void> => {
    sendJson(response, 200, { ready: await converterIsReady(), service: "dtsse-doc-render", engine: "libreoffice" });
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (method === "GET" && (path === "/health" || path === "/health/liveness")) {
      sendJson(response, 200, { status: "UP" });
      return;
    }

    if (method === "GET" && path === "/openapi.yaml") {
      if (openapi === undefined) {
        sendJson(response, 404, { succeeded: false, shortMsg: "Not found", longMsg: "No OpenAPI document is configured" });
      } else {
        sendBytes(response, 200, { "content-type": "application/yaml; charset=utf-8" }, openapi);
      }
      return;
    }

    if (method === "GET" && path === "/health/readiness") {
      const up = await converterIsReady();
      sendJson(response, up ? 200 : 503, { status: up ? "UP" : "DOWN" });
      return;
    }

    const operation = /^\/(?:rs|api)\/([A-Za-z]+)$/.exec(path)?.[1];
    if (operation === "status") {
      await status(response);
      return;
    }
    if (operation === "ping") {
      sendBytes(response, 200, { "content-type": "text/plain" }, "pong");
      return;
    }
    const handlers: Record<string, (parsed: ParsedRequest, res: ServerResponse) => Promise<void> | void> = {
      render,
      convert: convertFile,
      getTemplateStructure: (_parsed, res) => notSupported(res),
      getSampleData: (_parsed, res) => notSupported(res)
    };
    const handle = operation && Object.hasOwn(handlers, operation) ? handlers[operation] : undefined;
    if (!handle) {
      sendJson(response, 404, { succeeded: false, shortMsg: "Not found", longMsg: `No such endpoint: ${method} ${path}` });
      return;
    }
    if (method !== "POST" && method !== "GET") {
      throw new HttpError(405, "Method not allowed", `${method} is not supported for ${path}`);
    }

    const parsed = method === "POST" ? await parseBody(request, limit) : { params: {}, files: {}, includeFiles: [] };
    await handle(parsed, response);
  };

  const record = (error: unknown): void => {
    if (error instanceof HttpError) {
      if (error.status === 413) {
        telemetry.event("limit.tripped", { type: "body" });
      } else if (error.shortMsg === "Too many includes") {
        telemetry.event("limit.tripped", { type: "includes" });
      }
    } else if (error instanceof Error && error.name === "ConversionBusyError") {
      telemetry.event("conversion.busy");
    } else if (error instanceof MergeError) {
      telemetry.event("merge.error", { kind: error.kind });
      if (error.limit) {
        telemetry.event("limit.tripped", { type: error.limit });
      }
    } else if (error instanceof ConversionError) {
      telemetry.event(error.timedOut ? "libreoffice.timeout" : "conversion.failed");
      telemetry.exception(error);
    } else {
      telemetry.exception(error instanceof Error ? error : new Error("non-error thrown"));
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = performance.now();
    const label = routeLabel(request.method ?? "GET", (request.url ?? "/").split("?")[0] ?? "/");
    response.on("close", () => telemetry.request(label, response.statusCode, performance.now() - started));
    try {
      await route(request, response);
    } catch (error) {
      record(error);
      if (error instanceof HttpError) {
        if (error.status === 413) {
          response.setHeader("connection", "close");
          response.on("finish", () => request.destroy());
        }
        sendError(response, error);
      } else if (error instanceof Error && error.name === "ConversionBusyError") {
        sendError(response, new HttpError(503, "Conversion queue is full", error.message, { "retry-after": "5" }));
      } else if (error instanceof MergeError) {
        sendError(response, new HttpError(400, error.details[0] ?? error.message, [error.message, ...error.details].join("\n")));
      } else if (error instanceof ConversionError) {
        sendError(response, new HttpError(500, "Conversion failed", error.message));
      } else {
        sendError(response, new HttpError(500, "Internal error", error instanceof Error ? error.message : String(error)));
      }
    }
  };
};
