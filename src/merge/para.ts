import { type Instruction, parseInstruction } from "./expr.ts";
import { encodeText, makeEl, makeText, textOf, type XEl } from "./xml.ts";

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

/** Finds `<<…>>` in a paragraph's joined text. `<<## … ##>>` heading noise is skipped. */
export function findInstructions(text: string): { found: Found[]; problems: string[] } {
  const found: Found[] = [];
  const problems: string[] = [];
  let i = text.indexOf("<<");
  while (i >= 0) {
    if (text.startsWith("<<##", i)) {
      const j = text.indexOf("##>>", i + 4);
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
      const lines: string[] = [];
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
          const pieces = add.split(/\r\n|\n|\r/);
          cur += pieces[0];
          for (let j = 1; j < pieces.length; j++) {
            lines.push(cur);
            cur = pieces[j]!;
          }
        }
        if (s.dead?.[k]) {
          flush(k);
        } else if (from < 0) {
          from = k;
        }
      }
      flush(s.len);
      lines.push(cur);
      content ||= lines.some((l) => /\S/.test(l));
      if (lines.length === 1) {
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
      const made = lines.flatMap((line, j) => {
        const t = line === "" ? [] : [makeEl("w:t", "<w:t>", [], false)];
        for (const e of t) {
          setText(e, line);
        }
        return j < lines.length - 1 ? [...t, makeEl("w:br", "<w:br/>", [], true)] : t;
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
