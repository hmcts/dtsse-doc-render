import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHandler, ROUTES } from "./app.ts";

const spec = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const lines = spec.split("\n");

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** The direct children of the mapping that starts at `header` (a line such as `paths:`), with their line numbers. */
const children = (from: number, indent: number): Array<{ key: string; line: number }> => {
  const found: Array<{ key: string; line: number }> = [];
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const depth = line.length - line.trimStart().length;
    if (depth < indent) {
      break;
    }
    const key = depth === indent ? /^\s*"?([^":]+|[^"]+)"?:/.exec(line)?.[1] : undefined;
    if (key !== undefined) {
      found.push({ key: key.trim(), line: i });
    }
  }
  return found;
};

const topLevel = (name: string): number => {
  const line = lines.indexOf(`${name}:`);
  expect(line, `${name} is missing from openapi.yaml`).toBeGreaterThanOrEqual(0);
  return line;
};

const methodsOf = (line: number, indent: number): string[] =>
  children(line, indent)
    .map((child) => child.key)
    .filter((key) => METHODS.includes(key));

const documented = (): string[] => {
  const pathItems = new Map(children(lines.indexOf("  pathItems:"), 4).map((item) => [item.key, methodsOf(item.line, 6)]));
  return children(topLevel("paths"), 2).flatMap(({ key: path, line }) => {
    const ref = /\$ref:\s*["']#\/components\/pathItems\/(\w+)["']/.exec(lines[line + 1] as string)?.[1];
    const methods = ref ? (pathItems.get(ref) ?? []) : methodsOf(line, 4);
    expect(methods, `${path} documents no methods`).not.toHaveLength(0);
    return methods.map((method) => `${method.toUpperCase()} ${path}`);
  });
};

describe("openapi.yaml", () => {
  const routes = ROUTES.map(({ method, path }) => `${method} ${path}`).sort();

  it("documents every route the service answers", () => {
    expect(documented().sort()).toEqual(routes);
  });

  it("is OpenAPI 3.1", () => {
    expect(spec).toMatch(/^openapi: 3\.1\.\d+$/m);
  });

  it("documents the status codes the handler returns", () => {
    for (const status of ["400", "405", "413", "501", "503"]) {
      expect(spec, `status ${status}`).toContain(`"${status}":`);
    }
    expect(spec).toContain("Retry-After:");
  });

  it("names every request field the handler reads", () => {
    for (const field of ["templateBase64", "includes", "outputName", "outputFormat", "devMode", "data", "accessKey", "templateFile", "include", "file"]) {
      expect(spec, field).toMatch(new RegExp(`^\\s+${field}:`, "m"));
    }
  });

  describe("served", () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    });

    it("at GET /openapi.yaml, as YAML", async () => {
      server = createServer(
        (request, response) =>
          void createHandler({ merge: async () => Buffer.alloc(0), convert: async () => Buffer.alloc(0), openapi: spec })(request, response)
      );
      await new Promise<void>((resolve) => server?.listen(0, resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.yaml`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/yaml/);
      expect(await response.text()).toBe(spec);
    });

    it("answers 404 when no document is configured", async () => {
      server = createServer(
        (request, response) => void createHandler({ merge: async () => Buffer.alloc(0), convert: async () => Buffer.alloc(0) })(request, response)
      );
      await new Promise<void>((resolve) => server?.listen(0, resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.yaml`);
      expect(response.status).toBe(404);
    });
  });
});
