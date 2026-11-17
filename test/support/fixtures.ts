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

/** The merge fixtures. Directories starting with "_" are helpers for specific tests and have no expected.txt. */
export function loadFixtures(): Fixture[] {
  return readdirSync(new URL("src/", fixturesDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      docx: fixtureDocx(name),
      data: JSON.parse(readFileSync(new URL(`src/${name}/data.json`, fixturesDir), "utf8")),
      expected: readFileSync(new URL(`src/${name}/expected.txt`, fixturesDir), "utf8")
        .split("\n")
        .filter(Boolean)
    }));
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
 */
export async function uploadAndRender(name: string, docx: Buffer, request: Omit<RenderRequest, "templateName">, attempts = 5): Promise<RenderOutcome> {
  const templateName = uniqueTemplateName(name);
  let outcome: RenderOutcome | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const upload = await uploadTemplate(templateName, docx);
    if (!upload.ok) {
      throw new Error(`upload of ${templateName} failed: ${upload.status} ${await upload.text()}`);
    }
    const response = await render({ ...request, templateName });
    outcome = { response, body: await bytes(response), templateName };
    if (response.ok) {
      return outcome;
    }
    await sleep(250);
  }
  return outcome!;
}
