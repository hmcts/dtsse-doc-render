import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import busboy from "busboy";
import { ConversionError, type OutputFormat } from "./convert.ts";
import { MergeError, type MergeOptions } from "./merge/index.ts";
import { InvalidTemplateName, type TemplateStore } from "./store.ts";

export const MAX_BODY_BYTES = 50 * 1024 * 1024;

const MIME: Record<OutputFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

export interface Dependencies {
  store: TemplateStore;
  merge: (template: Buffer, data: unknown, options: MergeOptions) => Promise<Buffer>;
  convert: (document: Buffer, sourceExtension: string) => Promise<Buffer>;
  accessKey?: string;
  ready?: () => Promise<boolean>;
  maxBodyBytes?: number;
}

interface UploadedFile {
  filename: string;
  content: Buffer;
}

interface ParsedRequest {
  params: Record<string, unknown>;
  files: Record<string, UploadedFile>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly shortMsg: string,
    readonly longMsg: string = shortMsg
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
  sendJson(response, error.status, { succeeded: false, shortMsg: error.shortMsg, longMsg: error.longMsg });
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

const parseMultipart = (body: Buffer, contentType: string): Promise<ParsedRequest> =>
  new Promise((resolve, reject) => {
    const parsed: ParsedRequest = { params: {}, files: {} };
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: { "content-type": contentType } });
    } catch (error) {
      reject(new HttpError(400, "Invalid multipart body", (error as Error).message));
      return;
    }
    parser.on("field", (name, value) => {
      parsed.params[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        parsed.files[name] = { filename: info.filename ?? "", content: Buffer.concat(chunks) };
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
    return parseMultipart(body, contentType);
  }
  if (body.length === 0) {
    return { params: {}, files: {} };
  }
  if (/^application\/x-www-form-urlencoded/i.test(contentType)) {
    return { params: Object.fromEntries(new URLSearchParams(body.toString("utf8"))), files: {} };
  }
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    return { params: value as Record<string, unknown>, files: {} };
  } catch (error) {
    throw new HttpError(400, "Invalid request body", `The request body is not valid JSON: ${(error as Error).message}`);
  }
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

const keyMatches = (expected: string, supplied: unknown): boolean => typeof supplied === "string" && timingSafeEqual(digest(expected), digest(supplied));

const isTrue = (value: unknown): boolean => value === true || (typeof value === "string" && value.toLowerCase() === "true");

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const requireString = (params: Record<string, unknown>, field: string): string => {
  const value = params[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing ${field}`, `The request must include a non-empty ${field}`);
  }
  return value;
};

const outputFormatOf = (params: Record<string, unknown>, outputName: string): OutputFormat => {
  const explicit = typeof params.outputFormat === "string" ? params.outputFormat.toLowerCase() : "";
  if (explicit && explicit !== "pdf" && explicit !== "docx") {
    throw new HttpError(400, "Unsupported outputFormat", `outputFormat must be pdf or docx, not ${params.outputFormat}`);
  }
  return (explicit || extensionOf(outputName)) === "docx" ? "docx" : "pdf";
};

const dataOf = (params: Record<string, unknown>): unknown => {
  const { data } = params;
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

const attachmentName = (name: string): string => name.replace(/["\\\r\n]/g, "_");

export const createHandler = (deps: Dependencies) => {
  const { store, merge, convert, accessKey, ready } = deps;
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  const render = async ({ params }: ParsedRequest, response: ServerResponse): Promise<void> => {
    const templateName = requireString(params, "templateName");
    const outputName = typeof params.outputName === "string" && params.outputName !== "" ? params.outputName : "output.pdf";
    const format = outputFormatOf(params, outputName);
    const data = dataOf(params);
    const template = await store.find(templateName);
    if (!template) {
      throw new HttpError(400, "Render failed: template does not exist", `The template '${templateName}' does not exist`);
    }
    const docx = await merge(template, data, { devMode: isTrue(params.devMode) });
    const output = format === "pdf" ? await convert(docx, "docx") : docx;
    sendBytes(response, 200, { "content-type": MIME[format], "content-disposition": `attachment; filename="${attachmentName(outputName)}"` }, output);
  };

  const convertFile = async ({ params, files }: ParsedRequest, response: ServerResponse): Promise<void> => {
    const file = files.file;
    if (!file) {
      throw new HttpError(400, "Missing file", "The request must include a multipart file part");
    }
    const outputName = typeof params.outputName === "string" && params.outputName !== "" ? params.outputName : "output.pdf";
    const pdf = await convert(file.content, extensionOf(file.filename) || "docx");
    sendBytes(response, 200, { "content-type": MIME.pdf, "content-disposition": `attachment; filename="${attachmentName(outputName)}"` }, pdf);
  };

  const listTemplates = async (response: ServerResponse): Promise<void> => {
    const names = await store.list();
    sendJson(response, 200, { succeeded: true, templateList: names.map((name) => ({ name })) });
  };

  const uploadTemplate = async ({ params, files }: ParsedRequest, response: ServerResponse): Promise<void> => {
    const file = files.file ?? files.templateFile;
    if (!file) {
      throw new HttpError(400, "Missing file", "The request must include a multipart file or templateFile part");
    }
    const templateName = typeof params.templateName === "string" && params.templateName !== "" ? params.templateName : file.filename;
    if (!templateName.toLowerCase().endsWith(".docx")) {
      throw new HttpError(400, "Unsupported template", "Only .docx templates can be uploaded");
    }
    await store.save(templateName, file.content);
    sendJson(response, 200, { succeeded: true, templateName });
  };

  const notSupported = (response: ServerResponse): void => {
    sendError(response, new HttpError(501, "not supported by dtsse-doc-render", "This Docmosis operation is not implemented by dtsse-doc-render"));
  };

  const status = async (response: ServerResponse): Promise<void> => {
    const converter = ready ? await ready() : true;
    sendJson(response, 200, { ready: converter, service: "dtsse-doc-render", engine: "libreoffice" });
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (method === "GET" && (path === "/health" || path === "/health/liveness")) {
      sendJson(response, 200, { status: "UP" });
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
      listTemplates: (_parsed, res) => listTemplates(res),
      uploadTemplate,
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

    const parsed = method === "POST" ? await parseBody(request, limit) : { params: {}, files: {} };
    if (accessKey && !keyMatches(accessKey, parsed.params.accessKey ?? url.searchParams.get("accessKey"))) {
      throw new HttpError(401, "Invalid access key", "The accessKey is missing or does not match");
    }
    await handle(parsed, response);
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      await route(request, response);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) {
          response.setHeader("connection", "close");
          response.on("finish", () => request.destroy());
        }
        sendError(response, error);
      } else if (error instanceof InvalidTemplateName) {
        sendError(response, new HttpError(400, "Invalid template name", error.message));
      } else if (error instanceof MergeError) {
        sendError(response, new HttpError(400, `Render failed: ${error.message}`, [error.message, ...error.details].join("\n")));
      } else if (error instanceof ConversionError) {
        sendError(response, new HttpError(500, "Conversion failed", error.message));
      } else {
        sendError(response, new HttpError(500, "Internal error", error instanceof Error ? error.message : String(error)));
      }
    }
  };
};
