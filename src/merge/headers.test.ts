import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { cell, makeDocx, para, paragraphs, partXml, row, table } from "../../test/helpers/docx.ts";
import { mergeDocx } from "./index.ts";

const FIRST_STYLE =
  '<w:headerReference w:type="first" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/><w:footerReference w:type="first" r:id="rId3"/><w:titlePg/>';
const sect = (inner = FIRST_STYLE): string => `<w:sectPr xmlns:r="r">${inner}</w:sectPr>`;

function withSections(body: string, last = sect()): Buffer {
  const files = unzipSync(new Uint8Array(makeDocx(body)));
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]!).replace("<w:sectPr/>", last));
  return Buffer.from(zipSync(files));
}

const sectPrs = (docx: Buffer): string[] => [...partXml(docx).matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)].map((m) => m[0]);
const refs = (s: string): string[] => [...s.matchAll(/<w:(?:header|footer)Reference w:type="(\w+)"/g)].map((m) => m[1]!);
const hasFirstStyle = (s: string): boolean => refs(s).includes("first") || s.includes("w:titlePg");
const render = (body: string, data: unknown = { x: true }, last?: string): Promise<Buffer> => mergeDocx(withSections(body, last), data, { devMode: false });

describe("first-page header and footer", () => {
  const dropped: [string, string][] = [
    ["a block start tag", para("<<cs_x>>") + para("in") + para("<<es_>>") + para("text")],
    ["a block start tag with spaces around it", para(" <<cs_x>> ") + para("in") + para("<<es_>>")],
    ["a repeat start tag", para("<<rs_items>>") + para("in") + para("<<es_>>")],
    ["a comment", para("<</* c */>>") + para("text")],
    ["a heading comment", para("<<## 1.1 Heading ##>>") + para("text")],
    ["a table whose first row starts a row block", table(row(cell(para("<<cr_x>>a"))), row(cell(para("b<<er_>>")))) + para("text")]
  ];

  it.each(dropped)("is dropped when the first element is %s, which the merge removes", async (_name, body) => {
    const out = await render(body, { x: true, items: [1] });
    expect(sectPrs(out)).toHaveLength(1);
    expect(refs(sectPrs(out)[0]!)).toEqual(["default"]);
    expect(sectPrs(out)[0]).not.toContain("titlePg");
  });

  const kept: [string, string][] = [
    ["text", para("A") + para("<<cs_x>>") + para("in") + para("<<es_>>")],
    ["a block that starts in a paragraph with text", para("<<cs_x>>Hello") + para("more<<es_>>")],
    ["a block inside one paragraph", para("<<cs_x>>in<<es_>>") + para("text")],
    ["an assignment", para("<<$a=1>>") + para("<<cs_x>>") + para("in") + para("<<es_>>")],
    ["a field", para("<<x>>") + para("text")],
    ["an empty paragraph", para("") + para("<<cs_x>>") + para("in") + para("<<es_>>")],
    ["a plain table", table(row(cell(para("a")))) + para("text")],
    ["a table with an inline block", table(row(cell(para("<<cs_x>>a<<es_>>")))) + para("text")],
    ["a picture", `<w:p><w:r><w:drawing/></w:r><w:r><w:t>&lt;&lt;## c ##&gt;&gt;</w:t></w:r></w:p>${para("text")}`],
    ["nothing", ""]
  ];

  it.each(kept)("is kept when the first element is %s", async (_name, body) => {
    const out = await render(body);
    expect(refs(sectPrs(out)[0]!)).toEqual(["first", "default", "first"]);
    expect(sectPrs(out)[0]).toContain("titlePg");
  });

  it("is judged for each section on its own first element", async () => {
    const section = (inner: string): string => `<w:p><w:pPr>${sect(inner)}</w:pPr></w:p>`;
    const body = para("<<cs_x>>") + para("in") + para("<<es_>>") + para("A") + section(FIRST_STYLE) + para("B") + para("<<cs_x>>") + para("<<es_>>");
    const out = await render(body);
    const [one, two] = sectPrs(out);
    expect(hasFirstStyle(one!)).toBe(false);
    expect(hasFirstStyle(two!)).toBe(true);
    const second = await render(para("A") + section(FIRST_STYLE) + para("<<cs_x>>") + para("in") + para("<<es_>>") + para("B"));
    const [a, b] = sectPrs(second);
    expect(hasFirstStyle(a!)).toBe(true);
    expect(hasFirstStyle(b!)).toBe(false);
  });

  it("is kept for a section that ends with a section break in its first paragraph, or has no content", async () => {
    const out = await render(`<w:p><w:pPr>${sect()}</w:pPr></w:p>${para("<<cs_x>>")}${para("<<es_>>")}`, { x: true }, sect());
    expect(sectPrs(out).map(hasFirstStyle)).toEqual([true, false]);
    const empty = await render("", {}, sect());
    expect(hasFirstStyle(sectPrs(empty)[0]!)).toBe(true);
  });

  it("leaves a document with no first-page style, and a header part, alone", async () => {
    const out = await render(para("<<cs_x>>") + para("in") + para("<<es_>>"), { x: true }, sect('<w:footerReference w:type="default" r:id="rId2"/>'));
    expect(refs(sectPrs(out)[0]!)).toEqual(["default"]);
    expect(paragraphs(out)).toEqual(["in"]);
    const files = unzipSync(new Uint8Array(withSections(para("a"))));
    files["word/header1.xml"] = strToU8(
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>H</w:t></w:r></w:p></w:hdr>'
    );
    const merged = await mergeDocx(Buffer.from(zipSync(files)), {}, { devMode: false });
    expect(paragraphs(merged, "word/header1.xml")).toEqual(["H"]);
  });

  it("is left alone when the section count changes during the merge", async () => {
    const section = `<w:p><w:pPr>${sect()}</w:pPr></w:p>`;
    const out = await render(para("<<rs_items>>") + section + para("<<es_>>"), { items: [1, 2] });
    expect(sectPrs(out).length).toBeGreaterThan(1);
  });
});
