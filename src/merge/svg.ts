import { strFromU8, strToU8 } from "fflate";

/**
 * Word stores an SVG picture as a PNG with the SVG beside it in an `a:extLst` extension. Docmosis's LibreOffice does not
 * read the extension and draws the PNG, and the document it writes has the PNG only, while a newer LibreOffice draws the
 * SVG as vector paths and the page ends up with no picture in it. So the extension goes, and the SVG parts with it once
 * nothing refers to them.
 */

const SVG_EXTENSION = /<a:ext\s+uri="\{96DAC541-7B7A-43D3-8B79-37D633B846F1\}">[\s\S]*?<\/a:ext>/g;
const EMPTY_LIST = /<a:extLst>\s*<\/a:extLst>/g;
const RELATIONSHIP = /<Relationship\s[^>]*\/>/g;

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

const relsOf = (part: string): string => part.replace(/([^/]+)$/, "_rels/$1.rels");

export function dropSvgAlternatives(entries: Record<string, Uint8Array>, rendered: Map<string, Uint8Array>): void {
  const touched: string[] = [];
  for (const [part, bytes] of rendered) {
    const xml = strFromU8(bytes);
    if (!xml.includes("svgBlip")) {
      continue;
    }
    rendered.set(part, strToU8(xml.replace(SVG_EXTENSION, "").replace(EMPTY_LIST, "")));
    touched.push(part);
  }
  for (const part of touched) {
    const rels = relsOf(part);
    const original = entries[rels];
    if (!original) {
      continue;
    }
    const xml = strFromU8(rendered.get(part)!);
    const kept = strFromU8(original).replace(RELATIONSHIP, (tag) => {
      const target = attr(tag, "Target") ?? "";
      const id = attr(tag, "Id") ?? "";
      return /\.svg$/i.test(target) && !xml.includes(`"${id}"`) ? "" : tag;
    });
    entries[rels] = strToU8(kept);
  }
  const referenced = new Set<string>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith(".rels")) {
      for (const tag of strFromU8(bytes).match(RELATIONSHIP) ?? []) {
        referenced.add((attr(tag, "Target") ?? "").replace(/^.*\//, ""));
      }
    }
  }
  for (const name of Object.keys(entries)) {
    if (/^word\/media\/[^/]+\.svg$/i.test(name) && !referenced.has(name.replace(/^.*\//, ""))) {
      delete entries[name];
    }
  }
}
