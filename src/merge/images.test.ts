import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { header, makeDocx, para, paragraphs, partXml } from "../../test/helpers/docx.ts";
import { MergeError, mergeDocx } from "./index.ts";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function png(width: number, height: number): Buffer {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b);
  b.writeUInt16BE(height, 13);
  b.writeUInt16BE(width, 15);
  return b;
}

function jpegWithPadding(width: number, height: number): Buffer {
  const b = jpeg(width, height);
  return Buffer.concat([b.subarray(0, 2), Buffer.from([0x00, 0xff, 0xff, 0xff, 0xd0, 0xff, 0x00]), b.subarray(2)]);
}

function bmp(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("BM");
  b.writeInt32LE(width, 18);
  b.writeInt32LE(-height, 22);
  return b;
}

const field = (data: Buffer): string => `image:base64:${data.toString("base64")}`;
const EMU = 635;

const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const rels = (...ids: [string, string][]): string =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids
    .map(([id, target]) => `<Relationship Id="${id}" Type="${IMAGE_REL}" Target="${target}"/>`)
    .join("")}</Relationships>`;

function drawing(opts: { name?: string; rid?: string; cx?: number; cy?: number; anchor?: boolean; crop?: boolean } = {}): string {
  const { name = "Picture 1", rid = "rId5", cx = 1800000, cy = 900000, anchor = false, crop = false } = opts;
  const tag = anchor ? "wp:anchor" : "wp:inline";
  return (
    `<w:r><w:drawing><${tag}><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="${name}"/>` +
    `<a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x.png"/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/>${crop ? '<a:srcRect l="10"/>' : ""}</pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></${tag}></w:drawing></w:r>`
  );
}

const marked = (bookmark: string, inner: string, id = 1): string =>
  `<w:p><w:bookmarkStart w:id="${id}" w:name="${bookmark}"/>${inner}<w:bookmarkEnd w:id="${id}"/></w:p>`;

function withMedia(body: string, extra: Record<string, string> = {}, media: Record<string, Buffer> = { "word/media/image1.png": PNG_1X1 }): Buffer {
  const base = makeDocx(body, { "word/_rels/document.xml.rels": rels(["rId5", "media/image1.png"]), ...extra });
  const files = unzipSync(new Uint8Array(base));
  for (const [name, bytes] of Object.entries(media)) {
    files[name] = new Uint8Array(bytes);
  }
  return Buffer.from(zipSync(files));
}

const files = (docx: Buffer): Record<string, Uint8Array> => unzipSync(new Uint8Array(docx));
const extents = (docx: Buffer, name = "word/document.xml"): string[] =>
  [...partXml(docx, name).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => `${m[1]}x${m[2]}`);
const media = (docx: Buffer): string[] => Object.keys(files(docx)).filter((n) => n.startsWith("word/media/"));
const embeds = (docx: Buffer, name = "word/document.xml"): string[] => [...partXml(docx, name).matchAll(/r:embed="([^"]*)"/g)].map((m) => m[1]!);
const strict = { devMode: false };
const dev = { devMode: true };
const twips = (emu: number): number => Math.round(emu / EMU) * EMU;

describe("image placeholders", () => {
  it("fits an imgfit_ picture inside the placeholder at the new picture's proportions", async () => {
    const template = withMedia(para("before") + marked("imgfit_logo", drawing()) + para("after"));
    const wide = await mergeDocx(template, { logo: field(png(60, 15)) }, strict);
    expect(extents(wide)).toEqual([`${twips(1800000)}x${twips(450000)}`]);
    const tall = await mergeDocx(template, { logo: field(png(15, 60)) }, strict);
    expect(extents(tall)).toEqual([`${twips(225000)}x${twips(900000)}`]);
    const square = await mergeDocx(template, { logo: field(png(30, 30)) }, strict);
    expect(extents(square)).toEqual([`${twips(900000)}x${twips(900000)}`]);
    expect(paragraphs(wide)).toEqual(["before", "", "after"]);
  });

  it("swaps the media part, its relationship and the content type, and drops the old picture", async () => {
    const template = withMedia(marked("imgfit_logo", drawing()));
    const out = await mergeDocx(template, { logo: field(GIF_1X1) }, strict);
    expect(media(out)).toEqual(["word/media/dr-image1.gif"]);
    expect(Buffer.from(files(out)["word/media/dr-image1.gif"]!)).toEqual(GIF_1X1);
    expect(embeds(out)).toEqual(["rIdDr1"]);
    const relXml = partXml(out, "word/_rels/document.xml.rels");
    expect(relXml).toContain('Id="rIdDr1"');
    expect(relXml).toContain('Target="media/dr-image1.gif"');
    expect(relXml).not.toContain("rId5");
    expect(partXml(out, "[Content_Types].xml")).toContain('<Default Extension="gif" ContentType="image/gif"/>');
  });

  it("does not repeat a content type the package already declares", async () => {
    const types =
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>';
    const out = await mergeDocx(withMedia(marked("imgfit_logo", drawing()), { "[Content_Types].xml": types }), { logo: field(png(2, 1)) }, strict);
    expect(partXml(out, "[Content_Types].xml").match(/Extension="png"/g)).toHaveLength(1);
  });

  it("stretches an img_ picture to the placeholder's size whatever its proportions", async () => {
    const out = await mergeDocx(withMedia(marked("img_logo", drawing())), { logo: field(png(60, 15)) }, strict);
    expect(extents(out)).toEqual([`${twips(1800000)}x${twips(900000)}`]);
    expect(partXml(out)).toContain(`<a:ext cx="${twips(1800000)}" cy="${twips(900000)}"/>`);
  });

  it("reads the size of jpeg and bmp pictures", async () => {
    const template = withMedia(marked("imgfit_logo", drawing()));
    const j = await mergeDocx(template, { logo: field(jpeg(20, 10)) }, strict);
    expect(media(j)).toEqual(["word/media/dr-image1.jpeg"]);
    expect(extents(j)).toEqual([`${twips(1800000)}x${twips(900000)}`]);
    expect(partXml(j, "[Content_Types].xml")).toContain('Extension="jpeg"');
    const padded = await mergeDocx(template, { logo: field(jpegWithPadding(10, 20)) }, strict);
    expect(extents(padded)).toEqual([`${twips(450000)}x${twips(900000)}`]);
    const b = await mergeDocx(template, { logo: field(bmp(10, 20)) }, strict);
    expect(media(b)).toEqual(["word/media/dr-image1.bmp"]);
    expect(extents(b)).toEqual([`${twips(450000)}x${twips(900000)}`]);
  });

  it("treats a picture whose docPr name is a placeholder name as one", async () => {
    const template = withMedia(para("a") + `<w:p>${drawing({ name: "imgfit_logo" })}</w:p>`);
    const out = await mergeDocx(template, { logo: field(png(60, 15)) }, strict);
    expect(extents(out)).toEqual([`${twips(1800000)}x${twips(450000)}`]);
    const none = await mergeDocx(template, {}, strict);
    expect(extents(none)).toEqual([]);
  });

  it("looks up a dotted field and an anchored picture", async () => {
    const template = withMedia(marked("imgfit_a", drawing({ anchor: true, crop: true })) + `<w:p>${drawing({ name: "imgfit_a.b.c" })}</w:p>`);
    const out = await mergeDocx(template, { a: field(png(60, 15)), "a.b.c": 1 }, strict);
    expect(extents(out)).toEqual([`${twips(1800000)}x${twips(450000)}`]);
    expect(partXml(out)).not.toContain("a:srcRect");
    const nested = await mergeDocx(withMedia(`<w:p>${drawing({ name: "imgfit_a.b.c" })}</w:p>`), { a: { b: { c: field(png(15, 60)) } } }, strict);
    expect(extents(nested)).toEqual([`${twips(225000)}x${twips(900000)}`]);
  });

  it("removes the picture, its relationship and its media when there is no usable value", async () => {
    const template = withMedia(para("before") + marked("imgfit_logo", drawing()) + para("after"));
    const values: unknown[] = [undefined, null, "", 5, "no prefix", "image:other:AAAA", `${PNG_1X1.toString("base64")}`];
    for (const logo of values) {
      const out = await mergeDocx(template, { logo }, strict);
      expect(extents(out)).toEqual([]);
      expect(media(out)).toEqual([]);
      expect(partXml(out, "word/_rels/document.xml.rels")).not.toContain("Relationship ");
      expect(paragraphs(out)).toEqual(["before", "", "after"]);
    }
  });

  it("keeps the text next to a picture and a media part another picture still uses", async () => {
    const body = marked("img_a", `<w:r><w:t>TEXT</w:t></w:r>${drawing()}`, 1) + `<w:p>${drawing({ name: "Other" })}</w:p>`;
    const out = await mergeDocx(withMedia(body), {}, strict);
    expect(paragraphs(out)).toEqual(["TEXT", ""]);
    expect(extents(out)).toEqual(["1800000x900000"]);
    expect(media(out)).toEqual(["word/media/image1.png"]);
    expect(partXml(out, "word/_rels/document.xml.rels")).toContain('Id="rId5"');
  });

  it("finds the picture just before an empty bookmark, and a bookmark that spans paragraphs", async () => {
    const before = withMedia(`<w:p>${drawing()}<w:bookmarkStart w:id="1" w:name="imgfit_logo"/><w:bookmarkEnd w:id="1"/><w:r><w:t>tail</w:t></w:r></w:p>`);
    expect(extents(await mergeDocx(before, { logo: field(png(60, 15)) }, strict))).toEqual([`${twips(1800000)}x${twips(450000)}`]);
    expect(extents(await mergeDocx(before, {}, strict))).toEqual([]);
    const spanning = withMedia(
      `<w:p><w:bookmarkStart w:id="1" w:name="imgfit_logo"/>${drawing()}</w:p><w:p><w:r><w:t>p2</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`
    );
    expect(extents(await mergeDocx(spanning, {}, strict))).toEqual([]);
  });

  it("takes a floating picture after an empty bookmark, but not an inline one", async () => {
    const empty = '<w:bookmarkStart w:id="1" w:name="imgfit_logo"/><w:bookmarkEnd w:id="1"/>';
    const floating = withMedia(`<w:p><w:r><w:t>x</w:t></w:r>${empty}${drawing({ anchor: true })}</w:p>`);
    expect(extents(await mergeDocx(floating, {}, strict))).toEqual([]);
    expect(extents(await mergeDocx(floating, { logo: field(png(60, 15)) }, strict))).toEqual([`${twips(1800000)}x${twips(450000)}`]);
    const inline = withMedia(`<w:p>${empty}${drawing()}</w:p>`);
    expect(extents(await mergeDocx(inline, {}, strict))).toEqual(["1800000x900000"]);
  });

  it("leaves a picture alone when nothing names it as a placeholder", async () => {
    const cases = [
      marked("image_logo", drawing()),
      marked("IMGFIT_logo", drawing()),
      marked("imgfit_", drawing()),
      marked("imgfit_a b", drawing()),
      marked("imgfit_$x", drawing()),
      marked("other", drawing()),
      marked("imgfit_logo", "<w:r><w:t>only text</w:t></w:r>"),
      `<w:p><w:bookmarkStart w:id="1" w:name="imgfit_logo"/><w:bookmarkEnd w:id="1"/>${drawing()}</w:p>`,
      marked("imgfit_logo", drawing() + drawing({ name: "P2" })),
      `<w:p><w:bookmarkStart/><w:bookmarkEnd/>${drawing()}</w:p>`,
      `<w:p>${drawing()}</w:p><w:p><w:bookmarkStart w:id="1" w:name="imgfit_logo"/><w:bookmarkEnd w:id="1"/></w:p>`,
      `<w:p><w:bookmarkStart w:id="1" w:name="imgfit_logo"/>${drawing()}</w:p>`.replace('<w:bookmarkStart w:id="1" w:name="imgfit_logo"/>', ""),
      `<w:p>${drawing({ name: "Picture imgfit_logo" })}</w:p>`
    ];
    for (const body of cases) {
      const out = await mergeDocx(withMedia(body), { logo: field(png(60, 15)), x: 1 }, strict);
      expect(media(out)).toEqual(["word/media/image1.png"]);
      expect(partXml(out).includes("<w:drawing>")).toBe(body.includes("<w:drawing>"));
      expect(embeds(out)).toEqual(body.includes("<w:drawing>") ? expect.arrayContaining(["rId5"]) : []);
    }
  });

  it("leaves a placeholder with no relationship or size alone, and drops it for no data", async () => {
    const noBlip = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="imgfit_logo"/></wp:inline></w:drawing></w:r></w:p>`;
    const out = await mergeDocx(withMedia(noBlip), { logo: field(png(2, 2)) }, strict);
    expect(partXml(out)).not.toContain("<w:drawing>");
    const noExtent = `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="imgfit_logo"/><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></wp:inline></w:drawing></w:r></w:p>`;
    const dropped = await mergeDocx(withMedia(noExtent), { logo: field(png(2, 2)) }, strict);
    expect(partXml(dropped)).not.toContain("<w:drawing>");
    expect(media(dropped)).toEqual([]);
    const zero = await mergeDocx(withMedia(marked("imgfit_logo", drawing())), { logo: field(png(0, 0)) }, strict);
    expect(extents(zero)).toEqual([]);
  });

  it("replaces a picture in a header through the header's own relationships", async () => {
    const hdr = header(`<w:p><w:bookmarkStart w:id="1" w:name="imgfit_logo"/>${drawing({ rid: "rId1" })}<w:bookmarkEnd w:id="1"/></w:p>`);
    const template = withMedia(
      para("body"),
      {
        "word/header1.xml": hdr.replace("<w:hdr ", '<w:hdr xmlns:wp="w" xmlns:a="a" xmlns:pic="p" xmlns:r="r" '),
        "word/_rels/header1.xml.rels": rels(["rId1", "media/head.png"])
      },
      {
        "word/media/head.png": PNG_1X1,
        "word/media/image1.png": PNG_1X1
      }
    );
    const out = await mergeDocx(template, { logo: field(png(2, 1)) }, strict);
    expect(extents(out, "word/header1.xml")).toEqual([`${twips(1800000)}x${twips(900000)}`]);
    expect(embeds(out, "word/header1.xml")).toEqual(["rIdDr1"]);
    expect(partXml(out, "word/_rels/header1.xml.rels")).toContain('Target="media/dr-image1.png"');
    expect(media(out).sort()).toEqual(["word/media/dr-image1.png", "word/media/image1.png"]);
    const gone = await mergeDocx(template, {}, strict);
    expect(media(gone)).toEqual(["word/media/image1.png"]);
    expect(partXml(gone, "word/_rels/header1.xml.rels")).not.toContain("head.png");
  });

  it("creates a relationships part for a part that had none", async () => {
    const hdr = header(`<w:p>${drawing({ name: "imgfit_logo", rid: "rId1" })}</w:p>`).replace(
      "<w:hdr ",
      '<w:hdr xmlns:wp="w" xmlns:a="a" xmlns:pic="p" xmlns:r="r" '
    );
    const out = await mergeDocx(withMedia(para("body"), { "word/header1.xml": hdr }), { logo: field(png(2, 1)) }, strict);
    expect(partXml(out, "word/_rels/header1.xml.rels")).toContain('Target="media/dr-image1.png"');
  });

  it("fails on data that is not a picture, marking it in devMode", async () => {
    const template = withMedia(para("before") + marked("imgfit_logo", drawing()) + para("after"));
    const data = { logo: "image:base64:AAAA" };
    const err = await mergeDocx(template, data, strict).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeError);
    expect((err as MergeError).details[0]).toContain("Field <<logo>> Unable to get image properties for image");
    const out = await mergeDocx(template, data, dev);
    expect(paragraphs(out)).toEqual(["before", "<<logo>>Docmosis1", "after"]);
    expect(extents(out)).toEqual([]);
  });

  it("states the reason in place in a header", async () => {
    const hdr = header(`<w:p>${drawing({ name: "imgfit_logo", rid: "rId1" })}</w:p>`).replace(
      "<w:hdr ",
      '<w:hdr xmlns:wp="w" xmlns:a="a" xmlns:pic="p" xmlns:r="r" '
    );
    const out = await mergeDocx(withMedia(para("body"), { "word/header1.xml": hdr }), { logo: "image:base64:AAAA" }, dev);
    expect(paragraphs(out, "word/header1.xml")[0]).toContain("<<logo>>Unable to get image properties");
  });

  it("resolves a header's relationship written as an absolute or a parent-relative path", async () => {
    const wrap = (rid: string): string =>
      header(`<w:p>${drawing({ name: "imgfit_logo", rid })}</w:p>`).replace("<w:hdr ", '<w:hdr xmlns:wp="w" xmlns:a="a" xmlns:pic="p" xmlns:r="r" ');
    for (const target of ["/word/media/head.png", "../word/media/head.png", "./media/head.png"]) {
      const template = withMedia(
        para("body"),
        { "word/header1.xml": wrap("rId1"), "word/_rels/header1.xml.rels": rels(["rId1", target]) },
        { "word/media/head.png": PNG_1X1 }
      );
      expect(media(await mergeDocx(template, {}, strict))).toEqual([]);
    }
  });

  it("fails on a jpeg with no frame header and on a picture cut short", async () => {
    const template = withMedia(marked("imgfit_logo", drawing()));
    for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]), PNG_1X1.subarray(0, 20), Buffer.from("not a picture at all")]) {
      const err = await mergeDocx(template, { logo: field(bytes) }, strict).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MergeError);
    }
  });

  it("does nothing to a part with an analysis fault", async () => {
    const out = await mergeDocx(withMedia(para("<<cs_x>>") + marked("imgfit_logo", drawing())), { logo: field(png(2, 1)) }, dev);
    expect(media(out)).toEqual(["word/media/image1.png"]);
  });

  it("ignores a field that is not in the data, and a package with no content types part", async () => {
    const out = await mergeDocx(withMedia(marked("imgfit_a.b", drawing())), { a: "text" }, strict);
    expect(extents(out)).toEqual([]);
    const base = files(withMedia(marked("imgfit_logo", drawing())));
    delete base["[Content_Types].xml"];
    const bare = await mergeDocx(Buffer.from(zipSync(base)), { logo: field(png(2, 1)) }, strict);
    expect(Object.keys(files(bare))).not.toContain("[Content_Types].xml");
  });
});
