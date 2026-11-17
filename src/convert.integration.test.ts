import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { converterReady, convertToPdf } from "./convert.ts";

const hasSoffice = (() => {
  try {
    execFileSync(process.env.SOFFICE_BIN || "soffice", ["--version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

const profiles = mkdtempSync(path.join(os.tmpdir(), "lo-profiles-"));
process.env.SOFFICE_PROFILE_DIR = profiles;
afterAll(() => rmSync(profiles, { recursive: true, force: true }));

describe.skipIf(!hasSoffice)("LibreOffice conversion", () => {
  it("reports ready", async () => {
    expect(await converterReady()).toBe(true);
  });

  it("converts text to a PDF", async () => {
    const pdf = await convertToPdf(Buffer.from("hello world"), "txt");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("converts concurrent documents through the pool", async () => {
    const pdfs = await Promise.all(["one", "two", "three"].map((text) => convertToPdf(Buffer.from(text), "txt")));
    for (const pdf of pdfs) {
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 120_000);

  it("fails with a ConversionError on an unreadable document", async () => {
    await expect(convertToPdf(Buffer.from("not a docx"), "docx")).rejects.toThrow(/conversion failed/i);
  });
});

describe("converter failure modes", () => {
  it("is not ready when the binary is missing", async () => {
    const saved = process.env.SOFFICE_BIN;
    process.env.SOFFICE_BIN = path.join(profiles, "no-such-soffice");
    try {
      await expect(convertToPdf(Buffer.from("x"), "txt")).rejects.toThrow(/could not start/i);
    } finally {
      if (saved === undefined) {
        delete process.env.SOFFICE_BIN;
      } else {
        process.env.SOFFICE_BIN = saved;
      }
    }
  });

  it("kills a conversion that exceeds the timeout", async () => {
    const script = path.join(profiles, "slow-soffice");
    writeFileSync(script, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    process.env.SOFFICE_BIN = script;
    process.env.SOFFICE_TIMEOUT_MS = "300";
    try {
      expect(readFileSync(script, "utf8")).toContain("sleep");
      await expect(convertToPdf(Buffer.from("x"), "txt")).rejects.toThrow(/timed out/i);
    } finally {
      delete process.env.SOFFICE_BIN;
      delete process.env.SOFFICE_TIMEOUT_MS;
    }
  });
});
