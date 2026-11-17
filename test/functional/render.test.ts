import { describe, expect, it } from "vitest";
import { accessKey, bytes, render } from "../support/client.ts";
import { docxText } from "../support/docx-text.ts";
import { fixtureDocx, loadFixtures, uniqueTemplateName, uploadAndRender } from "../support/fixtures.ts";
import { isPdf } from "../support/pdf.ts";

const failure = (outcome: { templateName: string; body: Buffer }) => `${outcome.templateName}: ${outcome.body.toString("utf8", 0, 800)}`;

describe.each(loadFixtures())("fixture $name", (fixture) => {
  it("merges to the expected text as docx", async () => {
    const outcome = await uploadAndRender(fixture.name, fixture.docx, { outputFormat: "docx", data: fixture.data });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    expect(docxText(outcome.body).join("\n")).toBe(fixture.expected.join("\n"));
  });

  it("renders to PDF", async () => {
    const outcome = await uploadAndRender(fixture.name, fixture.docx, { outputFormat: "pdf", data: fixture.data });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    expect(isPdf(outcome.body)).toBe(true);
  });
});

describe("errors", () => {
  it("answers 400 for a template that does not exist", async () => {
    const response = await render({ templateName: uniqueTemplateName("missing"), outputFormat: "pdf", data: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ succeeded: false, shortMsg: expect.stringMatching(/template does not exist/i) });
  });

  it("writes an unsupported instruction into the document in devMode", async () => {
    const outcome = await uploadAndRender("unsupported", fixtureDocx("_unsupported"), { outputFormat: "docx", devMode: true, data: {} });
    expect(outcome.response.status, failure(outcome)).toBe(200);
    const text = docxText(outcome.body).join("\n");
    expect(text).toContain("ERROR");
    expect(text).toContain("Before the instruction.");
  });

  it("rejects an unsupported instruction outside devMode", async () => {
    const outcome = await uploadAndRender("unsupported", fixtureDocx("_unsupported"), { outputFormat: "docx", devMode: false, data: {} }, 1);
    expect(outcome.response.status).toBe(400);
    expect(JSON.parse(outcome.body.toString("utf8"))).toMatchObject({ succeeded: false });
  });

  it.skipIf(!accessKey)("answers 401 for a wrong access key", async () => {
    const response = await render({ templateName: uniqueTemplateName("any"), outputFormat: "pdf", data: {}, accessKey: "not-the-key" });
    expect(response.status).toBe(401);
    expect((await bytes(response)).length).toBeGreaterThan(0);
  });
});
