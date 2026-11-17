import { describe, expect, it } from "vitest";
import { entryNames, makeDocx, partXml } from "../../test/helpers/docx.ts";
import { mergeDocx } from "./index.ts";

const SVG_EXT = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="s" r:embed="rId4"/></a:ext></a:extLst>';
const picture = (png: string, svg = SVG_EXT): string =>
  `<w:p><w:r><w:drawing><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${png}">${svg}</a:blip></pic:blipFill></pic:pic></a:graphicData></a:graphic></w:drawing></w:r></w:p>`;

const rels = (...targets: [string, string][]): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets.map(([id, target]) => `<Relationship Id="${id}" Type="image" Target="${target}"/>`).join("")}</Relationships>`;

const withMedia = (body: string, relationships: string, extra: Record<string, string> = {}): Promise<Buffer> =>
  mergeDocx(
    makeDocx(body, { "word/_rels/document.xml.rels": relationships, "word/media/image1.png": "png", "word/media/image2.svg": "<svg/>", ...extra }),
    {},
    { devMode: false }
  );

describe("SVG alternatives", () => {
  it("drops the SVG extension of a picture, as Docmosis's LibreOffice does, and the SVG part and relationship with it", async () => {
    const out = await withMedia(picture("rId3"), rels(["rId3", "media/image1.png"], ["rId4", "media/image2.svg"]));
    expect(partXml(out)).not.toContain("svgBlip");
    expect(partXml(out)).not.toContain("extLst");
    expect(partXml(out)).toContain('<a:blip r:embed="rId3">');
    expect(partXml(out, "word/_rels/document.xml.rels")).not.toContain("svg");
    expect(partXml(out, "word/_rels/document.xml.rels")).toContain("image1.png");
    expect(entryNames(out)).not.toContain("word/media/image2.svg");
    expect(entryNames(out)).toContain("word/media/image1.png");
  });

  it("keeps an extension that is not the SVG one", async () => {
    const other = '<a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"><a14:useLocalDpi val="0"/></a:ext></a:extLst>';
    const out = await withMedia(picture("rId3", other), rels(["rId3", "media/image1.png"]));
    expect(partXml(out)).toContain("useLocalDpi");
  });

  it("keeps an SVG that a picture still refers to", async () => {
    const svgOnly =
      '<w:p><w:r><w:drawing><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></w:drawing></w:r></w:p>';
    const out = await withMedia(picture("rId3") + svgOnly, rels(["rId3", "media/image1.png"], ["rId4", "media/image2.svg"]));
    expect(partXml(out)).not.toContain("svgBlip");
    expect(partXml(out, "word/_rels/document.xml.rels")).toContain("image2.svg");
    expect(entryNames(out)).toContain("word/media/image2.svg");
  });

  it("leaves a document without an SVG alone", async () => {
    const out = await withMedia(picture("rId3", ""), rels(["rId3", "media/image1.png"]));
    expect(partXml(out)).toContain('<a:blip r:embed="rId3">');
  });
});
