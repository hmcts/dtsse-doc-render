export interface XText {
  kind: "text";
  raw: string;
  /** Comments, processing instructions, CDATA and declarations: kept verbatim and never read as text. */
  markup: boolean;
}

export interface XEl {
  kind: "el";
  name: string;
  /** The opening tag exactly as written, including a trailing "/" for a self-closed element. */
  open: string;
  selfClose: boolean;
  children: XNode[];
  parent: XEl | null;
  dead: boolean;
  /** Set on a run that has had content removed, so it can be dropped when nothing is left in it. */
  dirty: boolean;
  /** Position of a w:p or w:tr in the part, used in error locations. */
  ord: number;
  cache?: unknown;
  /** Further paragraphs a value's line breaks split this one into, in order. */
  rest?: XEl[];
}

export type XNode = XText | XEl;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) {
    return s;
  }
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function encodeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function makeEl(name: string, open: string, children: XNode[] = [], selfClose = false): XEl {
  const el: XEl = { kind: "el", name, open, selfClose, children, parent: null, dead: false, dirty: false, ord: 0 };
  for (const c of children) {
    if (c.kind === "el") {
      c.parent = el;
    }
  }
  return el;
}

export function makeText(raw: string): XText {
  return { kind: "text", raw, markup: false };
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

function tagEnd(xml: string, from: number): number {
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) {
        quote = 0;
      }
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

/** Parses into a minimal DOM that serialises back to the same text. Returns a synthetic document element. */
export function parseXml(xml: string): XEl {
  const doc = makeEl("#document", "");
  let cur = doc;
  let paras = 0;
  let rows = 0;
  const n = xml.length;
  let i = 0;
  const markup = (end: number): void => {
    cur.children.push({ kind: "text", raw: xml.slice(i, end), markup: true });
    i = end;
  };
  while (i < n) {
    if (xml.charCodeAt(i) !== 60) {
      let j = xml.indexOf("<", i);
      if (j < 0) {
        j = n;
      }
      cur.children.push(makeText(xml.slice(i, j)));
      i = j;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const j = xml.indexOf("-->", i + 4);
      markup(j < 0 ? n : j + 3);
    } else if (xml.startsWith("<![CDATA[", i)) {
      const j = xml.indexOf("]]>", i + 9);
      markup(j < 0 ? n : j + 3);
    } else if (xml.startsWith("<?", i)) {
      const j = xml.indexOf("?>", i + 2);
      markup(j < 0 ? n : j + 2);
    } else if (xml.startsWith("<!", i)) {
      const j = xml.indexOf(">", i + 2);
      markup(j < 0 ? n : j + 1);
    } else if (xml.charCodeAt(i + 1) === 47) {
      const j = xml.indexOf(">", i + 2);
      if (j < 0) {
        throw new XmlError("unterminated closing tag");
      }
      const name = xml.slice(i + 2, j).trim();
      if (cur.name !== name || !cur.parent) {
        throw new XmlError(`unexpected </${name}>`);
      }
      cur = cur.parent;
      i = j + 1;
    } else {
      const j = tagEnd(xml, i + 1);
      if (j < 0) {
        throw new XmlError("unterminated tag");
      }
      const open = xml.slice(i, j + 1);
      const selfClose = xml.charCodeAt(j - 1) === 47;
      let k = i + 1;
      while (k < j && !/[\s/]/.test(xml[k]!)) {
        k++;
      }
      const el = makeEl(xml.slice(i + 1, k), open, [], selfClose);
      if (el.name === "w:p") {
        el.ord = ++paras;
      } else if (el.name === "w:tr") {
        el.ord = ++rows;
      }
      el.parent = cur;
      cur.children.push(el);
      if (!selfClose) {
        cur = el;
      }
      i = j + 1;
    }
  }
  if (cur !== doc) {
    throw new XmlError(`<${cur.name}> is never closed`);
  }
  return doc;
}

function isPrunableRun(el: XEl): boolean {
  return el.name === "w:r" && el.dirty && el.children.every((c) => c.kind === "text" || c.dead || c.name === "w:rPr");
}

function write(node: XNode, out: string[]): void {
  if (node.kind === "text") {
    out.push(node.raw);
    return;
  }
  if (node.dead || isPrunableRun(node)) {
    return;
  }
  out.push(node.open);
  if (node.selfClose && node.children.length === 0) {
    return;
  }
  for (const c of node.children) {
    write(c, out);
  }
  out.push(`</${node.name}>`);
}

export function serializeXml(doc: XEl): string {
  const out: string[] = [];
  for (const c of doc.children) {
    write(c, out);
  }
  return out.join("");
}

/** Deep copy; elements removed from the source are not copied. */
export function cloneEl(el: XEl, parent: XEl | null = null): XEl {
  const copy: XEl = { ...el, children: [], parent, cache: undefined, dead: false, rest: undefined };
  for (const c of el.children) {
    if (c.kind === "text") {
      copy.children.push(c);
    } else if (!c.dead) {
      copy.children.push(cloneEl(c, copy));
    }
  }
  return copy;
}

export function textOf(el: XEl): string {
  let s = "";
  for (const c of el.children) {
    if (c.kind === "text" && !c.markup) {
      s += decodeEntities(c.raw);
    }
  }
  return s;
}

export function childEls(el: XEl, name?: string): XEl[] {
  return el.children.filter((c): c is XEl => c.kind === "el" && !c.dead && (name === undefined || c.name === name));
}

export function findDescendants(el: XEl, name: string, into: XEl[] = []): XEl[] {
  for (const c of el.children) {
    if (c.kind === "el" && !c.dead) {
      if (c.name === name) {
        into.push(c);
      } else {
        findDescendants(c, name, into);
      }
    }
  }
  return into;
}
