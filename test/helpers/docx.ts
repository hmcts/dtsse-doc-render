import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { findDescendants, parseXml, textOf, type XEl } from "../../src/merge/xml.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const run = (text: string, rpr = ""): string => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

export const para = (...runs: string[]): string => `<w:p>${runs.map((r) => (r.startsWith("<w:") ? r : run(r))).join("")}</w:p>`;

export const cell = (...content: string[]): string => `<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/></w:tcPr>${content.join("")}</w:tc>`;

export const row = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`;

export const table = (...rows: string[]): string => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>${rows.join("")}</w:tbl>`;

export function makeDocx(body: string, extra: Record<string, string> = {}): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
    )
  };
  for (const [name, xml] of Object.entries(extra)) {
    files[name] = strToU8(xml);
  }
  return Buffer.from(zipSync(files));
}

export const header = (body: string): string => `<?xml version="1.0"?><w:hdr xmlns:w="${W}">${body}</w:hdr>`;

export function partXml(docx: Buffer, name = "word/document.xml"): string {
  return strFromU8(unzipSync(new Uint8Array(docx))[name]!);
}

export function entryNames(docx: Buffer): string[] {
  return Object.keys(unzipSync(new Uint8Array(docx)));
}

function paraText(p: XEl): string {
  let out = "";
  const walk = (el: XEl): void => {
    for (const c of el.children) {
      if (c.kind === "el") {
        if (c.name === "w:t") {
          out += textOf(c);
        } else if (c.name === "w:br") {
          out += "\n";
        } else if (c.name !== "w:p") {
          walk(c);
        }
      }
    }
  };
  walk(p);
  return out;
}

/** Every paragraph's text in document order, tables included. */
export function paragraphs(docx: Buffer, name = "word/document.xml"): string[] {
  return findDescendants(parseXml(partXml(docx, name)), "w:p").map(paraText);
}

/** Each table row as its cells' paragraph texts joined with " | ". */
export function rows(docx: Buffer): string[] {
  return findDescendants(parseXml(partXml(docx)), "w:tr").map((tr) =>
    findDescendants(tr, "w:tc")
      .map((tc) => findDescendants(tc, "w:p").map(paraText).join("/"))
      .join(" | ")
  );
}

/** Number of w:p elements directly in each table cell. */
export function cellParaCounts(docx: Buffer): number[] {
  return findDescendants(parseXml(partXml(docx)), "w:tc").map((tc) => tc.children.filter((c) => c.kind === "el" && c.name === "w:p").length);
}
