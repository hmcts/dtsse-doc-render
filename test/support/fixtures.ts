import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { bytes, type RenderRequest, render, uploadTemplate } from "./client.ts";

const fixturesDir = new URL("../fixtures/", import.meta.url);

export interface Fixture {
  name: string;
  docx: Buffer;
  data: unknown;
  expected: string[];
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
      data: JSON.parse(readFileSync(new URL(`src/${name}/data.json`, fixturesDir), "utf8")),
      expected: readFileSync(new URL(`src/${name}/expected.txt`, fixturesDir), "utf8")
        .split("\n")
        .filter(Boolean)
    }));
}

export interface ErrorFixture {
  name: string;
  docx: Buffer;
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

export function uniqueTemplateName(name: string): string {
  return `${name}-${randomBytes(4).toString("hex")}.docx`;
}

export interface RenderOutcome {
  response: Response;
  body: Buffer;
  templateName: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uploads a template under a unique name and renders it, returning the first successful render or else the last failure.
 *
 * AAT runs two replicas with no shared template store, so the render that follows an upload can reach the pod that never
 * saw it and fail with "template does not exist". Each attempt therefore uploads again before rendering, so that sooner or
 * later both requests land on the same pod. A render that is wrong for any other reason fails the same way every attempt
 * and the last response is returned for the test to assert on.
 *
 * With expectFailure the render is meant to be rejected, so a rejection is the result unless it says the template is missing.
 */
export async function uploadAndRender(
  name: string,
  docx: Buffer,
  request: Omit<RenderRequest, "templateName">,
  { attempts = 5, expectFailure = false }: { attempts?: number; expectFailure?: boolean } = {}
): Promise<RenderOutcome> {
  const templateName = uniqueTemplateName(name);
  let outcome: RenderOutcome | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const upload = await uploadTemplate(templateName, docx);
    if (!upload.ok) {
      throw new Error(`upload of ${templateName} failed: ${upload.status} ${await upload.text()}`);
    }
    const response = await render({ ...request, templateName });
    outcome = { response, body: await bytes(response), templateName };
    if (response.ok || (expectFailure && !/does not exist/i.test(outcome.body.toString("utf8", 0, 2000)))) {
      return outcome;
    }
    await sleep(250);
  }
  return outcome!;
}
