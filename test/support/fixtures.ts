import { existsSync, readdirSync, readFileSync } from "node:fs";
import { bytes, type RenderRequest, render } from "./client.ts";

const fixturesDir = new URL("../fixtures/", import.meta.url);

export interface Fixture {
  name: string;
  docx: Buffer;
  data: unknown;
  expected: string[];
  /** The templates this one includes, by the name its ref: tags use. */
  includes: Record<string, Buffer>;
}

/** The templates a fixture includes, built from test/fixtures/src/<name>/includes/. */
export function fixtureIncludes(name: string): Record<string, Buffer> {
  const dir = new URL(`${name}.includes/`, fixturesDir);
  return existsSync(dir) ? Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(new URL(file, dir))])) : {};
}

export function fixtureDocx(name: string): Buffer {
  return readFileSync(new URL(`${name}.docx`, fixturesDir));
}

/** The merge fixtures. Directories starting with "_" are the error fixtures, see loadErrorFixtures. */
export function loadFixtures(): Fixture[] {
  return fixtureDirs()
    .filter((name) => !name.startsWith("_"))
    .map((name) => ({
      name,
      docx: fixtureDocx(name),
      includes: fixtureIncludes(name),
      data: JSON.parse(readFileSync(new URL(`src/${name}/data.json`, fixturesDir), "utf8")),
      expected: readFileSync(new URL(`src/${name}/expected.txt`, fixturesDir), "utf8")
        .split("\n")
        .filter(Boolean)
    }));
}

export interface ErrorFixture {
  name: string;
  docx: Buffer;
  includes: Record<string, Buffer>;
  data: unknown;
  /** The phrase a rejection's message must contain, matched case-insensitively. Docmosis's own message contains it. */
  phrase: string;
  /** The document text Docmosis produces with devMode on, where each error is written in place of the instruction. */
  devModeExpected: string[];
}

/** The "_" fixtures, which Docmosis rejects. error-phrase.txt is hand-written, expected-devmode.txt is captured from Docmosis. */
export function loadErrorFixtures(): ErrorFixture[] {
  return fixtureDirs()
    .filter((name) => name.startsWith("_"))
    .map((name) => ({
      name,
      docx: fixtureDocx(name),
      includes: fixtureIncludes(name),
      data: JSON.parse(readFileSync(new URL(`src/${name}/data.json`, fixturesDir), "utf8")),
      phrase: readFileSync(new URL(`src/${name}/error-phrase.txt`, fixturesDir), "utf8").trim(),
      devModeExpected: readFileSync(new URL(`src/${name}/expected-devmode.txt`, fixturesDir), "utf8")
        .split("\n")
        .filter(Boolean)
    }));
}

function fixtureDirs(): string[] {
  return readdirSync(new URL("src/", fixturesDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface RenderOutcome {
  response: Response;
  body: Buffer;
}

/** Renders a template sent inline and returns the response with its body read. */
export async function renderInline(docx: Buffer, request: Omit<RenderRequest, "template">): Promise<RenderOutcome> {
  const response = await render({ ...request, template: docx });
  return { response, body: await bytes(response) };
}
