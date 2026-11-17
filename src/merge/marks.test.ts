import { describe, expect, it } from "vitest";
import { makeDocx, partXml } from "../../test/helpers/docx.ts";
import { mergeDocx } from "./index.ts";

const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>';
const run = (text: string, props = "", attrs = ""): string => `<w:r${attrs}><w:rPr>${FONT}${props}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (mark: string | null, ...runs: string[]): string =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>${mark === null ? "" : `<w:rPr>${mark}</w:rPr>`}</w:pPr>${runs.join("")}</w:p>`;

async function mark(body: string): Promise<string> {
  const out = partXml(await mergeDocx(makeDocx(body), {}, { devMode: false }));
  return /<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:rPr>([\s\S]*?)<\/w:rPr><\/w:pPr>/.exec(out)?.[1] ?? "(none)";
}

describe("paragraph mark formatting", () => {
  it("keeps the mark of a paragraph whose runs all look alike", async () => {
    expect(await mark(para(FONT, run("a"), run("b")))).toBe(FONT);
  });

  it("empties the mark when the runs differ, as Docmosis does, so a numbered label loses the paragraph's font", async () => {
    expect(await mark(para(FONT, run("a", "<w:b/>"), run("b")))).toBe("");
    expect(await mark(para(FONT, run("a"), run("b", "<w:b/>")))).toBe("");
    expect(await mark(para(FONT, run("a", "<w:b/>"), run("b", "<w:b/>"), run("c")))).toBe("");
    expect(await mark(para("", run("a", "<w:b/>"), run("b")))).toBe("");
  });

  it("gives the mark the formatting of a single stretch of text, keeping what the mark already says", async () => {
    expect(await mark(para(FONT, run("a", "<w:b/><w:i/>")))).toBe(`${FONT}<w:b/><w:i/>`);
    expect(await mark(para("", run("a", "<w:b/>")))).toBe(`${FONT}<w:b/>`);
    expect(await mark(para(FONT, run("a", "<w:b/>"), run("b", "<w:b/>")))).toBe(`${FONT}<w:b/>`);
    const courier = '<w:rFonts w:ascii="Courier New"/>';
    expect(await mark(para(courier, run("a")))).toBe(courier);
    expect(await mark(para(`${FONT}<w:b/>`, run("a")))).toBe(`${FONT}<w:b/>`);
  });

  it("writes the properties it adds in schema order", async () => {
    expect(await mark(para('<w:sz w:val="24"/>', run("a", "<w:b/>")))).toBe(`${FONT}<w:b/><w:sz w:val="24"/>`);
  });

  it("treats runs that differ only by revision ids, empty runs and proof marks as one stretch of text", async () => {
    const empty = `<w:r><w:rPr>${FONT}</w:rPr></w:r>`;
    const proof = '<w:proofErr w:type="spellStart"/>';
    expect(await mark(para(FONT, run("a", "", ' w:rsidR="00AA"'), proof, run("b", "", ' w:rsidR="00BB"')))).toBe(FONT);
    expect(await mark(para(FONT, empty, run("a", "<w:b/>")))).toBe(`${FONT}<w:b/>`);
  });

  it("counts a tab or a break as text, and runs inside a hyperlink", async () => {
    const tab = `<w:r><w:rPr>${FONT}</w:rPr><w:tab/></w:r>`;
    expect(await mark(para(FONT, tab, run("a", "<w:b/>")))).toBe("");
    expect(await mark(para(FONT, run("a"), `<w:hyperlink w:anchor="x">${run("b", "<w:b/>")}</w:hyperlink>`))).toBe("");
  });

  it("leaves a paragraph with no text, no mark and a tracked mark alone", async () => {
    expect(await mark(para(FONT))).toBe(FONT);
    expect(await mark(para(null, run("a", "<w:b/>")))).toBe("(none)");
    const tracked = '<w:ins w:id="1" w:author="a"/>';
    expect(await mark(para(tracked, run("a"), run("b", "<w:b/>")))).toBe(tracked);
  });

  it("takes no formatting from a character style", async () => {
    expect(await mark(para(FONT, run("a", '<w:rStyle w:val="Strong"/>')))).toBe(FONT);
  });
});
