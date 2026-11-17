import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { ConversionError, converterReady, convertTo, convertToPdf } from "./convert.ts";

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

describe.skipIf(!hasSoffice)("LibreOffice conversion", { timeout: 60_000 }, () => {
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
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not a docx")]);
    await expect(convertToPdf(corrupt, "docx")).rejects.toThrow(/conversion failed/i);
  });
});

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8Dwn4EBBAAT/gP9CSvmTwAAAABJRU5ErkJggg==", "base64");

const odt = (body: string, extra: Record<string, Uint8Array> = {}): Buffer =>
  Buffer.from(
    zipSync({
      mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
      "META-INF/manifest.xml": strToU8(
        '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
          Object.keys(extra)
            .map((name) => `<manifest:file-entry manifest:full-path="${name}" manifest:media-type="image/png"/>`)
            .join("") +
          "</manifest:manifest>"
      ),
      "content.xml": strToU8(
        `<?xml version="1.0"?><office:document-content ${ODF_NS} office:version="1.2"><office:body><office:text>${body}</office:text></office:body></office:document-content>`
      ),
      ...extra
    })
  );

const image = (href: string): string =>
  `<text:p>before<draw:frame text:anchor-type="as-char" svg:width="5cm" svg:height="2cm"><draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`;

const section = (href: string): string =>
  `<text:section text:name="S1"><text:section-source xlink:href="${href}" xlink:type="simple" text:filter-name="writer8" text:section-link-type="link"/><text:p>placeholder</text:p></text:section>`;

const docxWithLinkedImage = (target: string): Buffer =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/></Relationships>`
      ),
      "word/document.xml": strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>before</w:t></w:r><w:r><w:drawing><wp:inline><wp:extent cx="1800000" cy="900000"/><wp:docPr id="1" name="p"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>'
      )
    })
  );

const imageCount = (pdf: Buffer): number => pdf.toString("latin1").match(/\/Subtype\s*\/Image/g)?.length ?? 0;

describe.skipIf(!hasSoffice)("untrusted document content", { timeout: 60_000 }, () => {
  const requests: string[] = [];
  const secret = path.join(profiles, "secret.png");
  const secretText = path.join(profiles, "secret.odt");
  writeFileSync(secret, PNG);
  writeFileSync(secretText, odt('<text:section text:name="S"><text:p>TOPSECRET-MARKER-9917</text:p></text:section>'));
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  const listening = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  afterAll(() => {
    server.close();
  });

  it("still renders an embedded image (control for the checks below)", async () => {
    const pdf = await convertToPdf(odt(image("Pictures/p.png"), { "Pictures/p.png": new Uint8Array(PNG) }), "odt");
    expect(imageCount(pdf)).toBe(1);
  });

  it("does not load a linked image from a local file", async () => {
    const href = pathToFileURL(secret).href;
    expect(imageCount(await convertToPdf(odt(image(href)), "odt"))).toBe(0);
    expect(imageCount(await convertToPdf(docxWithLinkedImage(href), "docx"))).toBe(0);
  });

  it("does not request linked content over the network", async () => {
    const port = await listening;
    const base = `http://127.0.0.1:${port}`;
    await convertToPdf(odt(image(`${base}/odt-image.png`)), "odt");
    await convertToPdf(odt(section(`${base}/section.odt`)), "odt");
    await convertToPdf(docxWithLinkedImage(`${base}/docx-image.png`), "docx");
    expect(requests).toEqual([]);
  }, 60_000);

  it("does not pull a linked section from a local file into the output", async () => {
    for (const href of [`${pathToFileURL(secretText).href}#S%7Cregion`, "file:///etc/hostname"]) {
      const text = (await convertTo(odt(section(href)), "odt", "txt")).toString();
      expect(text).not.toContain("TOPSECRET-MARKER-9917");
      expect(text).toContain("placeholder");
    }
  });

  it("refuses flat XML documents even when renamed", async () => {
    const flat = Buffer.from(
      `<?xml version="1.0"?><office:document ${ODF_NS} office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><text:p>x</text:p></office:text></office:body></office:document>`
    );
    for (const extension of ["fodt", "xml", "html"]) {
      await expect(convertToPdf(flat, extension)).rejects.toBeInstanceOf(ConversionError);
    }
    await expect(convertToPdf(flat, "docx")).rejects.toBeInstanceOf(ConversionError);
  });

  it("converts to every target format", async () => {
    const source = Buffer.from("Hello target");
    for (const [target, check] of [
      ["pdf", (b: Buffer) => b.subarray(0, 4).toString() === "%PDF"],
      ["doc", (b: Buffer) => b[0] === 0xd0 && b[1] === 0xcf],
      ["odt", (b: Buffer) => b.subarray(0, 2).toString() === "PK"],
      ["html", (b: Buffer) => /<html/i.test(b.toString()) && b.toString().includes("Hello target")],
      ["txt", (b: Buffer) => b.toString().includes("Hello target")]
    ] as const) {
      expect(check(await convertTo(source, "txt", target)), target).toBe(true);
    }
  }, 120_000);
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
