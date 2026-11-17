import { strFromU8, strToU8 } from "fflate";
import type { Limits } from "./limits.ts";
import { childEls, cloneEl, makeEl, parseXml, serializeXml, type XEl, type XNode } from "./xml.ts";
import { type ArchiveTally, DocxFormatError, unzipWithin } from "./zip.ts";

/** An included template cannot be merged into the one that calls it. The message says why. */
export class IncludeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncludeError";
  }
}

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_TYPE = `${REL_NS}/`;
const STYLES_TYPE = `${REL_NS}/styles`;
const NUMBERING_TYPE = `${REL_NS}/numbering`;
const STYLES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const NUMBERING_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOC_PATH = "word/document.xml";
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
  svg: "image/svg+xml"
};
const UNSUPPORTED_ELEMENTS = new Set(["w:footnoteReference", "w:endnoteReference", "w:commentReference", "w:commentRangeStart", "w:altChunk", "w:subDoc"]);
const STYLE_REFS = new Set(["w:pStyle", "w:rStyle", "w:tblStyle"]);

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function attr(open: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(open);
  return m ? (m[1] ?? m[2]) : undefined;
}

function setAttr(open: string, name: string, value: string): string {
  return open.replace(new RegExp(`(\\s${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)(?:"[^"]*"|'[^']*')`), `$1"${value}"`);
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function parseRels(xml: string): Rel[] {
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].flatMap((m) => {
    const id = attr(m[0], "Id");
    const type = attr(m[0], "Type");
    const target = attr(m[0], "Target");
    return id && type && target !== undefined ? [{ id, type, target, external: attr(m[0], "TargetMode") === "External" }] : [];
  });
}

function namespaces(open: string): Map<string, string> {
  return new Map([...open.matchAll(/\sxmlns:([\w.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

const shortType = (type: string): string => (type.startsWith(REL_TYPE) ? type.slice(REL_TYPE.length) : type);

function elementOf(xml: string): XEl {
  const el = childEls(parseXml(xml))[0]!;
  el.parent = null;
  return el;
}

const walk = (el: XEl, visit: (e: XEl) => void, skip?: string): void => {
  for (const c of el.children) {
    if (c.kind === "el" && !c.dead && c.name !== skip) {
      visit(c);
      walk(c, visit, skip);
    }
  }
};

function countNodes(nodes: XNode[]): number {
  let n = 0;
  const visit = (node: XNode): void => {
    n++;
    if (node.kind === "el") {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return n;
}

/** An unzipped included template with its document, styles and numbering parsed on first use. */
class IncludeDoc {
  readonly entries: Record<string, Uint8Array>;
  readonly rels: Rel[];
  readonly body: XEl;
  readonly ns: Map<string, string>;
  readonly relPrefix: string | undefined;
  readonly styles = new Map<string, XEl>();
  styleOrder: string[] = [];
  docDefaults = "";
  defaultParagraph: string | undefined;
  numbering: XEl | null = null;
  readonly contentTypes: string;
  /** Style, numbering and media imports are made once per include however often it is called. */
  styleMap: Map<string, string> | null = null;
  defaultStyle: string | undefined;
  numberMap: Map<string, string> | null = null;
  readonly media = new Map<string, string>();

  constructor(
    readonly name: string,
    readonly ordinal: number,
    entries: Record<string, Uint8Array>
  ) {
    this.entries = entries;
    const text = (path: string): string | undefined => (entries[path] ? strFromU8(entries[path]) : undefined);
    const xml = text(DOC_PATH);
    if (xml === undefined) {
      throw new IncludeError(`${name} is not a .docx: it has no word/document.xml`);
    }
    const root = childEls(parseXml(xml))[0];
    const body = root ? childEls(root, "w:body")[0] : undefined;
    if (!root || !body) {
      throw new IncludeError(`${name} has no document body`);
    }
    this.body = body;
    this.ns = namespaces(root.open);
    this.relPrefix = [...this.ns].find(([, uri]) => uri === REL_NS)?.[0];
    this.rels = parseRels(text("word/_rels/document.xml.rels") ?? "");
    this.contentTypes = text("[Content_Types].xml") ?? "";
    const styles = text("word/styles.xml");
    if (styles) {
      const stylesRoot = childEls(parseXml(styles))[0];
      for (const el of stylesRoot ? childEls(stylesRoot) : []) {
        if (el.name === "w:docDefaults") {
          this.docDefaults = serializeXml(el);
        } else if (el.name === "w:style") {
          const id = attr(el.open, "w:styleId");
          if (id) {
            this.styles.set(id, el);
            this.styleOrder.push(id);
            if (attr(el.open, "w:type") === "paragraph" && attr(el.open, "w:default") === "1") {
              this.defaultParagraph = id;
            }
          }
        }
      }
    }
    const numbering = text("word/numbering.xml");
    if (numbering) {
      this.numbering = childEls(parseXml(numbering))[0] ?? null;
    }
  }
}

interface Used {
  styles: Set<string>;
  numbers: Set<string>;
  rels: Set<string>;
  paragraphs: boolean;
}

const hash8 = (text: string): string => {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0");
};

/**
 * Brings the content of an included template into the one being merged: its relationships (images, hyperlinks), styles
 * and numbering are copied across under new ids, so the included paragraphs keep their look. Headers, footers and
 * section properties of the include are dropped, as in Docmosis, and so is anything this cannot copy faithfully:
 * those includes fail with an IncludeError rather than yielding a damaged document.
 */
export class IncludeHost {
  private readonly docs = new Map<string, IncludeDoc>();
  private readonly prepared = new Map<string, { xml: string; used: string[] }>();
  private readonly partRels = new Map<string, { xml: string; ids: Set<string> }>();
  private readonly changed = new Map<string, Uint8Array>();
  private mainStyles: XEl | null | undefined;
  private mainStyleXml = new Map<string, string>();
  private mainDocDefaults = "";
  private mainDefault: string | undefined;
  private mainNumbering: XEl | null | undefined;
  private contentTypes: string;
  private readonly originalContentTypes: string;
  private stylesChanged = false;
  private numberingChanged = false;

  constructor(
    private readonly main: Record<string, Uint8Array>,
    private readonly includes: Record<string, Buffer>,
    private readonly limits: Limits,
    private readonly tally: ArchiveTally
  ) {
    this.contentTypes = this.text("[Content_Types].xml") ?? "";
    this.originalContentTypes = this.contentTypes;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.includes, name);
  }

  /** A file as it stands now, with any change this host has made. */
  read(path: string): string | undefined {
    for (const [part, rels] of this.partRels) {
      if (this.relsPath(part) === path) {
        return rels.xml;
      }
    }
    return this.text(path);
  }

  private text(path: string): string | undefined {
    const bytes = this.changed.get(path) ?? this.main[path];
    return bytes ? strFromU8(bytes) : undefined;
  }

  private doc(name: string): IncludeDoc {
    let doc = this.docs.get(name);
    if (!doc) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipWithin(this.includes[name]!, this.limits, this.tally);
      } catch (e) {
        if (e instanceof DocxFormatError) {
          throw new IncludeError(`${name} is not a readable .docx: ${e.message}`);
        }
        throw e;
      }
      doc = new IncludeDoc(name, this.docs.size + 1, entries);
      this.docs.set(name, doc);
    }
    return doc;
  }

  /**
   * The content of an included template as fresh nodes ready to merge, relationships renumbered for `part`. Namespaces
   * the content uses that `part` does not declare are added to `nsAdd`.
   */
  instantiate(name: string, part: string, partNs: Map<string, string>, nsAdd: Map<string, string>): { nodes: XNode[]; count: number } {
    const doc = this.doc(name);
    const key = `${name}\0${part}`;
    let prepared = this.prepared.get(key);
    if (!prepared) {
      prepared = this.prepare(doc, part);
      this.prepared.set(key, prepared);
    }
    for (const prefix of prepared.used) {
      const uri = doc.ns.get(prefix);
      const have = partNs.get(prefix) ?? nsAdd.get(prefix);
      if (uri !== undefined && have === undefined) {
        nsAdd.set(prefix, uri);
      } else if (uri !== undefined && have !== uri) {
        throw new IncludeError(`${name} uses the namespace prefix ${prefix} for a different namespace than the template that calls it`);
      }
    }
    const nodes = parseXml(prepared.xml).children.filter((c) => c.kind === "el" || c.raw.trim() !== "");
    for (const n of nodes) {
      if (n.kind === "el") {
        n.parent = null;
      }
    }
    return { nodes, count: countNodes(nodes) };
  }

  /** The parts this merge added or rewrote, to write into the output archive. */
  finish(): Map<string, Uint8Array> {
    if (this.stylesChanged && this.mainStyles) {
      this.changed.set("word/styles.xml", strToU8(this.serializePart(this.mainStyles)));
    }
    if (this.numberingChanged && this.mainNumbering) {
      this.changed.set("word/numbering.xml", strToU8(this.serializePart(this.mainNumbering)));
    }
    for (const [part, rels] of this.partRels) {
      this.changed.set(this.relsPath(part), strToU8(rels.xml));
    }
    if (this.contentTypes !== this.originalContentTypes) {
      this.changed.set("[Content_Types].xml", strToU8(this.contentTypes));
    }
    return this.changed;
  }

  private serializePart(root: XEl): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXml({ ...root, kind: "el", children: [root] } as XEl)}`;
  }

  private relsPath(part: string): string {
    const slash = part.lastIndexOf("/");
    return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  }

  private rels(part: string): { xml: string; ids: Set<string> } {
    let rels = this.partRels.get(part);
    if (!rels) {
      const xml =
        this.text(this.relsPath(part)) ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
      rels = {
        xml: /<\/Relationships>/.test(xml) ? xml : xml.replace(/<Relationships([^>]*)\/>/, "<Relationships$1></Relationships>"),
        ids: new Set(parseRels(xml).map((r) => r.id))
      };
      this.partRels.set(part, rels);
    }
    return rels;
  }

  private addRel(part: string, type: string, target: string, external: boolean): string {
    const rels = this.rels(part);
    let n = 1;
    while (rels.ids.has(`rId${n}`)) {
      n++;
    }
    const id = `rId${n}`;
    rels.ids.add(id);
    rels.xml = rels.xml.replace(
      "</Relationships>",
      `<Relationship Id="${id}" Type="${escapeAttr(type)}" Target="${target}"${external ? ' TargetMode="External"' : ""}/></Relationships>`
    );
    return id;
  }

  private addDefaultType(extension: string, contentType: string): void {
    if (!new RegExp(`<Default\\b[^>]*\\sExtension="${extension}"`, "i").test(this.contentTypes)) {
      this.contentTypes = this.contentTypes.replace("</Types>", `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`);
    }
  }

  private addOverride(partName: string, contentType: string): void {
    if (!this.contentTypes.includes(`PartName="${partName}"`)) {
      this.contentTypes = this.contentTypes.replace("</Types>", `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
    }
  }

  private mainSectPr(): string {
    const xml = this.text(DOC_PATH) ?? "";
    const m = /<w:sectPr\b(?:(?!<w:sectPr\b)[\s\S])*?<\/w:sectPr>\s*<\/w:body>/.exec(xml);
    const found = m ? m[0].replace(/\s*<\/w:body>$/, "") : "<w:sectPr/>";
    return found.replace(/<w:(?:headerReference|footerReference)\b[^>]*\/>/g, "").replace(/<w:titlePg\b[^>]*\/>/g, "");
  }

  private scan(doc: IncludeDoc): Used {
    const used: Used = { styles: new Set(), numbers: new Set(), rels: new Set(), paragraphs: false };
    const relAttr = doc.relPrefix ? new RegExp(`\\s${doc.relPrefix}:[\\w]+\\s*=\\s*"([^"]*)"`, "g") : null;
    walk(
      doc.body,
      (el) => {
        if (UNSUPPORTED_ELEMENTS.has(el.name)) {
          throw new IncludeError(`${doc.name} has ${el.name.slice(2)}, which cannot be copied into another template`);
        }
        if (STYLE_REFS.has(el.name)) {
          const id = attr(el.open, "w:val");
          if (id) {
            used.styles.add(id);
          }
        } else if (el.name === "w:numId" && el.parent?.name === "w:numPr") {
          const id = attr(el.open, "w:val");
          if (id && id !== "0") {
            used.numbers.add(id);
          }
        } else if (el.name === "w:p") {
          used.paragraphs = true;
        }
        if (relAttr) {
          for (const m of el.open.matchAll(relAttr)) {
            used.rels.add(m[1]!);
          }
        }
      },
      "w:sectPr"
    );
    return used;
  }

  private loadMainStyles(): void {
    if (this.mainStyles !== undefined) {
      return;
    }
    const xml = this.text("word/styles.xml");
    this.mainStyles = xml ? (childEls(parseXml(xml))[0] ?? null) : null;
    for (const el of this.mainStyles ? childEls(this.mainStyles) : []) {
      if (el.name === "w:docDefaults") {
        this.mainDocDefaults = serializeXml(el);
      } else if (el.name === "w:style") {
        const id = attr(el.open, "w:styleId");
        if (id) {
          this.mainStyleXml.set(id, styleSignature(el));
          if (attr(el.open, "w:type") === "paragraph" && attr(el.open, "w:default") === "1") {
            this.mainDefault = id;
          }
        }
      }
    }
  }

  private ensureStylesPart(): XEl {
    this.loadMainStyles();
    if (!this.mainStyles) {
      this.mainStyles = elementOf(`<w:styles xmlns:w="${W_NS}"></w:styles>`);
      this.addOverride("/word/styles.xml", STYLES_CT);
      this.addRel("word/document.xml", STYLES_TYPE, "styles.xml", false);
    }
    this.stylesChanged = true;
    return this.mainStyles;
  }

  private ensureNumberingPart(): XEl {
    if (this.mainNumbering === undefined) {
      const xml = this.text("word/numbering.xml");
      this.mainNumbering = xml ? (childEls(parseXml(xml))[0] ?? null) : null;
    }
    if (!this.mainNumbering) {
      this.mainNumbering = elementOf(`<w:numbering xmlns:w="${W_NS}"></w:numbering>`);
      this.addOverride("/word/numbering.xml", NUMBERING_CT);
      this.addRel("word/document.xml", NUMBERING_TYPE, "numbering.xml", false);
    }
    this.numberingChanged = true;
    return this.mainNumbering;
  }

  private importStyles(doc: IncludeDoc, used: Used): void {
    if (doc.styleMap) {
      return;
    }
    this.loadMainStyles();
    const k = doc.ordinal;
    const wanted = new Set(used.styles);
    const queue = [...wanted];
    const needsDefault = this.needsDefaultStyle(doc);
    if (needsDefault && doc.defaultParagraph) {
      wanted.add(doc.defaultParagraph);
      queue.push(doc.defaultParagraph);
    }
    for (const id of queue) {
      for (const child of doc.styles.get(id)?.children ?? []) {
        if (child.kind === "el" && (child.name === "w:basedOn" || child.name === "w:next" || child.name === "w:link")) {
          const ref = attr(child.open, "w:val");
          if (ref && doc.styles.has(ref) && !wanted.has(ref)) {
            wanted.add(ref);
            queue.push(ref);
          }
        }
      }
    }
    const map = new Map<string, string>();
    const imports: string[] = [];
    const taken = new Set([...this.mainStyleXml.keys(), ...doc.styles.keys()]);
    for (const id of doc.styleOrder.filter((s) => wanted.has(s))) {
      const el = doc.styles.get(id)!;
      if (this.mainStyleXml.get(id) === styleSignature(el) && !(needsDefault && id === doc.defaultParagraph)) {
        map.set(id, id);
        continue;
      }
      let fresh = `${id}_${k}`;
      for (let n = 2; taken.has(fresh); n++) {
        fresh = `${id}_${k}_${n}`;
      }
      taken.add(fresh);
      map.set(id, fresh);
      imports.push(id);
    }
    doc.styleMap = map;
    doc.defaultStyle = needsDefault && doc.defaultParagraph ? map.get(doc.defaultParagraph) : undefined;
    if (imports.length === 0) {
      return;
    }
    const numberMap = this.importNumbering(
      doc,
      used,
      imports.flatMap((id) => numIdsOf(doc.styles.get(id)!)),
      map
    );
    const styles = this.ensureStylesPart();
    let base: string | undefined;
    if (doc.docDefaults !== "" && doc.docDefaults !== this.mainDocDefaults) {
      base = `DocDefaults_${k}`;
      while (taken.has(base)) {
        base += "_";
      }
      styles.children.push(elementOf(docDefaultsStyle(doc.docDefaults, base, k)));
    }
    for (const id of imports) {
      const el = cloneEl(doc.styles.get(id)!);
      el.open = setAttr(el.open, "w:styleId", map.get(id)!).replace(/\sw:default\s*=\s*"[^"]*"/, "");
      const isParagraph = attr(el.open, "w:type") === "paragraph";
      let hasBase = false;
      walk(el, (e) => {
        if (e.name === "w:name") {
          e.open = setAttr(e.open, "w:val", `${attr(e.open, "w:val") ?? id} (${k})`);
        } else if (e.name === "w:basedOn" || e.name === "w:next" || e.name === "w:link") {
          const ref = attr(e.open, "w:val");
          if (ref && map.has(ref)) {
            e.open = setAttr(e.open, "w:val", map.get(ref)!);
          }
          hasBase ||= e.name === "w:basedOn";
        } else if (e.name === "w:numId" && e.parent?.name === "w:numPr") {
          const to = numberMap.get(attr(e.open, "w:val") ?? "");
          if (to) {
            e.open = setAttr(e.open, "w:val", to);
          }
        }
      });
      if (base && isParagraph && !hasBase) {
        const at = el.children.findIndex((c) => c.kind === "el" && c.name === "w:name");
        const basedOn = elementOf(`<w:basedOn w:val="${base}"/>`);
        basedOn.parent = el;
        el.children.splice(at + 1, 0, basedOn);
      }
      el.parent = styles;
      styles.children.push(el);
      this.mainStyleXml.set(map.get(id)!, styleSignature(el));
    }
  }

  private needsDefaultStyle(doc: IncludeDoc): boolean {
    if (!doc.defaultParagraph) {
      return false;
    }
    const style = doc.styles.get(doc.defaultParagraph)!;
    const empty = childEls(style).every((c) => c.name === "w:name" || c.name === "w:qFormat" || c.name === "w:uiPriority");
    if (empty && doc.docDefaults === this.mainDocDefaults) {
      return false;
    }
    const main = this.mainDefault ? this.mainStyleXml.get(this.mainDefault) : undefined;
    return !(doc.docDefaults === this.mainDocDefaults && main === styleSignature(style));
  }

  private importNumbering(doc: IncludeDoc, used: Used, fromStyles: string[], styleMap: Map<string, string>): Map<string, string> {
    if (doc.numberMap) {
      return doc.numberMap;
    }
    const map = new Map<string, string>();
    doc.numberMap = map;
    const wanted = [...new Set([...used.numbers, ...fromStyles])];
    if (wanted.length === 0 || !doc.numbering) {
      return map;
    }
    const numbering = this.ensureNumberingPart();
    const kids = childEls(numbering);
    const maxOf = (name: string, field: string): number => Math.max(0, ...kids.filter((e) => e.name === name).map((e) => Number(attr(e.open, field)) || 0));
    let nextAbstract = maxOf("w:abstractNum", "w:abstractNumId") + 1;
    let nextNum = maxOf("w:num", "w:numId") + 1;
    const abstractMap = new Map<string, string>();
    const incKids = childEls(doc.numbering);
    for (const oldNum of wanted) {
      const num = incKids.find((e) => e.name === "w:num" && attr(e.open, "w:numId") === oldNum);
      const abstractId = num ? childEls(num, "w:abstractNumId").map((e) => attr(e.open, "w:val"))[0] : undefined;
      const abstract = abstractId === undefined ? undefined : incKids.find((e) => e.name === "w:abstractNum" && attr(e.open, "w:abstractNumId") === abstractId);
      if (!num || !abstract || abstractId === undefined) {
        continue;
      }
      let newAbstract = abstractMap.get(abstractId);
      if (!newAbstract) {
        newAbstract = String(nextAbstract++);
        abstractMap.set(abstractId, newAbstract);
        const copy = cloneEl(abstract);
        copy.open = setAttr(copy.open, "w:abstractNumId", newAbstract);
        walk(copy, (e) => {
          if (e.name === "w:lvlPicBulletId") {
            throw new IncludeError(`${doc.name} has a picture bullet list, which cannot be copied into another template`);
          }
          if (e.name === "w:nsid") {
            e.open = setAttr(e.open, "w:val", hash8(`${doc.name}\0${abstractId}\0${doc.ordinal}`));
          } else if (e.name === "w:pStyle" || e.name === "w:numStyleLink" || e.name === "w:styleLink") {
            const to = styleMap.get(attr(e.open, "w:val") ?? "");
            if (to) {
              e.open = setAttr(e.open, "w:val", to);
            }
          }
        });
        const firstNum = numbering.children.findIndex((c) => c.kind === "el" && !c.dead && c.name === "w:num");
        const at = firstNum >= 0 ? firstNum : this.endOfNumbering(numbering);
        copy.parent = numbering;
        numbering.children.splice(at, 0, copy);
      }
      const copy = cloneEl(num);
      const newNum = String(nextNum++);
      copy.open = setAttr(copy.open, "w:numId", newNum);
      walk(copy, (e) => {
        if (e.name === "w:abstractNumId") {
          e.open = setAttr(e.open, "w:val", newAbstract!);
        }
      });
      copy.parent = numbering;
      numbering.children.splice(this.endOfNumbering(numbering), 0, copy);
      map.set(oldNum, newNum);
    }
    return map;
  }

  private endOfNumbering(numbering: XEl): number {
    const at = numbering.children.findIndex((c) => c.kind === "el" && !c.dead && c.name === "w:numIdMacAtCleanup");
    return at >= 0 ? at : numbering.children.length;
  }

  private importRels(doc: IncludeDoc, part: string, ids: Set<string>): Map<string, string> {
    const map = new Map<string, string>();
    for (const id of ids) {
      const rel = doc.rels.find((r) => r.id === id);
      if (!rel) {
        throw new IncludeError(`${doc.name} refers to relationship ${id}, which it does not define`);
      }
      const kind = shortType(rel.type);
      if (kind === "hyperlink") {
        map.set(id, this.addRel(part, rel.type, rel.target, rel.external));
      } else if (kind === "image" && !rel.external) {
        map.set(id, this.addRel(part, rel.type, this.copyMedia(doc, rel), false));
      } else if (kind === "image") {
        map.set(id, this.addRel(part, rel.type, rel.target, true));
      } else {
        throw new IncludeError(`${doc.name} uses a ${kind} relationship, which cannot be copied into another template`);
      }
    }
    return map;
  }

  private copyMedia(doc: IncludeDoc, rel: Rel): string {
    const cached = doc.media.get(rel.target);
    if (cached) {
      return cached;
    }
    const path = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`.replace(/[^/]+\/\.\.\//g, "");
    const bytes = doc.entries[path];
    if (!bytes) {
      throw new IncludeError(`${doc.name} refers to ${rel.target}, which it does not contain`);
    }
    const base = path.slice(path.lastIndexOf("/") + 1);
    const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    const fromDoc = new RegExp(`<Default\\b[^>]*\\sExtension="${extension}"[^>]*\\sContentType="([^"]*)"`, "i").exec(doc.contentTypes)?.[1];
    const contentType = fromDoc ?? IMAGE_TYPES[extension];
    if (!contentType) {
      throw new IncludeError(`${doc.name} has an image of an unknown type (${base})`);
    }
    this.addDefaultType(extension, contentType);
    const target = `/word/media/inc${doc.ordinal}_${base}`;
    this.changed.set(target.slice(1), bytes);
    doc.media.set(rel.target, target);
    return target;
  }

  private prepare(doc: IncludeDoc, part: string): { xml: string; used: string[] } {
    const used = this.scan(doc);
    this.importStyles(doc, used);
    const styleMap = doc.styleMap!;
    const numberMap = doc.numberMap ?? this.importNumbering(doc, used, [], styleMap);
    const relMap = this.importRels(doc, part, used.rels);
    const relAttr = doc.relPrefix ? new RegExp(`(\\s${doc.relPrefix}:\\w+\\s*=\\s*")([^"]*)(")`, "g") : null;
    const body = cloneEl(doc.body);
    body.children = body.children.filter((c) => !(c.kind === "el" && c.name === "w:sectPr"));
    const sect = this.mainSectPr();
    const rewrite = (el: XEl): void => {
      for (let i = 0; i < el.children.length; i++) {
        const c = el.children[i]!;
        if (c.kind !== "el" || c.dead) {
          continue;
        }
        if (c.name === "w:sectPr") {
          const replacement = elementOf(sect);
          replacement.parent = el;
          el.children[i] = replacement;
          continue;
        }
        if (STYLE_REFS.has(c.name)) {
          const to = styleMap.get(attr(c.open, "w:val") ?? "");
          if (to) {
            c.open = setAttr(c.open, "w:val", to);
          }
        } else if (c.name === "w:numId" && el.name === "w:numPr") {
          const to = numberMap.get(attr(c.open, "w:val") ?? "");
          if (to) {
            c.open = setAttr(c.open, "w:val", to);
          }
        } else if (c.name === "w:p" && doc.defaultStyle) {
          setDefaultStyle(c, doc.defaultStyle);
        }
        if (relAttr) {
          c.open = c.open.replace(relAttr, (_m, pre: string, id: string, post: string) => `${pre}${relMap.get(id) ?? id}${post}`);
        }
        rewrite(c);
      }
    };
    rewrite(body);
    const xml = serializeXml(body);
    const prefixes = new Set([...xml.matchAll(/<([A-Za-z_][\w.-]*):/g), ...xml.matchAll(/\s([A-Za-z_][\w.-]*):[\w.-]+\s*=/g)].map((m) => m[1]!));
    prefixes.delete("xml");
    prefixes.delete("xmlns");
    return { xml, used: [...prefixes] };
  }
}

function numIdsOf(style: XEl): string[] {
  const ids: string[] = [];
  walk(style, (e) => {
    if (e.name === "w:numId" && e.parent?.name === "w:numPr") {
      const id = attr(e.open, "w:val");
      if (id && id !== "0") {
        ids.push(id);
      }
    }
  });
  return ids;
}

/** A style's definition without its name, so two styles that look the same compare equal whatever they are called. */
function styleSignature(el: XEl): string {
  return `${el.open.replace(/\sw:(?:styleId|default)\s*=\s*"[^"]*"/g, "")}${el.children.map((c) => (c.kind === "el" && c.name === "w:name" ? "" : serializeXml({ ...el, children: [c] } as XEl))).join("")}`;
}

function docDefaultsStyle(docDefaults: string, id: string, k: number): string {
  const pPr = /<w:pPrDefault>\s*(<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>)\s*<\/w:pPrDefault>/.exec(docDefaults)?.[1] ?? "";
  const rPr = /<w:rPrDefault>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>)\s*<\/w:rPrDefault>/.exec(docDefaults)?.[1] ?? "";
  return `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="Document defaults (${k})"/>${pPr}${rPr}</w:style>`;
}

function setDefaultStyle(p: XEl, styleId: string): void {
  if (p.selfClose) {
    p.selfClose = false;
    p.open = p.open.replace(/\s*\/>$/, ">");
  }
  const style = elementOf(`<w:pStyle w:val="${styleId}"/>`);
  const pPr = childEls(p, "w:pPr")[0];
  if (!pPr) {
    const created = makeEl("w:pPr", "<w:pPr>", [style]);
    created.parent = p;
    p.children.unshift(created);
  } else if (childEls(pPr, "w:pStyle").length === 0) {
    style.parent = pPr;
    pPr.children.unshift(style);
  }
}
