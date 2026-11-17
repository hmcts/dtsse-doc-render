import { describe, expect, it } from "vitest";
import { cell, cellParaCounts, entryNames, header, makeDocx, para, paragraphs, partXml, row, rows, run, table } from "../../test/helpers/docx.ts";
import { MergeError, mergeDocx } from "./index.ts";

const dev = { devMode: true };
const strict = { devMode: false };

async function merge(body: string, data: unknown, options = strict, extra: Record<string, string> = {}): Promise<Buffer> {
  return mergeDocx(makeDocx(body, extra), data, options);
}

const texts = async (body: string, data: unknown, options = strict): Promise<string[]> => paragraphs(await merge(body, data, options));

describe("fields", () => {
  it("joins a field split across three runs and keeps the first run's formatting", async () => {
    const body = para("Dear ", run("<<na", "<w:b/>"), run("me", "<w:i/>"), run(">>", '<w:u w:val="single"/>'), ", hello");
    const out = await merge(body, { name: "Alice" });
    expect(paragraphs(out)).toEqual(["Dear Alice, hello"]);
    const xml = partXml(out);
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Alice</w:t>');
    expect(xml).not.toContain("<<");
    expect(xml).toContain("<w:sectPr/>");
  });

  it("escapes values", async () => {
    const out = await merge(para("<<v>>"), { v: "A & B < C" });
    expect(partXml(out)).toContain("A &amp; B &lt; C");
    expect(paragraphs(out)).toEqual(["A & B < C"]);
  });

  it("writes missing values as nothing and keeps the paragraph", async () => {
    expect(await texts(para("a<<missing>>b"), {})).toEqual(["ab"]);
    expect(await texts(para("<<missing>>"), {})).toEqual([""]);
  });

  it("ends the paragraph at a newline in a value, as Docmosis does", async () => {
    const out = await merge(para("x <<v>> y"), { v: "one\ntwo" });
    expect(paragraphs(out)).toEqual(["x one", "two y"]);
  });

  it("reads dotted paths and ignores heading noise", async () => {
    expect(await texts(para("<<## 1.1 Heading ##>> <<a.b>>"), { a: { b: "deep" } })).toEqual(["<<## 1.1 Heading ##>> deep"]);
    expect(await texts(para("<<## unterminated <<a.b>>"), { a: { b: "x" } })).toEqual(["<<## unterminated x"]);
  });

  it("removes the whole paragraph that holds a comment, as Docmosis does", async () => {
    expect(await texts(para("a<</* note */>>b") + para("kept"), {})).toEqual(["kept"]);
  });

  it("removes the paragraph for a blank op: field", async () => {
    const body = para("keep") + para("<<op:v>>") + para("end");
    expect(await texts(body, { v: "" })).toEqual(["keep", "end"]);
    expect(await texts(body, { v: "yes" })).toEqual(["keep", "yes", "end"]);
    expect(await texts(para("a <<cs_x>>b<<es_>> <<op:v>>"), { x: true, v: "" })).toEqual([]);
  });

  it("evaluates a field in a header", async () => {
    const hdr = header(para("Ref: <<ref>>"));
    const out = await merge(para("body"), { ref: "R-1" }, strict, { "word/header1.xml": hdr });
    expect(paragraphs(out, "word/header1.xml")).toEqual(["Ref: R-1"]);
  });
});

describe("zip handling", () => {
  it("keeps entries, their order and unrelated bytes", async () => {
    const template = makeDocx(para("x"), { "word/media/a.png": "PNGDATA", "docProps/app.xml": "<a/>" });
    const out = await mergeDocx(template, {}, strict);
    expect(entryNames(out)).toEqual(entryNames(template));
    expect(entryNames(out)[0]).toBe("[Content_Types].xml");
  });

  it("rejects a file that is not a docx", async () => {
    await expect(mergeDocx(Buffer.from("nope"), {}, strict)).rejects.toBeInstanceOf(MergeError);
    const noDocument = Buffer.from((await import("fflate")).zipSync({ "a.txt": new Uint8Array([1]) }));
    await expect(mergeDocx(noDocument, {}, strict)).rejects.toThrow("not a valid .docx");
  });

  it("rejects malformed XML", async () => {
    const template = makeDocx("<w:p><w:r></w:p>");
    await expect(mergeDocx(template, {}, strict)).rejects.toBeInstanceOf(MergeError);
  });
});

describe("conditional sections", () => {
  const body = para("before") + para("<<cs_flag>>") + para("shown") + para("<<else>>") + para("hidden") + para("<<es_>>") + para("after");

  it("keeps the true branch and removes the marker paragraphs", async () => {
    expect(await texts(body, { flag: true })).toEqual(["before", "shown", "after"]);
  });

  it("keeps the else branch", async () => {
    expect(await texts(body, { flag: false })).toEqual(["before", "hidden", "after"]);
  });

  it("drops everything when false and there is no else", async () => {
    expect(await texts(para("<<cs_flag>>") + para("x") + para("<<es_>>") + para("y"), {})).toEqual(["y"]);
  });

  it("handles inline blocks", async () => {
    const b = para("Hello <<cs_flag>>big <<else>>small <<es_>>world");
    expect(await texts(b, { flag: true })).toEqual(["Hello big world"]);
    expect(await texts(b, { flag: false })).toEqual(["Hello small world"]);
  });

  it("handles inline blocks split across runs", async () => {
    const b = para(run("A <<c", "<w:b/>"), run("s_flag>>", "<w:i/>"), run("X", "<w:u/>"), run("<<es_", "<w:b/>"), run(">> Z"));
    expect(await texts(b, { flag: true })).toEqual(["A X Z"]);
    expect(await texts(b, { flag: false })).toEqual(["A Z"]);
  });

  it("keeps the text around a block spanning paragraphs with the markers in their text", async () => {
    const b = para("one <<cs_flag>>two") + para("three<<es_>> four");
    expect(await texts(b, { flag: true })).toEqual(["one two", "three", " four"]);
    expect(await texts(b, { flag: false })).toEqual(["one ", " four"]);
  });

  it("keeps drawings between inline markers only when the branch is kept", async () => {
    const drawing = "<w:r><w:drawing><wp:inline/></w:drawing></w:r>";
    const b = para("a<<cs_flag>>", drawing, "<<es_>>b");
    const kept = partXml(await merge(b, { flag: true }));
    const dropped = partXml(await merge(b, { flag: false }));
    expect(kept).toContain("<w:drawing>");
    expect(dropped).not.toContain("<w:drawing>");
  });

  it("nests to eleven levels", async () => {
    const depth = 11;
    let b = "";
    for (let i = 0; i < depth; i++) {
      b += para(`<<cs_a${i}>>`);
    }
    b += para("deep");
    for (let i = 0; i < depth; i++) {
      b += para("<<es_>>");
    }
    const all = Object.fromEntries(Array.from({ length: depth }, (_, i) => [`a${i}`, true]));
    expect(await texts(b, all)).toEqual(["deep"]);
    expect(await texts(b, { ...all, a10: false })).toEqual([]);
  });

  it("keeps a paragraph that was empty in the template", async () => {
    expect(await texts(para("") + para("<<cs_x>>") + para("t") + para("<<es_>>"), { x: true })).toEqual(["", "t"]);
  });

  it("keeps a paragraph carrying a section break", async () => {
    const sect = "<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>&lt;&lt;es_&gt;&gt;</w:t></w:r></w:p>";
    const out = await merge(para("<<cs_x>>y") + sect, { x: true });
    expect(partXml(out)).toContain("<w:sectPr/></w:pPr>");
  });
});

describe("repeats", () => {
  const items = [{ n: "a" }, { n: "b" }, { n: "c" }];

  it("repeats paragraphs per item", async () => {
    const b = para("<<rs_list>>") + para("Item <<n>>") + para("<<es_>>") + para("done");
    expect(await texts(b, { list: items })).toEqual(["Item a", "Item b", "Item c", "done"]);
    expect(await texts(b, { list: [] })).toEqual(["done"]);
    expect(await texts(b, {})).toEqual(["done"]);
  });

  it("treats a non-array truthy value as one item", async () => {
    const b = para("<<rs_one>>") + para("<<n>>") + para("<<es_>>");
    expect(await texts(b, { one: { n: "solo" } })).toEqual(["solo"]);
  });

  it("repeats inline and merges the iterations into one paragraph", async () => {
    const b = para("Names: <<rs_list>><<n>>, <<es_>>end");
    expect(await texts(b, { list: items })).toEqual(["Names: a, b, c, end"]);
    expect(await texts(b, { list: [] })).toEqual(["Names: end"]);
  });

  it("repeats a whole paragraph written as one inline block", async () => {
    expect(await texts(para("<<rs_list>>- <<n>><<es_>>"), { list: items })).toEqual(["- a- b- c"]);
  });

  it("nests cs_ inside rs_", async () => {
    const b = para("<<rs_list>>") + para("<<cs_on>>") + para("on <<n>>") + para("<<else>>") + para("off <<n>>") + para("<<es_>>") + para("<<es_>>");
    const data = {
      list: [
        { n: "a", on: true },
        { n: "b", on: false },
        { n: "c", on: true }
      ]
    };
    expect(await texts(b, data)).toEqual(["on a", "off b", "on c"]);
  });

  it("nests rs_ inside rs_", async () => {
    const b = para("<<rs_g>>") + para("G <<name>>") + para("<<rs_kids>>") + para("  k <<k>>") + para("<<es_>>") + para("<<es_>>");
    const data = {
      g: [
        { name: "x", kids: [{ k: 1 }, { k: 2 }] },
        { name: "y", kids: [{ k: 3 }] }
      ]
    };
    expect(await texts(b, data)).toEqual(["G x", "  k 1", "  k 2", "G y", "  k 3"]);
  });

  it("keeps an inline conditional working in each iteration", async () => {
    const b = para("<<rs_list>>") + para("x<<cs_on>>Y<<es_>>z <<n>>") + para("<<es_>>");
    const data = {
      list: [
        { n: 1, on: true },
        { n: 2, on: false },
        { n: 3, on: true }
      ]
    };
    expect(await texts(b, data)).toEqual(["xYz 1", "xz 2", "xYz 3"]);
  });

  it("repeats a table inside a repeat", async () => {
    const b = para("<<rs_list>>") + table(row(cell(para("<<n>>")))) + para("<<es_>>");
    expect(rows(await merge(b, { list: items }))).toEqual(["a", "b", "c"]);
  });
});

describe("table rows", () => {
  it("keeps or drops rows between cr_ and er_ and removes the marker rows", async () => {
    const b = table(row(cell(para("head"))), row(cell(para("<<cr_flag>>"))), row(cell(para("body"))), row(cell(para("<<er_>>"))), row(cell(para("foot"))));
    expect(rows(await merge(b, { flag: true }))).toEqual(["head", "body", "foot"]);
    expect(rows(await merge(b, { flag: false }))).toEqual(["head", "foot"]);
  });

  it("supports else between rows", async () => {
    const b = table(row(cell(para("<<cr_flag>>"))), row(cell(para("yes"))), row(cell(para("<<else>>"))), row(cell(para("no"))), row(cell(para("<<er_>>"))));
    expect(rows(await merge(b, { flag: true }))).toEqual(["yes"]);
    expect(rows(await merge(b, { flag: false }))).toEqual(["no"]);
  });

  it("repeats rows with rr_ and er_", async () => {
    const b = table(
      row(cell(para("Name"), para("")), cell(para("Age"))),
      row(cell(para("<<rr_people>>")), cell(para(""))),
      row(cell(para("<<n>>")), cell(para("<<age>>"))),
      row(cell(para("<<er_>>")), cell(para("")))
    );
    const data = {
      people: [
        { n: "A", age: 1 },
        { n: "B", age: 2 }
      ]
    };
    expect(rows(await merge(b, data))).toEqual(["Name/ | Age", "A | 1", "B | 2"]);
    expect(rows(await merge(b, { people: [] }))).toEqual(["Name/ | Age"]);
  });

  it("keeps a marker row that carries other content, with the marker removed", async () => {
    const b = table(row(cell(para("<<rr_list>>")), cell(para("<<n>>"))), row(cell(para("<<er_>>")), cell(para("end <<n>>"))));
    expect(rows(await merge(b, { list: [{ n: "a" }, { n: "b" }] }))).toEqual([" | a", " | end a", " | b", " | end b"]);
  });

  it("drops a table whose rows are all removed", async () => {
    const b = para("p") + table(row(cell(para("<<cr_x>>"))), row(cell(para("r"))), row(cell(para("<<er_>>")))) + para("q");
    const out = await merge(b, {});
    expect(partXml(out)).not.toContain("<w:tbl>");
    expect(paragraphs(out)).toEqual(["p", "q"]);
  });

  it("applies cs_ and rs_ inside a cell", async () => {
    const b = table(row(cell(para("<<cs_x>>"), para("in"), para("<<es_>>")), cell(para("<<rs_l>>"), para("<<n>>"), para("<<es_>>"))));
    expect(rows(await merge(b, { x: true, l: [{ n: 1 }, { n: 2 }] }))).toEqual(["in | 1/2"]);
  });

  it("leaves an empty paragraph when removal empties a cell", async () => {
    const b = table(row(cell(para("<<cs_x>>"), para("gone"), para("<<es_>>")), cell(para("keep"))));
    const out = await merge(b, { x: false });
    expect(rows(out)).toEqual([" | keep"]);
    expect(cellParaCounts(out)).toEqual([1, 1]);
  });

  it("repeats nested tables inside rows", async () => {
    const inner = table(row(cell(para("<<rr_k>>"))), row(cell(para("<<v>>"))), row(cell(para("<<er_>>"))));
    const outer = table(row(cell(para("<<rr_g>>"))), row(cell(para("<<name>>"), inner)), row(cell(para("<<er_>>"))));
    const data = {
      g: [
        { name: "x", k: [{ v: 1 }, { v: 2 }] },
        { name: "y", k: [{ v: 3 }] }
      ]
    };
    expect(paragraphs(await merge(outer, data))).toEqual(["x", "1", "2", "", "y", "3", ""]);
  });
});

describe("errors", () => {
  it("throws a MergeError naming each instruction and its location when not in devMode", async () => {
    const b = para("ok") + para("<<es_>>") + para("<<cs_never>>closing missing");
    const err = await merge(b, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeError);
    expect((err as MergeError).message).toBe("Template merge failed");
    const details = (err as MergeError).details;
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('Unmatched ending tag "es_"');
    expect(details[0]).toContain("word/document.xml");
    expect(details[0]).toContain("paragraph 2");
  });

  it("names the unclosed section when nothing else is wrong", async () => {
    const err = await merge(para("<<cs_never>>closing missing"), {}).catch((e: unknown) => e);
    expect((err as MergeError).details[0]).toContain("Section not ended. Name: cs_never");
  });

  it("leaves the template text alone and marks the fault in devMode", async () => {
    const out = await merge(para("<<v>> a <<es_>> b"), { v: "x" }, dev);
    expect(paragraphs(out)).toEqual(["<<analysis>>Docmosis1<<v>> a <<es_>> b"]);
  });

  it("marks an unclosed block in front of its tag in devMode", async () => {
    const out = await merge(para("B<<cs_x>>") + para("t"), {}, dev);
    expect(paragraphs(out)).toEqual(["B<<analysis>>Docmosis1<<cs_x>>", "t"]);
  });

  it("reports else outside a block and row markers outside a table", async () => {
    const out = await merge(para("<<else>>") + para("<<er_>>") + para("<<rr_x>>"), {}, dev);
    expect(paragraphs(out)).toEqual(["<<analysis>>Docmosis1<<else>>", "<<analysis>>Docmosis2<<er_>>", "<<analysis>>Docmosis3<<rr_x>>"]);
    const err = await merge(para("<<er_>>"), {}).catch((e: unknown) => e);
    expect((err as MergeError).details[0]).toContain("not inside a table");
  });

  it("reports an unterminated <<", async () => {
    await expect(merge(para("a <<oops"), {})).rejects.toThrow("Template merge failed");
    expect(await texts(para("a <<oops"), {}, dev)).toEqual(["a <<oops"]);
  });

  it("reports a row block with no closing row", async () => {
    const err = await merge(table(row(cell(para("<<cr_x>>"))), row(cell(para("r")))), {}).catch((e: unknown) => e);
    expect((err as MergeError).details[0]).toContain("Section not ended");
    expect((err as MergeError).details[0]).toContain("cr_x");
  });

  it("collects errors across headers", async () => {
    const hdr = header(para("<<es_>>"));
    const err = await merge(para("<<es_>>"), {}, strict, { "word/header1.xml": hdr }).catch((e: unknown) => e);
    expect((err as MergeError).details).toHaveLength(2);
    expect((err as MergeError).details[1]).toContain("word/header1.xml");
  });
});

describe("text boxes", () => {
  it("renders paragraphs inside a text box", async () => {
    const box = `<w:r><w:pict><v:textbox><w:txbxContent>${para("<<cs_x>>")}${para("boxed <<v>>")}${para("<<es_>>")}</w:txbxContent></v:textbox></w:pict></w:r>`;
    const out = await merge(para("outer ", box), { x: true, v: "!" });
    expect(partXml(out)).toContain("boxed !");
    expect(partXml(out)).not.toContain("<<");
  });

  it("renders a block-level content control", async () => {
    const sdt = `<w:sdt><w:sdtContent>${para("<<v>>")}</w:sdtContent></w:sdt>`;
    expect(paragraphs(await merge(sdt, { v: "inside" }))).toEqual(["inside"]);
  });
});

describe("performance", () => {
  it("merges thousands of instructions in a large document quickly", async () => {
    let b = "";
    for (let i = 0; i < 4000; i++) {
      b += para(`Row ${i} <<v>> `, run("<<w", "<w:b/>"), run(">>"));
    }
    const started = Date.now();
    const out = await merge(b, { v: "x", w: "y" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(paragraphs(out)[3999]).toBe("Row 3999 x y");
  });
});
