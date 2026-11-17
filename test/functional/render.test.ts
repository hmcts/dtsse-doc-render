import { describe, expect, it } from "vitest";
import { baseUrl, bytes, render } from "../support/client.ts";
import { docxText } from "../support/docx-text.ts";
import { loadErrorFixtures, loadFixtures, renderInline } from "../support/fixtures.ts";
import { isPdf } from "../support/pdf.ts";

const failure = (outcome: { body: Buffer }) => outcome.body.toString("utf8", 0, 800);

describe.each(loadFixtures())("fixture $name", (fixture) => {
  it("merges to the expected text as docx", async () => {
    const outcome = await renderInline(fixture.docx, { outputFormat: "docx", data: fixture.data, includes: fixture.includes });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    expect(docxText(outcome.body).join("\n")).toBe(fixture.expected.join("\n"));
  });

  it("renders to PDF", async () => {
    const outcome = await renderInline(fixture.docx, { outputFormat: "pdf", data: fixture.data, includes: fixture.includes });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    expect(isPdf(outcome.body)).toBe(true);
  });
});

describe.each(loadErrorFixtures())("error fixture $name", (fixture) => {
  it("rejects the template with Docmosis's message outside devMode", async () => {
    const outcome = await renderInline(fixture.docx, { outputFormat: "docx", devMode: false, data: fixture.data, includes: fixture.includes });
    expect(outcome.response.status, failure(outcome)).toBe(400);
    const body = JSON.parse(outcome.body.toString("utf8"));
    expect(body.succeeded).toBe(false);
    expect(`${body.shortMsg} ${body.longMsg ?? ""}`.toLowerCase()).toContain(fixture.phrase.toLowerCase());
  });

  it("writes the error into the document in devMode", async () => {
    const outcome = await renderInline(fixture.docx, { outputFormat: "docx", devMode: true, data: fixture.data, includes: fixture.includes });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    const lines = docxText(outcome.body);
    expect(lines.join("\n")).toMatch(/Docmosis\d+/);
    for (const kept of fixture.devModeExpected.filter((line) => !/Docmosis\d+/.test(line))) {
      expect(lines).toContain(kept);
    }
  });
});

describe("errors", () => {
  it("answers 400 for a render that names a template without sending it", async () => {
    const response = await fetch(`${baseUrl}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateName: "Missing.docx", outputName: "out.pdf", data: {} })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ succeeded: false, shortMsg: expect.stringMatching(/templateBase64 or templateFile/) });
  });

  it("ignores the accessKey clients send", async () => {
    const response = await render({ template: loadFixtures()[0]!.docx, outputFormat: "docx", data: loadFixtures()[0]!.data, ...{ accessKey: "anything" } });
    expect(response.status).toBe(200);
    expect((await bytes(response)).length).toBeGreaterThan(0);
  });
});
