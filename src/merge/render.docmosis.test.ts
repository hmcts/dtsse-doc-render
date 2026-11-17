import { describe, expect, it, vi } from "vitest";
import { cell, header, makeDocx, para, paragraphs, partXml, row, run, table } from "../../test/helpers/docx.ts";
import { MergeError, mergeDocx } from "./index.ts";
import { htmlToText } from "./render.ts";

// html: values reach the renderer as `html: true` fields; this stands in for the parser that produces them.
vi.mock("./expr.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./expr.ts")>();
  return {
    ...real,
    parseInstruction(text: string) {
      const m = /^html:(.+)$/.exec(text.trim());
      return m ? { kind: "field", expr: m[1], optionalParagraph: false, html: true } : real.parseInstruction(text);
    }
  };
});

const strict = { devMode: false };
const dev = { devMode: true };
const merge = (body: string, data: unknown, options = strict, extra: Record<string, string> = {}): Promise<Buffer> =>
  mergeDocx(makeDocx(body, extra), data, options);
const texts = async (body: string, data: unknown, options = strict): Promise<string[]> => paragraphs(await merge(body, data, options));
const indented = (text: string): string => `<w:p><w:pPr><w:ind w:left="720"/></w:pPr>${run(text)}</w:p>`;
const data = { f: false, t: true, empty: "", name: "N", trailing: "v " };

describe("whitespace seams: one space is dropped where a zero-output tag sits between literal spaces", () => {
  const cases: [string, string, string][] = [
    ["a space ends the left text and starts the right text of an empty field", "[a <<empty>> b]", "[a b]"],
    ["a block that is not taken", "[a <<cs_f>>x<<es_>> b]", "[a b]"],
    ["a block that is taken and ends in one space", "[a <<cs_t>>x <<es_>> b]", "[a x b]"],
    ["two trailing spaces are not collapsed", "[a  <<empty>> b]", "[a   b]"],
    ["two leading spaces on the right lose only the left space", "[a <<empty>>  b]", "[a  b]"],
    ["no space on the left", "[a<<empty>> b]", "[a b]"],
    ["no space on the right", "[a <<empty>>b]", "[a b]"],
    ["a non-empty value ending in a space", "[a <<trailing>><<empty>> b]", "[a v  b]"],
    ["a literal after a value", "[<<trailing>> <<empty>> b]", "[v  b]"],
    ["an assignment", "[a <<$v=1>> b]", "[a b]"],
    ["a chain of empty fields takes one space from each seam", "[a <<empty>> <<empty>> b]", "[a b]"],
    ["a chain with two spaces in the middle", "[a <<empty>>  <<empty>> b]", "[a   b]"],
    ["an else branch", "[a <<cs_f>>x<<else>> y<<es_>> b]", "[a y b]"],
    ["a skipped block between spaces", "[a <<cs_f>>zz<<es_>> <<empty>> b]", "[a b]"],
    ["a non-empty value on the right is not literal", "[a <<empty>><<trailing>>b]", "[a v b]"]
  ];
  for (const [name, input, expected] of cases) {
    it(name, async () => {
      expect(await texts(para(input), data)).toEqual([expected]);
    });
  }

  it("collapses across runs", async () => {
    const b = para(run("a "), run("<<empty>>"), run(" b"));
    expect(await texts(b, data)).toEqual(["a b"]);
  });
});

describe("a block opened mid-paragraph joins the paragraph's text", () => {
  const b = para("that<<cs_f>> A<<else>> the applicant <<cs_f>>half") + para("<<es_>>") + para("<<es_>>");
  it("puts the text before the opener and the kept branch in one paragraph", async () => {
    expect(await texts(b, data)).toEqual(["that the applicant ", ""]);
  });

  it("joins the text before a taken block with the text after the opener", async () => {
    const taken = para("that<<cs_t>> A") + para("mid") + para("<<es_>> tail");
    expect(await texts(taken, data)).toEqual(["that A", "mid", "tail"]);
  });

  it("runs the text before a block that is not taken on into the text after it when the paragraph properties match", async () => {
    const skipped = para("that<<cs_f>> A") + para("mid") + para("<<es_>> tail");
    expect(await texts(skipped, data)).toEqual(["that tail"]);
  });
});

const indentedBy = (n: number, text: string): string => `<w:p><w:pPr><w:ind w:left="${n}"/></w:pPr>${run(text)}</w:p>`;
const shapes = async (body: string, d: unknown = data): Promise<string[]> => {
  const out = paragraphs(await merge(body, d));
  return out.map((t) => (t === "" ? "-" : t));
};

describe("empty paragraphs: which zero-output paragraphs Docmosis keeps", () => {
  it("drops a paragraph of only block tags, an assignment or a blank op: field", async () => {
    const b = para("a") + para("<<cs_t>><<es_>>") + para("<<$q=1>>") + para("<<op:empty>>") + para("<<$q=1>><<$r=2>>") + para("b");
    expect(await shapes(b)).toEqual(["a", "b"]);
  });

  it("keeps a paragraph with a field that renders to nothing", async () => {
    expect(await shapes(para("a") + para("<<empty>>") + para("<<empty>><<$q=1>>") + para("b"))).toEqual(["a", "-", "-", "b"]);
  });

  it("keeps a paragraph whose only literal text is in a block that is not taken", async () => {
    expect(await shapes(para("a") + para("<<cs_f>>x<<es_>>") + para("<<rs_missing>>x<<es_>>") + para("b"))).toEqual(["a", "-", "-", "b"]);
  });

  it("keeps a paragraph that is only whitespace, or has whitespace after a tag, but not whitespace before the first tag", async () => {
    expect(await shapes(para("a") + para(" ") + para("<<$q=1>> ") + para("<<cs_t>> <<es_>>") + para("b"))).toEqual(["a", " ", "-", "-", "b"]);
    expect(await texts(para("<<$q=1>>  x") + para("<<empty>> y") + para("<<cs_t>> z<<es_>>") + para("  <<$q=1>> w"), data)).toEqual([" x", "y", "z", "   w"]);
    expect(await shapes(para("a") + para(" <<$q=1>>") + para("b"))).toEqual(["a", "b"]);
  });

  it("keeps a paragraph whose tag has a space after the opening brackets", async () => {
    expect(await shapes(para("a") + para("<< cs_t>>") + para("x") + para("<< es_>>") + para("b"))).toEqual(["a", "-", "x", "-", "b"]);
  });

  it("adds an empty paragraph after a block that ends in another paragraph when the opening paragraph has content", async () => {
    const same = para("that<<cs_t>> A") + para("mid") + para("<<es_>>") + para("next");
    expect(await shapes(same)).toEqual(["that A", "mid", "-", "next"]);
    expect(await shapes(para("<<cs_t>>") + para("mid") + para("<<es_>>") + para("next"))).toEqual(["mid", "next"]);
  });

  it("adds an empty paragraph with the opener's properties, and splits the end paragraph, when the properties differ", async () => {
    const b = indentedBy(100, "that<<cs_t>> A") + indentedBy(200, "mid") + indentedBy(300, "<<es_>> tail") + indentedBy(400, "next");
    const out = await merge(b, data);
    expect(paragraphs(out)).toEqual(["that A", "mid", "", "", "tail", "next"]);
    expect(partXml(out).match(/w:left="(\d+)"/g)).toEqual(['w:left="100"', 'w:left="200"', 'w:left="300"', 'w:left="100"', 'w:left="300"', 'w:left="400"']);
  });

  it("keeps the text before a block that is not taken apart from the text after it when the properties differ", async () => {
    const b = indentedBy(100, "that<<cs_f>> A") + indentedBy(200, "mid") + indentedBy(300, "<<es_>> tail");
    expect(paragraphs(await merge(b, data))).toEqual(["that", "tail"]);
  });

  it("starts the paragraph an untaken block hides with an empty one when the opener has nothing before it", async () => {
    expect(await shapes(indentedBy(100, "<<cs_f>> A") + indentedBy(200, "mid") + indentedBy(300, "<<es_>> tail"))).toEqual(["-", "tail"]);
  });

  it("adds the empty paragraph for a branch that is skipped when it opens at an else", async () => {
    const b = indentedBy(100, "pre<<cs_t>>a") + indentedBy(200, "m<<else>>b") + indentedBy(300, "c<<es_>>post");
    expect(await shapes(b)).toEqual(["prea", "m", "-", "-", "post"]);
  });

  it("repeats nothing extra per item, and one empty paragraph after the last", async () => {
    const b = para("pre<<rs_l>>a<<$this>>") + para("mid") + para("<<es_>>");
    expect(await shapes(b, { l: [1, 2] })).toEqual(["prea1", "mid", "a2", "mid", "-"]);
  });

  it("ends a document that ends in a table with an empty paragraph", async () => {
    const out = await merge(table(row(cell(para("x")))), data);
    expect(partXml(out)).toMatch(/<\/w:tbl><w:p><\/w:p><w:sectPr\/>/);
  });
});

describe("a newline ends the paragraph", () => {
  it("splits at $nl and copies the paragraph properties", async () => {
    const out = await merge(indented("a<<$nl>>b"), data);
    expect(paragraphs(out)).toEqual(["a", "b"]);
    expect(partXml(out).match(/<w:ind w:left="720"\/>/g)).toHaveLength(2);
  });

  it("splits at a newline in a data value", async () => {
    expect(await texts(para("x<<v>>y"), { v: "l1\nl2" })).toEqual(["xl1", "l2y"]);
  });

  it("keeps the run formatting on both sides of the split", async () => {
    const out = await merge(para(run("a<<$nl>>b", "<w:b/>")), data);
    expect(partXml(out).match(/<w:rPr><w:b\/><\/w:rPr>/g)).toHaveLength(2);
  });

  it("starts an empty paragraph when the newline ends the text", async () => {
    expect(await texts(para("a<<$nl>>"), data)).toEqual(["a", ""]);
  });

  it("splits a table cell paragraph", async () => {
    const out = await merge(table(row(cell(para("c1<<$nl>>c2")))), data);
    expect(paragraphs(out)).toEqual(["c1", "c2", ""]);
  });
});

describe("pageBreak", () => {
  it("emits a page break when the paragraph holds only the tag", async () => {
    const out = await merge(para("Page one.") + indented("<<pageBreak>>") + para("Page two."), data);
    expect(partXml(out)).toContain('<w:br w:type="page"/>');
    expect(partXml(out)).not.toContain("<<");
    expect(paragraphs(out)).toEqual(["Page one.", "\n", "Page two."]);
  });

  it("gives the page break paragraph default properties", async () => {
    expect(partXml(await merge(indented("<<pageBreak>>"), data))).not.toContain("w:ind");
  });

  it("emits nothing when the tag shares the paragraph with other text", async () => {
    expect(await texts(para("a<<pageBreak>>b") + para("<<pageBreak>> "), data)).toEqual(["ab", " "]);
  });

  it("looks <<{pageBreak}>> up as data", async () => {
    expect(await texts(para("<<{pageBreak}>>"), data)).toEqual([""]);
  });

  it("ends the paragraph after a page break that has content after it", async () => {
    const b = para(run("Before"), '<w:r><w:br w:type="page"/></w:r>', run("After"));
    expect(await texts(b, data)).toEqual(["Before\n", "After"]);
  });

  it("keeps a trailing page break in its own paragraph", async () => {
    expect(await texts(para(run("Before"), '<w:r><w:br w:type="page"/></w:r>'), data)).toEqual(["Before\n"]);
  });

  it("drops a page break paragraph's break when an end tag follows it", async () => {
    const b = para("<<cs_t>>") + para("x") + para('<w:r><w:br w:type="page"/></w:r>') + para("<<es_>>") + para("n");
    const out = await merge(b, data);
    expect(partXml(out)).not.toContain("w:br");
    expect(paragraphs(out)).toEqual(["x", "", "n"]);
  });

  it("drops a page break in front of an end tag in the same paragraph", async () => {
    const b = para("<<cs_t>>") + para("x") + para('<w:r><w:br w:type="page"/></w:r>', run("<<es_>>")) + para("n");
    expect(partXml(await merge(b, data))).not.toContain("w:br");
  });

  it("keeps a page break that does not end a block", async () => {
    const b = para("<<cs_t>>") + para("x") + para('<w:r><w:br w:type="page"/></w:r>') + para("y") + para("<<es_>>");
    expect(partXml(await merge(b, data))).toContain("w:br");
  });
});

describe("comments", () => {
  it("removes the whole paragraph that holds a comment, however much other text it has", async () => {
    const b = para("a") + para("<</* c */>>") + para("Kept <</* inline */>>text.") + para("<</* c */>><<name>>") + para("<<name>><</* c */>>") + para("z");
    expect(await texts(b, data)).toEqual(["a", "z"]);
  });

  it("empties a table cell that holds a comment", async () => {
    const out = await merge(table(row(cell(para("a<</* c */>>")), cell(para("b")))), data);
    expect(paragraphs(out)).toEqual(["", "b", ""]);
  });

  it("keeps a paragraph that carries a section break, without its text", async () => {
    const b = `<w:p><w:pPr><w:sectPr/></w:pPr>${run("a<</* c */>>")}</w:p>`;
    const out = await merge(b, data);
    expect(partXml(out)).toContain("<w:sectPr/>");
    expect(paragraphs(out)[0]).toBe("");
  });
});

describe("html:", () => {
  const html = { h: "<b>x</b> y", ps: "<p>a</p><p>b</p>", br: "a<br>b<br/>c", ent: "1 &amp; 2 &lt;3&gt;&#33;&nbsp;&#x41;&unknown;" };

  it("strips tags from the value", async () => {
    expect(await texts(para("<<html:h>>"), html)).toEqual(["x y"]);
  });

  it("starts a paragraph with default properties at each paragraph tag", async () => {
    const out = await merge(indented("x<<html:ps>>y"), html);
    expect(paragraphs(out)).toEqual(["xa", "by"]);
    expect(partXml(out).match(/w:ind/g)).toHaveLength(1);
  });

  it("makes <br> a line break", async () => {
    const out = await merge(para("<<html:br>>"), html);
    expect(paragraphs(out)).toEqual(["a\nb\nc"]);
  });

  it("drops the paragraph properties when the paragraph holds only the value", async () => {
    expect(partXml(await merge(indented("<<html:h>>"), html))).not.toContain("w:ind");
  });

  it("decodes entities", () => {
    expect(htmlToText(html.ent)).toBe("1 & 2 <3>! A&unknown;");
    expect(htmlToText("<p>a</p><div>b</div>")).toBe("a\fb");
    expect(htmlToText("<p></p>")).toBe("");
  });
});

describe("structural validation", () => {
  const fails = async (body: string, extra: Record<string, string> = {}): Promise<string[]> => {
    const err = await merge(body, { claim: { type: 1 }, items: [1] }, strict, extra).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeError);
    return (err as MergeError).details;
  };

  it("rejects a named end tag that does not match its start", async () => {
    const d = await fails(para("<<cs_claim.type>>a<<es_claim>>"));
    expect(d[0]).toContain('Expecting section end for section "claim.type" but end is for section "claim"');
    expect(d[0]).toContain("Mismatched sections");
  });

  it("accepts a named end tag that matches, and a bare one", async () => {
    expect(await texts(para("<<cs_claim.type>>a<<es_claim.type>>b<<cs_t>>c<<es_>>"), { ...data, claim: { type: true } })).toEqual(["abc"]);
  });

  it("rejects a repeat closed by a differently named end", async () => {
    expect((await fails(para("<<rs_items>>a<<es_other>>")))[0]).toContain("Mismatched sections");
  });

  it("rejects an end with no start and an else with no block", async () => {
    expect((await fails(para("a<<es_>>")))[0]).toContain('Unmatched ending tag "es_"');
    expect((await fails(para("a<<else>>")))[0]).toContain('Unmatched ending tag "else"');
  });

  it("rejects an unclosed block", async () => {
    expect((await fails(para("<<cs_t>>a")))[0]).toContain("Section not ended");
  });

  it("rejects a row tag outside a table, suggesting the section tag", async () => {
    const d = (await fails(para("<<cs_t>>a<<er_>>")))[0];
    expect(d).toContain("not inside a table");
    expect(d).toContain('Did you mean "es_"');
  });

  it("rejects rr_ and er_ in one table row", async () => {
    const t = table(row(cell(para("<<rr_items>>x")), cell(para("<<er_items>>"))));
    expect((await fails(t))[0]).toContain(`Tag "er_items" can't exist in the same table row as another "rr_xxx", "cr_xxx" or "er_xxx" tag.`);
  });

  it("rejects mismatched and unclosed row blocks", async () => {
    const mismatch = table(row(cell(para("<<rr_items>>"))), row(cell(para("x"))), row(cell(para("<<er_other>>"))));
    expect((await fails(mismatch))[0]).toContain("Mismatched sections");
    const open = table(row(cell(para("<<rr_items>>"))), row(cell(para("x"))));
    expect((await fails(open))[0]).toContain("Section not ended");
    const orphan = table(row(cell(para("<<er_>>"))));
    expect((await fails(orphan))[0]).toContain('Unmatched ending tag "er_"');
  });

  it("accepts a row else and tags inside nested blocks, text boxes and content controls", async () => {
    const t = table(row(cell(para("<<cr_t>>"))), row(cell(para("A"))), row(cell(para("<<else>>"))), row(cell(para("B"))), row(cell(para("<<er_>>"))));
    expect(await texts(t, data)).toEqual(["A", ""]);
    const box = `<w:r><w:pict><v:textbox><w:txbxContent>${para("<<es_>>")}</w:txbxContent></v:textbox></w:pict></w:r>`;
    expect((await fails(para("x", box)))[0]).toContain("Unmatched ending tag");
    const sdt = `<w:sdt><w:sdtContent>${para("<<es_>>")}</w:sdtContent></w:sdt>`;
    expect((await fails(sdt))[0]).toContain("Unmatched ending tag");
  });

  it("rejects an expression with a bracket that is never closed", async () => {
    expect((await fails(para("<<{toUpperCase(name}>>")))[0]).toContain("Function is not closed");
    expect(await texts(para("<<{toUpperCase(name)}>> <<{'(' + name}>> <<{‘(’}>>"), data)).toEqual(["N (N ("]);
  });

  it("marks each fault in devMode and leaves every tag as written", async () => {
    const out = await merge(para("<<name>>") + para("a<<es_x>>") + para("b<<es_>>"), data, dev);
    expect(paragraphs(out)).toEqual(["<<name>>", "<<analysis>>Docmosis1a<<es_x>>", "<<analysis>>Docmosis2b<<es_>>"]);
  });

  it("marks a row fault in front of the tag", async () => {
    const t = table(row(cell(para("<<rr_items>>a")), cell(para("b<<er_items>>"))));
    expect(paragraphs(await merge(t, data, dev))).toEqual(["<<rr_items>>a", "b<<analysis>>Docmosis1<<er_items>>"]);
  });

  it("describes a fault in a header in place", async () => {
    const out = await merge(para("x"), data, dev, { "word/header1.xml": header(para("<<es_>>")) });
    expect(paragraphs(out, "word/header1.xml")).toEqual(['<<analysis>>Unmatched ending tag "es_" <<es_>>']);
  });
});

describe("devMode failure format", () => {
  it("leaves the instruction, curly quotes straightened, followed by a number", async () => {
    const b = para("a<<{dateFormat(x,’d’,’f’)}>>b") + para("c<<{dateFormat(x,‘d’,‘f’)}>>");
    expect(await texts(b, { x: "2020-01-01" }, dev)).toEqual(["a<<{dateFormat(x,'d','f')}>>Docmosis1b", "c<<{dateFormat(x,'d','f')}>>Docmosis2"]);
  });

  it("does not number the faults in headers, which say what failed", async () => {
    const out = await merge(para("<<{dateFormat(x,'d','f')}>>"), { x: "2020-01-01" }, dev, {
      "word/header1.xml": header(para("<<{dateFormat(x,'d','f')}>>"))
    });
    expect(paragraphs(out)[0]).toBe("<<{dateFormat(x,'d','f')}>>Docmosis1");
    expect(paragraphs(out, "word/header1.xml")[0]).toMatch(/^<<\{dateFormat\(x,'d','f'\)\}>>Unable to evaluate field expression \[dateFormat\(x,'d','f'\)\]:/);
  });

  it("keeps a failed block condition as written", async () => {
    const out = await texts(para("<<cs_{dateFormat(x,‘d’,‘f’)}>>y<<es_>>"), { x: "2020-01-01" }, dev);
    expect(out[0]).toBe("<<dateFormat(x,‘d’,‘f’)>>Docmosis1");
  });

  it("still lists the messages for the non-devMode error", async () => {
    const err = await merge(para("<<{dateFormat(x,'d','f')}>>"), { x: "2020-01-01" }).catch((e: unknown) => e);
    expect((err as MergeError).details[0]).toContain("Unable to evaluate field expression [dateFormat(x,'d','f')]");
  });
});
