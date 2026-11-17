import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { docxText } from "../support/docx-text.ts";

export { docxText };

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = resolve(here, "../fixtures");
export const srcDir = join(fixturesDir, "src");

const docmosisContainer = process.env.DOCMOSIS_CONTAINER || "docmosis-local";
export const docmosisUrl = (process.env.DOCMOSIS_URL || "http://127.0.0.1:18087").replace(/\/$/, "");
export const rendererUrl = (process.env.DR_URL || "http://127.0.0.1:18099").replace(/\/$/, "");

let cachedDocmosisKey;
function docmosisKey() {
  cachedDocmosisKey ??=
    process.env.DOCMOSIS_ACCESS_KEY || execFileSync("docker", ["exec", docmosisContainer, "printenv", "DOCMOSIS_ACCESSKEY"]).toString().trim();
  return cachedDocmosisKey;
}

export function fixtureNames() {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function fixtureData(name) {
  return JSON.parse(readFileSync(join(srcDir, name, "data.json"), "utf8"));
}

/** The templates a fixture includes, by the name its ref: tags use, from test/fixtures/<name>.includes/. */
export function fixtureIncludes(name) {
  const dir = join(fixturesDir, `${name}.includes`);
  return existsSync(dir) ? Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file))])) : {};
}

export function fixtureDocx(name) {
  return readFileSync(join(fixturesDir, `${name}.docx`));
}

const uniqueName = (label) => `par_${basename(label).replace(/[^\w-]/g, "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.docx`;

/** The result of a render: ok with the output bytes, or not ok with Docmosis's JSON error. */
async function post(url, body) {
  const response = await fetch(`${url}/api/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const ok = response.ok && (buffer.subarray(0, 2).toString() === "PK" || buffer.subarray(0, 4).toString() === "%PDF");
  let error;
  if (!ok) {
    try {
      error = JSON.parse(buffer.toString("utf8"));
    } catch {
      error = { shortMsg: buffer.toString("utf8", 0, 500) };
    }
  }
  return { ok, status: response.status, buffer, error };
}

/**
 * Copies included templates into the container under the names the template's ref: tags use. A ref: names a template in
 * Docmosis's store, so unlike the template itself they cannot take a unique name: give them names no other fixture uses.
 */
function storeIncludes(includes) {
  const dir = mkdtempSync(join(tmpdir(), "parity-includes-"));
  for (const [name, content] of Object.entries(includes)) {
    const file = join(dir, name);
    writeFileSync(file, content);
    execFileSync("docker", ["cp", file, `${docmosisContainer}:/home/docmosis/templates/${name}`]);
  }
}

/** Renders a template file on the licensed Docmosis. Templates are copied into the container under a unique name because Docmosis caches by mtime. */
export async function renderOnDocmosis(docx, data, { format = "docx", devMode = false, label = "t", includes = {} } = {}) {
  storeIncludes(includes);
  const templateName = uniqueName(label);
  const file = typeof docx === "string" ? docx : null;
  if (!file) {
    throw new Error("renderOnDocmosis takes a path to a .docx");
  }
  execFileSync("docker", ["cp", resolve(file), `${docmosisContainer}:/home/docmosis/templates/${templateName}`]);
  return post(docmosisUrl, {
    accessKey: docmosisKey(),
    templateName,
    outputName: `out.${format}`,
    outputFormat: format,
    devMode,
    data
  });
}

/** Renders a template file on a dtsse-doc-render instance, sending the template inline. */
export async function renderOnRenderer(docx, data, { format = "docx", devMode = false, includes = {} } = {}) {
  return post(rendererUrl, {
    templateBase64: readFileSync(docx).toString("base64"),
    includes: Object.fromEntries(Object.entries(includes).map(([name, content]) => [name, content.toString("base64")])),
    outputName: `out.${format}`,
    outputFormat: format,
    devMode,
    data
  });
}

/** The text lines of a render result, or one "FAIL: ..." line describing the error. */
export function outcomeLines(result) {
  return result.ok ? docxText(result.buffer) : [`FAIL: ${result.error?.shortMsg ?? result.status} ${result.error?.longMsg ?? ""}`.trim()];
}

export function hasFile(path) {
  return existsSync(path);
}
