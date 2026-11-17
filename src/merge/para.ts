import { type Instruction, parseInstruction } from "./expr.ts";
import { cloneEl, encodeText, makeEl, makeText, textOf, type XEl } from "./xml.ts";

/** A paragraph break inserted by a value. A `\n` in an inserted value ends the paragraph; the next one copies the paragraph properties. */
export const SPLIT = "dr:split";
/** Inserted-value characters: `\n` ends the paragraph, `\v` is a line break, `\f` ends the paragraph and the next one has default properties. */
const SEPARATOR = /(\r\n|\n|\r|\v|\f)/;

/** Stands in for a non-text run child (tab, break, drawing, field character) in a paragraph's joined text. */
export const NODE_CHAR = "\uFFFC";

const LEAF = new Set([
  "w:tab",
  "w:br",
  "w:cr",
  "w:drawing",
  "w:pict",
  "w:object",
  "w:sym",
  "w:ptab",
  "w:noBreakHyphen",
  "w:softHyphen",
  "w:footnoteReference",
  "w:endnoteReference",
  "w:commentReference",
  "w:fldChar",
  "w:instrText",
  "mc:AlternateContent"
]);

const SKIP = new Set(["w:pPr", "w:rPr", "w:p"]);

export interface Seg {
  el: XEl;
  start: number;
  len: number;
  node: boolean;
  str: string;
  dead: Uint8Array | null;
  ins: Map<number, string> | null;
}

export interface Found {
  start: number;
  end: number;
  body: string;
  ins: Instruction;
}

function collect(el: XEl, segs: Seg[], parts: string[], pos: { n: number }): void {
  for (const c of el.children) {
    if (c.kind !== "el" || c.dead || SKIP.has(c.name)) {
      continue;
    }
    if (c.name === "w:t") {
      const str = textOf(c);
      if (str.length > 0) {
        segs.push({ el: c, start: pos.n, len: str.length, node: false, str, dead: null, ins: null });
        parts.push(str);
        pos.n += str.length;
      }
    } else if (LEAF.has(c.name)) {
      segs.push({ el: c, start: pos.n, len: 1, node: true, str: NODE_CHAR, dead: null, ins: null });
      parts.push(NODE_CHAR);
      pos.n += 1;
    } else {
      collect(c, segs, parts, pos);
    }
  }
}

/** Finds `<<…>>` in a paragraph's joined text. `<<## … ##>>` is a comment, like a slash-star comment. */
export function findInstructions(text: string): { found: Found[]; problems: string[] } {
  const found: Found[] = [];
  const problems: string[] = [];
  let i = text.indexOf("<<");
  while (i >= 0) {
    if (text.startsWith("<<##", i)) {
      const j = text.indexOf("##>>", i + 4);
      if (j >= 0) {
        found.push({ start: i, end: j + 4, body: text.slice(i + 2, j + 2), ins: { kind: "comment" } });
      }
      i = text.indexOf("<<", j >= 0 ? j + 4 : i + 2);
      continue;
    }
    const comment = text.startsWith("<</*", i) ? text.indexOf("*/>>", i) : -1;
    const close = comment >= 0 ? comment + 2 : text.indexOf(">>", i + 2);
    const next = text.indexOf("<<", i + 2);
    if (close < 0 || (comment < 0 && next >= 0 && next < close)) {
      problems.push(`"<<" with no closing ">>": ${JSON.stringify(text.slice(i, i + 40))}`);
      i = next;
      continue;
    }
    const body = text.slice(i + 2, close);
    let ins: Instruction;
    try {
      ins = parseInstruction(body);
    } catch (e) {
      ins = { kind: "unsupported", text: body, reason: e instanceof Error ? e.message : String(e) };
    }
    found.push({ start: i, end: close + 2, body, ins });
    i = text.indexOf("<<", close + 2);
  }
  return { found, problems };
}

function setText(el: XEl, text: string): void {
  el.children = [makeText(encodeText(text))];
  el.selfClose = false;
  el.open = /xml:space=/.test(el.open) ? el.open.replace(/xml:space="[^"]*"/, 'xml:space="preserve"') : el.open.replace(/\s*\/?>$/, ' xml:space="preserve">');
}

function separatorEl(sep: string): XEl {
  if (sep === "\v") {
    return makeEl("w:br", "<w:br/>", [], true);
  }
  return makeEl(SPLIT, sep === "\f" ? "<dr:split plain/>" : "<dr:split/>", [], true);
}

function markRun(el: XEl): void {
  if (el.parent?.name === "w:r") {
    el.parent.dirty = true;
  }
}

/**
 * A paragraph's text as one string, with the w:t elements and non-text run children behind it. Ranges of the
 * joined text can be killed or given replacement text, and apply() writes the result back to the elements.
 */
export class Para {
  readonly segs: Seg[] = [];
  readonly text: string;
  readonly found: Found[];
  readonly problems: string[];

  constructor(readonly el: XEl) {
    const parts: string[] = [];
    collect(el, this.segs, parts, { n: 0 });
    this.text = parts.join("");
    if (this.text.includes("<<")) {
      ({ found: this.found, problems: this.problems } = findInstructions(this.text));
    } else {
      this.found = [];
      this.problems = [];
    }
  }

  private segIndex(pos: number): number {
    let lo = 0;
    let hi = this.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid]!.start <= pos) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  kill(a: number, b: number): void {
    if (b <= a || this.segs.length === 0) {
      return;
    }
    for (let i = this.segIndex(a); i < this.segs.length && this.segs[i]!.start < b; i++) {
      const s = this.segs[i]!;
      s.dead ??= new Uint8Array(s.len);
      s.dead.fill(1, Math.max(a, s.start) - s.start, Math.min(b, s.start + s.len) - s.start);
    }
  }

  insert(pos: number, str: string): void {
    const s = this.segs[this.segIndex(pos)]!;
    s.ins ??= new Map();
    const k = pos - s.start;
    s.ins.set(k, (s.ins.get(k) ?? "") + str);
  }

  /** Writes kills and insertions back to the DOM. Returns whether any visible content (not just whitespace) is left. */
  apply(): boolean {
    let content = false;
    for (const s of this.segs) {
      if (!s.dead && !s.ins) {
        content ||= s.node || /\S/.test(s.str);
        continue;
      }
      if (s.node) {
        if (s.dead) {
          s.el.dead = true;
          markRun(s.el);
        } else {
          content = true;
        }
        continue;
      }
      const parts: (string | XEl)[] = [];
      let cur = "";
      let from = -1;
      const flush = (to: number): void => {
        if (from >= 0) {
          cur += s.str.slice(from, to);
          from = -1;
        }
      };
      for (let k = 0; k < s.len; k++) {
        const add = s.ins?.get(k);
        if (add !== undefined) {
          flush(k);
          const bits = add.split(SEPARATOR);
          cur += bits[0];
          for (let j = 1; j < bits.length; j += 2) {
            parts.push(cur, separatorEl(bits[j]!));
            cur = bits[j + 1]!;
          }
        }
        if (s.dead?.[k]) {
          flush(k);
        } else if (from < 0) {
          from = k;
        }
      }
      flush(s.len);
      parts.push(cur);
      const texts = parts.filter((x): x is string => typeof x === "string");
      content ||= texts.some((l) => /\S/.test(l));
      if (parts.length === 1) {
        if (cur === "") {
          s.el.dead = true;
          markRun(s.el);
        } else {
          setText(s.el, cur);
        }
        continue;
      }
      const parent = s.el.parent!;
      const at = parent.children.indexOf(s.el);
      const made = parts.flatMap((part) => {
        if (typeof part !== "string") {
          return [part];
        }
        if (part === "") {
          return [];
        }
        const t = makeEl("w:t", "<w:t>", [], false);
        setText(t, part);
        return [t];
      });
      for (const e of made) {
        e.parent = parent;
      }
      parent.children.splice(at, 1, ...made);
      s.el.dead = true;
      markRun(s.el);
    }
    this.el.cache = undefined;
    return content;
  }
}

export function paraOf(el: XEl): Para {
  const cached = el.cache;
  if (cached instanceof Para) {
    return cached;
  }
  const p = new Para(el);
  el.cache = p;
  return p;
}

/** Removes one trailing space from the last text in a paragraph element. Used when a seam is closed across fragments. */
export function trimTrailingSpace(el: XEl): void {
  const texts: XEl[] = [];
  const walk = (e: XEl): void => {
    for (const c of e.children) {
      if (c.kind === "el" && !c.dead && c.name !== "w:p" && c.name !== "w:pPr" && c.name !== "w:rPr") {
        if (c.name === "w:t") {
          texts.push(c);
        } else {
          walk(c);
        }
      }
    }
  };
  walk(el);
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!;
    const str = textOf(t);
    if (str === "") {
      continue;
    }
    if (str.endsWith(" ")) {
      if (str.length === 1) {
        t.dead = true;
        markRun(t);
      } else {
        setText(t, str.slice(0, -1));
      }
    }
    return;
  }
}

function findSplit(el: XEl, chain: XEl[]): boolean {
  for (const c of el.children) {
    if (c.kind !== "el" || c.dead || c.name === "w:p") {
      continue;
    }
    chain.push(c);
    if (c.name === SPLIT || findSplit(c, chain)) {
      return true;
    }
    chain.pop();
  }
  return false;
}

/** Splits a paragraph at each paragraph break a value inserted. The new paragraph copies `w:pPr` unless the break asked for default properties. */
export function splitAtBreaks(p: XEl): XEl[] {
  const out: XEl[] = [];
  let cur = p;
  for (;;) {
    const chain: XEl[] = [cur];
    if (!findSplit(cur, chain)) {
      out.push(cur);
      return out;
    }
    const mark = chain.pop()!;
    let right: XEl | null = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i]!;
      const deepest = i === chain.length - 1;
      const child = deepest ? mark : chain[i + 1]!;
      const after = node.children.splice(node.children.indexOf(child) + (deepest ? 0 : 1));
      if (deepest) {
        after.shift();
      }
      const lead = node.children.filter((c): c is XEl => c.kind === "el" && (c.name === "w:rPr" || (c.name === "w:pPr" && !mark.open.includes("plain"))));
      const copy = makeEl(node.name, node.open, [...lead.map((c) => cloneEl(c)), ...(right ? [right] : []), ...after], node.selfClose);
      copy.ord = node.ord;
      right = copy;
    }
    out.push(cur);
    cur = right!;
  }
}

/** Docmosis ends the paragraph after a page break that has more content after it; the rest goes in a new paragraph. */
export function splitAfterPageBreaks(el: XEl): void {
  const items: { el: XEl; pageBreak: boolean }[] = [];
  const walk = (e: XEl): void => {
    for (const c of e.children) {
      if (c.kind !== "el" || c.dead || SKIP.has(c.name)) {
        continue;
      }
      if (c.name === "w:t") {
        if (textOf(c) !== "") {
          items.push({ el: c, pageBreak: false });
        }
      } else if (LEAF.has(c.name)) {
        items.push({ el: c, pageBreak: c.name === "w:br" && c.open.includes('w:type="page"') });
      } else {
        walk(c);
      }
    }
  };
  walk(el);
  items.forEach((item, i) => {
    if (item.pageBreak && i < items.length - 1 && item.el.parent) {
      const at = item.el.parent.children.indexOf(item.el);
      const mark = makeEl(SPLIT, "<dr:split/>", [], true);
      mark.parent = item.el.parent;
      item.el.parent.children.splice(at + 1, 0, mark);
    }
  });
}

/** Whether a paragraph element holds any text or non-text content yet. */
export function hasContent(el: XEl): boolean {
  for (const c of el.children) {
    if (c.kind !== "el" || c.dead || SKIP.has(c.name)) {
      continue;
    }
    if (c.name === "w:t" ? textOf(c) !== "" : LEAF.has(c.name) || hasContent(c)) {
      return true;
    }
  }
  return false;
}
