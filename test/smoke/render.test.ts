import { describe, expect, it } from "vitest";
import { bytes, convert, status } from "../support/client.ts";
import { fixtureDocx, uploadAndRender } from "../support/fixtures.ts";
import { isPdf } from "../support/pdf.ts";

describe("smoke: render and convert", () => {
  it("is ready", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
  });

  it("uploads a template and renders it to PDF", async () => {
    const { response, body, templateName } = await uploadAndRender("smoke", fixtureDocx("01-plain-fields"), {
      outputFormat: "pdf",
      data: {
        court: { name: "County Court Money Claims Centre" },
        claimNumber: "K1AB2345",
        claimant: { name: "Ms Jane Smith", address: { line1: "1 High Street", town: "Leeds", postcode: "LS1 1AA" } },
        defendants: [{ name: "Acme Ltd" }, { name: "Mr Bob Jones" }],
        claim: { amount: 1500 }
      }
    });
    expect(response.status, `${templateName}: ${body.toString("utf8", 0, 500)}`).toBe(200);
    expect(isPdf(body)).toBe(true);
  });

  it("converts a docx to PDF", async () => {
    const response = await convert(fixtureDocx("01-plain-fields"));
    const body = await bytes(response);
    expect(response.status, body.toString("utf8", 0, 500)).toBe(200);
    expect(isPdf(body)).toBe(true);
  });
});
