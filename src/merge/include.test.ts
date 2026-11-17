import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { cell, entryNames, header, makeDocx, para, paragraphs, partXml, row, run, table } from "../../test/helpers/docx.ts";
import { type MergeError, type MergeOptions, mergeDocx } from "./index.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

const incl = (docx: Buffer): Record<string, Buffer> => ({ "inc.docx": docx });
const merge = (
  body: string,
  includes: Record<string, Buffer>,
  data: unknown = {},
  options: Partial<MergeOptions> = {},
  extra: Record<string, string> = {}
): Promise<Buffer> => mergeDocx(makeDocx(body, extra), data, { devMode: false, includes, ...options });
const texts = async (body: string, includes: Record<string, Buffer>, data: unknown = {}, options: Partial<MergeOptions> = {}): Promise<string[]> =>
  paragraphs(await merge(body, includes, data, options))
    .map((line) => line.trim())
    .filter(Boolean);
const failure = async (body: string, includes: Record<string, Buffer>, data: unknown = {}): Promise<string> => {
  try {
    await merge(body, includes, data);
  } catch (e) {
    return [(e as MergeError).message, ...(e as MergeError).details].join("\n");
  }
  throw new Error("the merge succeeded");
};
const files = (docx: Buffer): Record<string, string> => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(docx))).map(([k, v]) => [k, strFromU8(v)]));

const REF = (name = "inc.docx") => para(`<<ref:${name}>>`);

describe("Docmosis: ref:name merges the named template in place of the tag, with the data scope the tag is in", () => {
  it("replaces a paragraph that holds only the tag with the paragraphs of the include", async () => {
    expect(await texts(para("A") + REF() + para("B"), incl(makeDocx(para("I1 <<x>>") + para("I2"))), { x: "X1" })).toEqual(["A", "I1 X1", "I2", "B"]);
  });

  it("is replaced by nothing when the include is empty", async () => {
    expect(await texts(para("A") + REF() + para("B"), incl(makeDocx("")))).toEqual(["A", "B"]);
    expect(await texts(para("A") + REF() + para("B"), incl(makeDocx("<w:p/>")))).toEqual(["A", "B"]);
  });

  it("runs the first included paragraph on from the text before the tag and the last on into the text after it", async () => {
    expect(await texts(para("A <<ref:inc.docx>> B"), incl(makeDocx(para("I1") + para("I2") + para("I3"))))).toEqual(["A I1", "I2", "I3 B"]);
    expect(await texts(para("A <<ref:inc.docx>> B"), incl(makeDocx(para("INC"))))).toEqual(["A INC B"]);
    expect(await texts(para("A <<ref:inc.docx>>"), incl(makeDocx(para("I1") + para("I2"))))).toEqual(["A I1", "I2"]);
  });

  it("keeps the paragraph properties of the host for the first included paragraph and of the include for the rest", async () => {
    const host = `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run("A <<ref:inc.docx>> B")}</w:p>`;
    const inc = makeDocx(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("I1")}</w:p><w:p><w:pPr><w:jc w:val="left"/></w:pPr>${run("I2")}</w:p>`);
    const xml = partXml(await merge(host, incl(inc)));
    expect(xml).toMatch(/<w:jc w:val="right"\/><\/w:pPr><w:r><w:t[^>]*>A <\/w:t><\/w:r><w:r><w:t[^>]*>I1<\/w:t>/);
    expect(xml).toMatch(/<w:jc w:val="left"\/><\/w:pPr><w:r><w:t[^>]*>I2<\/w:t><\/w:r><w:r><w:t[^>]*> B<\/w:t>/);
  });

  it("puts an include that ends in a table before the text after the tag", async () => {
    const inc = makeDocx(table(row(cell(para("c1")), cell(para("c2")))));
    expect(await texts(para("A <<ref:inc.docx>> B"), incl(inc))).toEqual(["A", "c1", "c2", "B"]);
    expect(await texts(para("A") + REF() + para("B"), incl(inc))).toEqual(["A", "c1", "c2", "B"]);
  });

  it("runs consecutive tags in one paragraph on from each other", async () => {
    const includes = { "inc.docx": makeDocx(para("I1") + para("I2")), "inc2.docx": makeDocx(para("J1") + para("J2")) };
    expect(await texts(para("<<ref:inc.docx>><<ref:inc2.docx>>"), includes)).toEqual(["I1", "I2J1", "J2"]);
  });

  it("works in a table cell, in a repeat with the item as the scope, and in a condition", async () => {
    const inc = incl(makeDocx(para("I <<v>>")));
    expect(await texts(table(row(cell(REF()), cell(para("z")))), inc)).toEqual(["I", "z"]);
    expect(await texts(para("<<rs_l>>") + REF() + para("<<es_>>"), inc, { l: [{ v: "a" }, { v: "b" }] })).toEqual(["I a", "I b"]);
    expect(await texts(para("<<cs_b>>") + REF() + para("<<es_>>"), inc, { b: true, v: "t" })).toEqual(["I t"]);
    expect(await texts(para("<<cs_b>>") + REF() + para("<<es_>>") + para("ok"), inc, { b: false })).toEqual(["ok"]);
  });

  it("can follow the end tag of a block in the same paragraph", async () => {
    const inc = incl(makeDocx(para("I1") + para("I2")));
    expect(await texts(para("<<cs_b>>") + para("T") + para("<<es_>><<ref:inc.docx>>") + para("after"), inc, { b: true })).toEqual(["T", "I1", "I2", "after"]);
    expect(await texts(para("<<cs_b>>") + para("T") + para("<<es_>><<ref:inc.docx>>") + para("after"), inc, { b: false })).toEqual(["I1", "I2", "after"]);
  });

  it("shares variables in both directions", async () => {
    const inc = incl(makeDocx(para("I <<$q>>") + para("<<$r={'fromInc'}>>")));
    expect(await texts(para("<<$q=n>>") + REF() + para("<<$q>> <<$r>>"), inc, { n: 5 })).toEqual(["I 5", "5 fromInc"]);
  });

  it("includes an include, once for each tag", async () => {
    const includes = { "outer.docx": makeDocx(para("M") + para("<<ref:inner.docx>>")), "inner.docx": makeDocx(para("I <<x>>")) };
    expect(await texts(para("A") + REF("outer.docx") + REF("inner.docx"), includes, { x: "X" })).toEqual(["A", "M", "I X", "I X"]);
  });

  it("works in a header", async () => {
    const out = await merge(para("body"), incl(makeDocx(para("I1") + para("I2"))), {}, {}, { "word/header1.xml": header(para("H <<ref:inc.docx>>")) });
    expect(paragraphs(out, "word/header1.xml")).toEqual(["H I1", "I2"]);
  });

  it("is read from the named template alone: a block cannot start in one and end in the other", async () => {
    expect(await failure(para("<<cs_b>>") + REF(), incl(makeDocx(para("I") + para("<<es_>>"))), { b: true })).toContain("Section not ended");
    expect(await failure(para("A") + REF() + para("<<es_>>"), incl(makeDocx(para("<<cs_b>>") + para("IN"))))).toContain("Unmatched ending tag");
    expect(await texts(para("A") + REF() + para("B"), incl(makeDocx(para("<<cs_b>>") + para("IN") + para("<<es_>>"))), { b: true })).toEqual(["A", "IN", "B"]);
  });

  it("keeps a page break before an end tag that shares its paragraph with the tag", async () => {
    const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    expect(await texts(para("<<cs_b>>") + para("T") + pageBreak + para("<<es_>>") + para("after"), {}, { b: true })).toEqual(["T", "after"]);
    const kept = paragraphs(
      await merge(para("<<cs_b>>") + para("T") + pageBreak + para("<<es_>><<ref:inc.docx>>") + para("after"), incl(makeDocx(para("I"))), { b: true })
    ).filter(Boolean);
    expect(kept).toEqual(["T", "\n", "I", "after"]);
  });
});

describe("Docmosis: a ref: that cannot be merged is an error only when it is reached", () => {
  it("answers Template Not found for a name that was not supplied", async () => {
    expect(await failure(para("A") + REF("nope.docx") + para("B"), {})).toContain("Template Not found [nope.docx]");
  });

  it("does not read the tag as an expression: a name in braces is a template named so", async () => {
    expect(await failure(REF("{name}"), incl(makeDocx(para("I"))), { name: "inc.docx" })).toContain("Template Not found [{name}]");
  });

  it("writes the tag and a number in devMode", async () => {
    expect(await texts(para("A") + REF("nope.docx") + para("B"), {}, {}, { devMode: true })).toEqual(["A", "<<ref:nope.docx>>Docmosis1", "B"]);
  });

  it("does not look for a template in a block that is not taken", async () => {
    expect(await texts(para("<<cs_b>>") + REF("nope.docx") + para("<<es_>>") + para("ok"), {}, { b: false })).toEqual(["ok"]);
  });

  it("refuses an include that includes itself, naming who calls whom", async () => {
    const includes = { "a.docx": makeDocx(para("a") + para("<<ref:a.docx>>")) };
    expect(await failure(REF("a.docx"), includes)).toContain("Template Circular Reference: template [a.docx] is calling [a.docx]");
    const loop = { "a.docx": makeDocx(para("<<ref:b.docx>>")), "b.docx": makeDocx(para("<<ref:a.docx>>")) };
    expect(await failure(REF("a.docx"), loop)).toContain("template [b.docx] is calling [a.docx]");
  });

  it("stops a chain of includes that is too deep", async () => {
    const chain: Record<string, Buffer> = {};
    for (let i = 0; i < 20; i++) {
      chain[`t${i}.docx`] = makeDocx(para(`<<ref:t${i + 1}.docx>>`));
    }
    chain["t20.docx"] = makeDocx(para("end"));
    expect(await failure(REF("t0.docx"), chain)).toContain("levels deep");
  });

  it("stops includes that expand beyond the output limits", async () => {
    const includes = { "a.docx": makeDocx(para("<<ref:b.docx>>") + para("<<ref:b.docx>>")), "b.docx": makeDocx(para("x")) };
    await expect(merge(REF("a.docx"), includes, {}, { limits: { maxOutputNodes: 3 } })).rejects.toThrow(/exceeds the merge limits/);
  });

  it("reports a block fault of an include against the include and, in devMode, marks it in the included text", async () => {
    const bad = incl(makeDocx(para("<<cs_b>>") + para("open in the include")));
    expect(await failure(REF(), bad, { b: true })).toContain("Section not ended. Name: cs_b");
    expect(await failure(REF(), bad, { b: true })).toContain("inc.docx, paragraph");
    expect(await texts(para("A") + REF() + para("B"), bad, {}, { devMode: true })).toEqual(["A", "<<analysis>>Docmosis1<<cs_b>>", "open in the include", "B"]);
  });

  it("reports an error inside an include against the include", async () => {
    expect(await failure(REF(), incl(makeDocx(para("<<{x +}>>"))))).toContain("inc.docx, paragraph 1");
  });

  it.each([
    ["an empty name", "<<ref:>>", "is not complete"],
    ["a space after the colon", "<<ref: inc.docx>>", "contains leading or trailing whitespace"],
    ["an empty lookup", "<<refLookup:>>", "is not complete"],
    ["a capital letter in the keyword", "<<REF:inc.docx>>", "REF"]
  ])("rejects %s", async (_what, line, phrase) => {
    expect(await failure(para(line), incl(makeDocx(para("I"))))).toContain(phrase);
  });

  it("ignores spaces after the name and before the keyword", async () => {
    expect(await texts(para("<<ref:inc.docx >>") + para("<< ref:inc.docx>>"), incl(makeDocx(para("I"))))).toEqual(["I", "I"]);
  });
});

describe("Docmosis: refLookup:field names the template in the data", () => {
  const inc = incl(makeDocx(para("INC <<x>>")));

  it("includes the template whose name the field holds", async () => {
    expect(await texts(para("A") + para("<<refLookup:tpl>>") + para("B"), inc, { tpl: "inc.docx", x: "X1" })).toEqual(["A", "INC X1", "B"]);
    expect(await texts(para("<<refLookup:o.t>>"), inc, { o: { t: "inc.docx" }, x: "X" })).toEqual(["INC X"]);
    expect(await texts(para("<<refLookup:items[0].value>>"), inc, { items: [{ value: "inc.docx" }] })).toEqual(["INC"]);
  });

  it("reads the field in the scope of the tag, including $root, $parent and $this", async () => {
    const data = { tpl: "inc.docx", names: ["inc.docx"], items: [{ value: "inc.docx" }] };
    expect(await texts(para("<<rs_items>>") + para("<<refLookup:value>>") + para("<<es_items>>"), inc, data)).toEqual(["INC"]);
    expect(await texts(para("<<rs_items>>") + para("<<refLookup:$root.tpl>>") + para("<<es_items>>"), inc, data)).toEqual(["INC"]);
    expect(await texts(para("<<rs_items>>") + para("<<refLookup:$parent.tpl>>") + para("<<es_items>>"), inc, data)).toEqual(["INC"]);
    expect(await texts(para("<<rs_names>>") + para("<<refLookup:$this>>") + para("<<es_names>>"), inc, data)).toEqual(["INC"]);
    expect(await texts(para("<<$v=tpl>>") + para("<<refLookup:$v>>"), inc, data)).toEqual(["INC"]);
  });

  it("includes a different template for each item of a repeat", async () => {
    const includes = { "a.docx": makeDocx(para("A!")), "b.docx": makeDocx(para("B!")) };
    expect(
      await texts(para("<<rs_l>>") + para("<<refLookup:value>>") + para("<<es_l>>"), includes, {
        l: [{ value: "a.docx" }, { value: "b.docx" }, { value: "a.docx" }]
      })
    ).toEqual(["A!", "B!", "A!"]);
  });

  it.each([
    ["a missing field", "nofield"],
    ["null", "nul"],
    ["an empty string", "e"],
    ["a map", "o"],
    ["a literal template name", "inc.docx"]
  ])("fails for %s with no lookup name found", async (_what, path) => {
    expect(await failure(para(`<<refLookup:${path}>>`), inc, { nul: null, e: "", o: { a: 1 } })).toContain(
      `Can't load sub-template: no lookup name found via lookup:${path}`
    );
  });

  it("answers Template Not found via data lookup for a name that was not supplied, and reads a number as its text", async () => {
    expect(await failure(para("<<refLookup:tpl>>"), {}, { tpl: "gone.docx" })).toContain("Template Not found [gone.docx] via data lookup: [gone.docx]");
    expect(await failure(para("<<refLookup:n>>"), inc, { n: 5 })).toContain("Template Not found [5] via data lookup: [5]");
  });

  it("writes the tag in devMode", async () => {
    expect(await texts(para("A") + para("<<refLookup:nofield>>") + para("B"), inc, {}, { devMode: true })).toEqual([
      "A",
      "<<refLookup:nofield>>Docmosis1",
      "B"
    ]);
  });

  it("is not an op: field", async () => {
    expect(await failure(para("<<op:refLookup:tpl>>"), inc, { tpl: "inc.docx" })).toContain("refLookup");
  });
});

const stylesPart = (inner: string): string => `<w:styles xmlns:w="${W}">${inner}</w:styles>`;
const style = (id: string, body = "", extra = ""): string => `<w:style w:type="paragraph"${extra} w:styleId="${id}"><w:name w:val="${id}"/>${body}</w:style>`;
const styled = (text: string, id: string): string => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr>${run(text)}</w:p>`;
const relsXml = (...rels: string[]): string => `<?xml version="1.0"?><Relationships xmlns="${PKG}">${rels.join("")}</Relationships>`;
const rel = (id: string, type: string, target: string, mode = ""): string => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode}/>`;
const ctypes = (...inner: string[]): string =>
  `<?xml version="1.0"?><Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/>${inner.join("")}</Types>`;
const rootDoc = (body: string, namespaces = ""): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"${namespaces}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const withDoc = (body: string, extra: Record<string, string>): Buffer => makeDocx(body, { "word/document.xml": rootDoc(body), ...extra });

describe("styles of an include are copied under new ids, so its paragraphs keep their look", () => {
  const incStyles = stylesPart(style("Fancy", "<w:rPr><w:b/></w:rPr>") + style("Clash", '<w:rPr><w:color w:val="0000FF"/></w:rPr>'));

  it("renames every style the include uses, leaving the host's own alone", async () => {
    const main = stylesPart(style("Clash", '<w:rPr><w:color w:val="00FF00"/></w:rPr>') + style("Mainonly", "<w:rPr><w:i/></w:rPr>"));
    const inc = withDoc(styled("fancy", "Fancy") + styled("clash", "Clash"), { "word/styles.xml": incStyles });
    const out = await merge(styled("host", "Clash") + REF(), incl(inc), {}, {}, { "word/styles.xml": main });
    const xml = partXml(out);
    expect(xml).toContain('w:pStyle w:val="Clash"/></w:pPr><w:r><w:t xml:space="preserve">host');
    expect(xml).toContain('w:pStyle w:val="Fancy_1"');
    expect(xml).toContain('w:pStyle w:val="Clash_1"');
    const styles = files(out)["word/styles.xml"]!;
    expect(styles).toContain('w:styleId="Clash"');
    expect(styles).toContain('w:styleId="Mainonly"');
    expect(styles).toContain('w:styleId="Fancy_1"');
    expect(styles).toContain('<w:name w:val="Fancy (1)"/>');
    expect(styles).toContain('w:val="0000FF"');
    expect(styles).toContain('w:val="00FF00"');
  });

  it("reuses a style the host already has with the same definition", async () => {
    const same = stylesPart(style("Same", "<w:rPr><w:b/></w:rPr>"));
    const inc = withDoc(styled("s", "Same"), { "word/styles.xml": same });
    const out = await merge(REF(), incl(inc), {}, {}, { "word/styles.xml": same });
    expect(partXml(out)).toContain('w:pStyle w:val="Same"');
    expect(files(out)["word/styles.xml"]!.match(/w:styleId="Same"/g)).toHaveLength(1);
  });

  it("creates the styles part when the host has none", async () => {
    const inc = withDoc(styled("fancy", "Fancy"), { "word/styles.xml": incStyles });
    const out = await merge(REF(), incl(inc));
    const parts = files(out);
    expect(parts["word/styles.xml"]).toContain('w:styleId="Fancy_1"');
    expect(parts["[Content_Types].xml"]).toContain('PartName="/word/styles.xml"');
    expect(parts["word/_rels/document.xml.rels"]).toContain('Target="styles.xml"');
  });

  it("copies the styles a used style is based on, continues with, or links to, and gives each a new id", async () => {
    const chain = stylesPart(
      style("Base", "<w:rPr><w:b/></w:rPr>") +
        style("Child", '<w:basedOn w:val="Base"/><w:next w:val="Child"/><w:link w:val="ChildChar"/>') +
        style("ChildChar", "<w:rPr><w:i/></w:rPr>", "").replace('w:type="paragraph"', 'w:type="character"')
    );
    const out = await merge(REF(), incl(withDoc(styled("c", "Child"), { "word/styles.xml": chain })));
    const styles = files(out)["word/styles.xml"]!;
    expect(styles).toContain('<w:basedOn w:val="Base_1"/>');
    expect(styles).toContain('<w:next w:val="Child_1"/>');
    expect(styles).toContain('<w:link w:val="ChildChar_1"/>');
    expect(styles).toContain('w:styleId="ChildChar_1"');
  });

  it("gives a second include's styles their own ids", async () => {
    const includes = {
      "a.docx": withDoc(styled("a", "Fancy"), { "word/styles.xml": stylesPart(style("Fancy", "<w:rPr><w:b/></w:rPr>")) }),
      "b.docx": withDoc(styled("b", "Fancy"), { "word/styles.xml": stylesPart(style("Fancy", "<w:rPr><w:i/></w:rPr>")) })
    };
    const out = await merge(REF("a.docx") + REF("b.docx"), includes);
    const xml = partXml(out);
    expect(xml).toContain('w:pStyle w:val="Fancy_1"');
    expect(xml).toContain('w:pStyle w:val="Fancy_2"');
  });

  it("gives paragraphs with no style the include's default style when it differs from the host's", async () => {
    const mainStyles = stylesPart(style("Normal", '<w:rPr><w:sz w:val="22"/></w:rPr>', ' w:default="1"'));
    const incStyles2 = stylesPart(style("Normal", '<w:rPr><w:sz w:val="40"/></w:rPr>', ' w:default="1"'));
    const inc = withDoc(`${para("plain")}<w:p/>${styled("explicit", "Normal")}`, { "word/styles.xml": incStyles2 });
    const out = await merge(para("host") + REF(), incl(inc), {}, {}, { "word/styles.xml": mainStyles });
    const xml = partXml(out);
    expect(xml.match(/w:pStyle w:val="Normal_1"/g)).toHaveLength(3);
    expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">host');
    expect(files(out)["word/styles.xml"]).toContain('w:styleId="Normal_1"');
  });

  it("leaves paragraphs with no style alone when the default styles match", async () => {
    const same = stylesPart(style("Normal", '<w:rPr><w:sz w:val="22"/></w:rPr>', ' w:default="1"'));
    const out = await merge(REF(), incl(withDoc(para("plain"), { "word/styles.xml": same })), {}, {}, { "word/styles.xml": same });
    expect(partXml(out)).not.toContain("w:pStyle");
  });

  it("carries the include's document defaults over to what it uses, by a style they are based on", async () => {
    const defaults = (size: number): string =>
      `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="${size}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults>`;
    const inc = withDoc(styled("f", "Fancy") + para("plain"), {
      "word/styles.xml": stylesPart(`${defaults(40)}${style("Normal", "", ' w:default="1"')}${style("Fancy", "<w:rPr><w:b/></w:rPr>")}`)
    });
    const out = await merge(REF(), incl(inc), {}, {}, { "word/styles.xml": stylesPart(`${defaults(20)}${style("Normal", "", ' w:default="1"')}`) });
    const styles = files(out)["word/styles.xml"]!;
    expect(styles).toContain('w:styleId="DocDefaults_1"');
    expect(styles).toContain('<w:sz w:val="40"/>');
    expect(styles).toMatch(/w:styleId="Fancy_1"><w:name w:val="Fancy \(1\)"\/><w:basedOn w:val="DocDefaults_1"\/>/);
    expect(styles).toMatch(/w:styleId="Normal_1"><w:name w:val="Normal \(1\)"\/><w:basedOn w:val="DocDefaults_1"\/>/);
  });

  it("copies a table style and the style a run uses", async () => {
    const tableStyle = `<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/></w:style><w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;
    const body = `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr><w:tblGrid><w:gridCol w:w="1"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const out = await merge(REF(), incl(withDoc(body, { "word/styles.xml": stylesPart(tableStyle) })));
    const xml = partXml(out);
    expect(xml).toContain('w:tblStyle w:val="Grid_1"');
    expect(xml).toContain('w:rStyle w:val="Strong_1"');
  });

  it("leaves a style the include does not define as it is", async () => {
    const out = await merge(REF(), incl(withDoc(styled("x", "Undefined"), { "word/styles.xml": incStyles })));
    expect(partXml(out)).toContain('w:pStyle w:val="Undefined"');
  });
});

const numbering = (abstract: string, num = 1, abstractId = 0): string =>
  `<w:abstractNum w:abstractNumId="${abstractId}"><w:nsid w:val="AAAA0000"/>${abstract}</w:abstractNum><w:num w:numId="${num}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
const level = (fmt: string, extra = ""): string => `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${extra}<w:lvlText w:val="%1."/></w:lvl>`;
const numbered = (text: string, id = 1): string => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
const numberingPart = (inner: string): string => `<w:numbering xmlns:w="${W}">${inner}</w:numbering>`;

describe("lists of an include are copied under new numbers", () => {
  it("adds the include's list definition after the host's and points the include's paragraphs at it", async () => {
    const main = numberingPart(numbering(level("upperLetter")));
    const inc = withDoc(numbered("one") + numbered("none", 0) + numbered("gone", 9), { "word/numbering.xml": numberingPart(numbering(level("decimal"))) });
    const out = await merge(numbered("host") + REF(), incl(inc), {}, {}, { "word/numbering.xml": main });
    const xml = partXml(out);
    expect(xml.match(/w:numId w:val="1"/g)).toHaveLength(1);
    expect(xml.match(/w:numId w:val="2"/g)).toHaveLength(1);
    expect(xml).toContain('w:numId w:val="0"');
    expect(xml).toContain('w:numId w:val="9"');
    const parts = files(out)["word/numbering.xml"]!;
    expect(parts.indexOf('w:abstractNumId="1"')).toBeLessThan(parts.indexOf("<w:num "));
    expect(parts).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>');
    expect(parts).toContain('w:numFmt w:val="decimal"');
    expect(parts).not.toMatch(/AAAA0000[\s\S]*AAAA0000[\s\S]*AAAA0000/);
    expect(parts.match(/AAAA0000/g)).toHaveLength(1);
  });

  it("creates the numbering part when the host has none, and shares a definition between two lists", async () => {
    const inc = withDoc(numbered("a") + numbered("b"), { "word/numbering.xml": numberingPart(numbering(level("decimal"))) });
    const out = await merge(REF(), incl(inc));
    const parts = files(out);
    expect(parts["[Content_Types].xml"]).toContain('PartName="/word/numbering.xml"');
    expect(parts["word/_rels/document.xml.rels"]).toContain('Target="numbering.xml"');
    expect(parts["word/numbering.xml"]!.match(/<w:abstractNum /g)).toHaveLength(1);
    expect(partXml(out).match(/w:numId w:val="1"/g)).toHaveLength(2);
  });

  it("copies the numbering a style carries, and links styles in a list level to the copies", async () => {
    const styles = stylesPart(style("ListItem", '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>'));
    const inc = withDoc(styled("item", "ListItem"), {
      "word/styles.xml": styles,
      "word/numbering.xml": numberingPart(numbering(level("decimal", '<w:pStyle w:val="ListItem"/>')))
    });
    const out = await merge(REF(), incl(inc), {}, {}, { "word/numbering.xml": numberingPart(numbering(level("bullet"))) });
    const parts = files(out);
    expect(parts["word/styles.xml"]).toMatch(/w:styleId="ListItem_1"[\s\S]*<w:numId w:val="2"\/>/);
    expect(parts["word/numbering.xml"]).toContain('<w:pStyle w:val="ListItem_1"/>');
  });

  it("copies the lists of a second include after the first's", async () => {
    const part = { "word/numbering.xml": numberingPart(numbering(level("decimal"))) };
    const includes = { "a.docx": withDoc(numbered("a"), part), "b.docx": withDoc(numbered("b"), part) };
    const out = await merge(REF("a.docx") + REF("b.docx"), includes);
    expect(partXml(out)).toMatch(/w:numId w:val="1"[\s\S]*w:numId w:val="2"/);
  });

  it("refuses a picture bullet", async () => {
    const inc = withDoc(numbered("a"), { "word/numbering.xml": numberingPart(numbering(level("bullet", '<w:lvlPicBulletId w:val="0"/>'))) });
    expect(await failure(REF(), incl(inc))).toContain("picture bullet");
  });
});

const IMG = "word/media/image1.png";
const picture = (rid: string): string =>
  `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:blip r:embed="${rid}" xmlns:a="y"/></w:drawing></w:r></w:p>`.replace(
    "</w:drawing>",
    "</wp:inline></w:drawing>"
  );
const link = (rid: string): string => `<w:p><w:hyperlink r:id="${rid}"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>`;
const rDoc = (xml: string): string => xml;

describe("images and hyperlinks of an include are copied across with new relationship ids", () => {
  const png = "PNG-BYTES";
  const incWith = (body: string, rels: string[], extra: Record<string, string> = {}): Buffer =>
    withDoc(body, {
      "word/_rels/document.xml.rels": relsXml(...rels),
      [IMG]: png,
      "[Content_Types].xml": ctypes('<Default Extension="png" ContentType="image/png"/>'),
      ...extra
    });

  it("copies an image, adds its relationship and registers its type", async () => {
    const inc = incWith(rDoc(picture("rId7")), [rel("rId7", "image", "media/image1.png")]);
    const out = await merge(para("host") + REF(), incl(inc), {}, {}, {});
    const parts = files(out);
    expect(Object.keys(parts)).toContain("word/media/inc1_image1.png");
    expect(parts["word/media/inc1_image1.png"]).toBe(png);
    expect(parts["word/_rels/document.xml.rels"]).toContain(`Type="${R}/image" Target="/word/media/inc1_image1.png"`);
    expect(parts["[Content_Types].xml"]).toContain('<Default Extension="png" ContentType="image/png"/>');
    const id = /Id="(rId\d+)"[^>]*inc1_image1/.exec(parts["word/_rels/document.xml.rels"]!)![1];
    expect(partXml(out)).toContain(`r:embed="${id}"`);
  });

  it("does not repeat a type the host already registers, and copies an image once however often it is used", async () => {
    const inc = incWith(rDoc(picture("rId7")) + picture("rId7"), [rel("rId7", "image", "media/image1.png")]);
    const out = await merge(REF() + REF(), incl(inc), {}, {}, { "[Content_Types].xml": ctypes('<Default Extension="PNG" ContentType="image/png"/>') });
    const parts = files(out);
    expect(parts["[Content_Types].xml"]!.match(/Extension="png"/gi)).toHaveLength(1);
    expect(Object.keys(parts).filter((n) => n.startsWith("word/media/"))).toEqual(["word/media/inc1_image1.png"]);
    expect(parts["word/_rels/document.xml.rels"]!.match(/inc1_image1/g)).toHaveLength(1);
  });

  it("avoids the ids the host's relationships use", async () => {
    const inc = incWith(rDoc(link("rId1")), [rel("rId1", "hyperlink", "https://example.org/a?b=1&amp;c=2", ' TargetMode="External"')]);
    const out = await merge(
      para("host") + REF(),
      incl(inc),
      {},
      {},
      { "word/_rels/document.xml.rels": relsXml(rel("rId1", "styles", "styles.xml"), rel("rId2", "theme", "theme.xml")) }
    );
    const rels = files(out)["word/_rels/document.xml.rels"]!;
    expect(rels).toContain(`Id="rId3" Type="${R}/hyperlink" Target="https://example.org/a?b=1&amp;c=2" TargetMode="External"`);
    expect(partXml(out)).toContain('r:id="rId3"');
  });

  it("copies an external image link as the link it is", async () => {
    const inc = incWith(rDoc(picture("rId7")), [rel("rId7", "image", "https://example.org/x.png", ' TargetMode="External"')]);
    const out = await merge(REF(), incl(inc));
    expect(files(out)["word/_rels/document.xml.rels"]).toContain('Target="https://example.org/x.png" TargetMode="External"');
  });

  it("takes an image at an absolute path and one in the content types as an override", async () => {
    const inc = withDoc(rDoc(picture("rId7")), {
      "word/_rels/document.xml.rels": relsXml(rel("rId7", "image", "/word/media/pic.jpeg")),
      "word/media/pic.jpeg": "JPEG",
      "[Content_Types].xml": ctypes('<Default Extension="jpeg" ContentType="image/jpeg"/>')
    });
    const out = await merge(REF(), incl(inc));
    expect(files(out)["word/media/inc1_pic.jpeg"]).toBe("JPEG");
    expect(files(out)["[Content_Types].xml"]).toContain('Extension="jpeg" ContentType="image/jpeg"');
  });

  it("knows the usual image types when the include does not register them", async () => {
    const inc = withDoc(rDoc(picture("rId7")), {
      "word/_rels/document.xml.rels": relsXml(rel("rId7", "image", "media/logo.svg")),
      "word/media/logo.svg": "<svg/>"
    });
    const out = await merge(REF(), incl(inc));
    expect(files(out)["[Content_Types].xml"]).toContain('Extension="svg" ContentType="image/svg+xml"');
  });

  it("writes the relationships of an include in a header into the header's own", async () => {
    const inc = incWith(rDoc(link("rId1")), [rel("rId1", "hyperlink", "https://example.org", ' TargetMode="External"')]);
    const out = await merge(para("body"), incl(inc), {}, {}, { "word/header1.xml": header(para("<<ref:inc.docx>>")) });
    const parts = files(out);
    expect(parts["word/_rels/header1.xml.rels"]).toContain('Target="https://example.org"');
    expect(parts["word/header1.xml"]).toContain('r:id="rId1"');
  });

  it("refuses an image the include does not contain, one of an unknown type, and a relationship it does not define", async () => {
    expect(
      await failure(REF(), incl(withDoc(rDoc(picture("rId7")), { "word/_rels/document.xml.rels": relsXml(rel("rId7", "image", "media/gone.png")) })))
    ).toContain("which it does not contain");
    expect(
      await failure(
        REF(),
        incl(withDoc(rDoc(picture("rId7")), { "word/_rels/document.xml.rels": relsXml(rel("rId7", "image", "media/x.zzz")), "word/media/x.zzz": "?" }))
      )
    ).toContain("unknown type");
    expect(await failure(REF(), incl(withDoc(rDoc(picture("rId9")), { "word/_rels/document.xml.rels": relsXml() })))).toContain(
      "relationship rId9, which it does not define"
    );
  });

  it("refuses relationships it cannot copy", async () => {
    const inc = withDoc(rDoc(link("rId5")), { "word/_rels/document.xml.rels": relsXml(rel("rId5", "chart", "charts/chart1.xml")) });
    expect(await failure(REF(), incl(inc))).toContain("uses a chart relationship");
  });

  it("does not read the header and footer references of the include's own sections", async () => {
    const inc = withDoc(`<w:p xmlns:r="${R}"><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rId8"/></w:sectPr></w:pPr></w:p>${para("x")}`, {
      "word/_rels/document.xml.rels": relsXml(rel("rId8", "header", "header9.xml"))
    });
    expect(await texts(REF(), incl(inc))).toEqual(["x"]);
  });
});

describe("namespaces and sections of an include", () => {
  it("declares on the host the namespaces the included content uses and the host lacks", async () => {
    const inc = Buffer.from(
      zipSync({
        ...unzipSync(new Uint8Array(makeDocx(""))),
        "word/document.xml": strToU8(
          `<w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:a="x"><w:body><w:p w14:paraId="1">${run("x")}</w:p></w:body></w:document>`
        )
      })
    );
    const out = await merge(REF(), incl(inc));
    expect(partXml(out)).toMatch(/^<\?xml[^>]*\?><w:document xmlns:w14="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordml" xmlns:w=/);
    expect(partXml(out).match(/xmlns:w14/g)).toHaveLength(1);
    expect(partXml(out)).not.toContain("xmlns:a=");
  });

  it("refuses a prefix that means a different namespace in the include", async () => {
    const inc = Buffer.from(
      zipSync({
        ...unzipSync(new Uint8Array(makeDocx(""))),
        "word/document.xml": strToU8(`<w:document xmlns:w="${W}" xmlns:r="other"><w:body><w:p r:x="1">${run("x")}</w:p></w:body></w:document>`)
      })
    );
    const hostRoot = `<w:document xmlns:w="${W}" xmlns:r="mine"><w:body>${REF()}<w:sectPr/></w:body></w:document>`;
    await expect(merge("", incl(inc), {}, {}, { "word/document.xml": hostRoot })).rejects.toMatchObject({
      details: [expect.stringContaining("namespace prefix r")]
    });
  });

  it("replaces the section properties inside the include with the host's, without its header and footer references", async () => {
    const hostBody = `${para("host")}<w:p><w:r><w:t>x</w:t></w:r></w:p>`;
    const inc = makeDocx(
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr>${run("I1")}</w:p>${para("I2")}<w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr>`
    );
    const mainDoc = makeDocx(hostBody + REF());
    const files2 = unzipSync(new Uint8Array(mainDoc));
    files2["word/document.xml"] = strToU8(
      strFromU8(files2["word/document.xml"]!).replace(
        "<w:sectPr/>",
        `<w:sectPr xmlns:r="${R}"><w:headerReference w:type="default" r:id="rId9"/><w:titlePg/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`
      )
    );
    const out = await mergeDocx(Buffer.from(zipSync(files2)), {}, { devMode: false, includes: incl(inc) });
    const xml = partXml(out);
    expect(xml).not.toContain('16838" w:h="11906');
    expect(xml.match(/<w:pgSz w:w="11906" w:h="16838"\/>/g)).toHaveLength(2);
    expect(xml.match(/headerReference/g)).toHaveLength(1);
    expect(xml.match(/titlePg/g)).toHaveLength(1);
    expect(xml).not.toContain('w:w="1" w:h="2"');
  });
});

describe("what cannot be copied is refused, not copied wrongly", () => {
  it.each([
    ["a footnote reference", '<w:p><w:r><w:footnoteReference w:id="2"/></w:r></w:p>', "footnoteReference"],
    ["a comment reference", '<w:p><w:r><w:commentReference w:id="2"/></w:r></w:p>', "commentReference"],
    ["an altChunk", '<w:altChunk r:id="rId1"/>', "altChunk"]
  ])("%s", async (_what, body, phrase) => {
    expect(await failure(REF(), incl(makeDocx(body)))).toContain(phrase);
  });

  it("answers for an include that is not a readable .docx", async () => {
    expect(await failure(REF(), { "inc.docx": Buffer.from("PK\x03\x04 not really") })).toContain("inc.docx is not a readable .docx");
    const noDoc = Buffer.from(zipSync({ "word/other.xml": strToU8("<x/>") }));
    expect(await failure(REF(), incl(noDoc))).toContain("it has no word/document.xml");
    const noBody = Buffer.from(zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="${W}"/>`) }));
    expect(await failure(REF(), incl(noBody))).toContain("has no document body");
  });

  it("counts the include against the limits that apply to the template", async () => {
    const inc = makeDocx(para("x"));
    await expect(merge(REF(), incl(inc), {}, { limits: { maxEntries: entryNames(makeDocx("")).length + 1 } })).rejects.toThrow(/exceeds the merge limits/);
    await expect(merge(REF(), incl(inc), {}, { limits: { maxTotalBytes: 1500 } })).rejects.toThrow(/exceeds the merge limits/);
  });

  it("answers Template Not found for a name that only exists on the prototype chain", async () => {
    expect(await failure(REF("constructor"), {})).toContain("Template Not found [constructor]");
  });
});
