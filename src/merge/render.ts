import { ExpressionError, LimitError } from "./errors.ts";
import { evaluate, formatValue, type Instruction, repeatItems, type Scope, truthy } from "./expr.ts";
import { type Limits, resolveLimits } from "./limits.ts";
import { type Found, hasContent, NODE_CHAR, type Para, paraOf, splitAfterPageBreaks, splitAtBreaks, trimTrailingSpace } from "./para.ts";
import { childEls, cloneEl, encodeText, findDescendants, makeEl, parseXml, serializeXml, stripIllegalXml, type XEl, type XNode } from "./xml.ts";

/** What one merge has produced so far, checked against the limits as it goes. */
export interface Budget {
  limits: Limits;
  nodes: number;
  bytes: number;
}

function spend(ctx: Ctx, nodes: number, bytes: number): void {
  const b = ctx.budget;
  b.nodes += nodes;
  b.bytes += bytes;
  if (b.nodes > b.limits.maxOutputNodes) {
    throw new LimitError(`the merge would produce more than ${b.limits.maxOutputNodes} nodes; repeat blocks are expanding too far`);
  }
  if (b.bytes > b.limits.maxOutputBytes) {
    throw new LimitError(`the merge would produce more than ${Math.round(b.limits.maxOutputBytes / 1048576)} MiB of output`);
  }
}

function cloneIn(ctx: Ctx, el: XEl): XEl {
  const tally = { n: 0 };
  const copy = cloneEl(el, null, tally);
  spend(ctx, tally.n, 0);
  return copy;
}

export interface Ctx {
  budget: Budget;
  devMode: boolean;
  messages: string[];
  part: string;
  epoch: number;
  /** Numbers the faults in the body, which Docmosis marks as `Docmosis1`, `Docmosis2`… in document order. */
  counter: { n: number };
  /** Headers and footers describe a fault in place; the body numbers them. */
  body: boolean;
}

interface Marker {
  kind: "cs" | "cr" | "rs" | "rr" | "es" | "er" | "else";
  ins: Instruction;
  text: string;
  loc: string;
  /** Child index of the paragraph or row the marker sits in. */
  where: number;
  start: number;
  end: number;
  para: Para;
  /** True when every marker of the block is in one paragraph. */
  inline: boolean;
  /** For an else or end tag, the tag that opened the branch it closes. */
  opener?: Marker;
}

interface TBranch<N> {
  head: Marker;
  items: TItem<N>[];
}

interface TBlock<N> {
  t: "block";
  kind: "cs" | "cr" | "rs" | "rr";
  head: Marker;
  inline: boolean;
  branches: TBranch<N>[];
  /** The end tag, once the block is closed. */
  end: Marker | null;
}

type TItem<N> = { t: "node"; node: N } | TBlock<N>;

type Seq<N> = { m: Marker } | { n: N };

type ListEntry =
  | { k: "frag"; el: XEl; origin: number; idx: number; cont: boolean; whole: boolean; keep: boolean }
  | { k: "keep"; el: XEl; origin: number }
  | { k: "extra"; el: XEl }
  | { k: "table" | "sdt" | "other"; node: XNode };

type RowEntry = { k: "row"; el: XEl } | { k: "other"; node: XNode };

const isStart = (k: Marker["kind"]): boolean => k === "cs" || k === "cr" || k === "rs" || k === "rr";

function straighten(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** What Docmosis leaves in devMode in place of a failed instruction: its own text, then a number in the body or the reason in a header. */
function devNote(ctx: Ctx, tag: string, reason: string, straight: boolean): string {
  const shown = `<<${straight ? straighten(tag) : tag}>>`;
  if (ctx.body) {
    return `${shown}Docmosis${++ctx.counter.n}`;
  }
  return `${shown}${reason} `;
}

function fail(ctx: Ctx, reason: string, tag: string, where: string, straight = true): string {
  ctx.messages.push(`${reason}: <<${tag.trim()}>> (${ctx.part}, ${where})`);
  return devNote(ctx, tag, reason, straight);
}

function syntheticPara(text: string): XEl {
  const p = parseXml(`<w:p><w:r><w:t xml:space="preserve">${encodeText(text)}</w:t></w:r></w:p>`).children[0] as XEl;
  p.parent = null;
  return p;
}

function syntheticRow(text: string): XEl {
  const row = parseXml(`<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">${encodeText(text)}</w:t></w:r></w:p></w:tc></w:tr>`).children[0] as XEl;
  row.parent = null;
  return row;
}

function hasSectPr(p: XEl): boolean {
  return childEls(p, "w:pPr").some((pr) => childEls(pr, "w:sectPr").length > 0);
}

function matchMarkers(markers: Marker[]): Set<Marker> {
  const matched = new Set<Marker>();
  const stack: Marker[][] = [];
  for (const m of markers) {
    if (isStart(m.kind)) {
      stack.push([m]);
    } else if (m.kind === "else") {
      const top = stack.at(-1);
      if (top && (top[0]!.kind === "cs" || top[0]!.kind === "cr")) {
        m.opener = top.at(-1);
        top.push(m);
      }
    } else {
      const top = stack.pop();
      if (top) {
        m.opener = top.at(-1);
        top.push(m);
        const inline = top.every((x) => x.where === m.where);
        for (const x of top) {
          x.inline = inline;
          matched.add(x);
        }
      }
    }
  }
  return matched;
}

function buildTree<N>(seq: Seq<N>[]): TItem<N>[] {
  const root: TItem<N>[] = [];
  const stack: { block: TBlock<N>; parent: TItem<N>[] }[] = [];
  let cur = root;
  for (const s of seq) {
    if ("n" in s) {
      cur.push({ t: "node", node: s.n });
      continue;
    }
    const m = s.m;
    if (isStart(m.kind)) {
      const block: TBlock<N> = { t: "block", kind: m.kind as TBlock<N>["kind"], head: m, inline: m.inline, branches: [{ head: m, items: [] }], end: null };
      cur.push(block);
      stack.push({ block, parent: cur });
      cur = block.branches[0]!.items;
    } else if (m.kind === "else") {
      const branch: TBranch<N> = { head: m, items: [] };
      stack.at(-1)!.block.branches.push(branch);
      cur = branch.items;
    } else {
      const top = stack.pop()!;
      top.block.end = m;
      cur = top.parent;
    }
  }
  return root;
}

interface Plan<N> {
  runs: { items: TItem<N>[]; scope: Scope }[];
  /** Index of the branch that was kept, or -1. */
  taken: number;
  error?: string;
}

function planBlock<N>(block: TBlock<N>, scope: Scope, ctx: Ctx): Plan<N> {
  try {
    if (block.kind === "cs" || block.kind === "cr") {
      for (const [i, br] of block.branches.entries()) {
        const ins = br.head.ins;
        const cond = ins.kind === "cs" || ins.kind === "cr" || ins.kind === "else" ? ins.cond : undefined;
        if (cond === undefined || truthy(evaluate(cond, scope))) {
          return { runs: [{ items: br.items, scope }], taken: i };
        }
      }
      return { runs: [], taken: -1 };
    }
    const ins = block.head.ins;
    const value = ins.kind === "rs" || ins.kind === "rr" ? evaluate(ins.expr, scope) : undefined;
    const list = repeatItems(value);
    if (list.length > ctx.budget.limits.maxRepeatItems) {
      throw new LimitError(`${block.head.loc}: a repeat block has ${list.length} items, more than the limit of ${ctx.budget.limits.maxRepeatItems}`);
    }
    return {
      runs: list.map((item, i) => ({ items: block.branches[0]!.items, scope: scope.child(item, i + 1, list.length) })),
      taken: list.length > 0 ? 0 : -1
    };
  } catch (e) {
    if (e instanceof LimitError) {
      throw e;
    }
    const reason = e instanceof ExpressionError || e instanceof Error ? e.message : String(e);
    const condition = block.head.text.replace(/^(?:cs|cr|rs|rr)_\s*/, "").replace(/^\{([\s\S]*)\}$/, "$1");
    return { runs: [], taken: -1, error: fail(ctx, `Error in expression:${reason}`, condition, block.head.loc, false) };
  }
}

const ORPHAN: Record<string, string> = {
  cs: "block is never closed, expected es_",
  rs: "block is never closed, expected es_",
  cr: "row block is never closed (or is not in a table row), expected er_",
  rr: "row block is never closed (or is not in a table row), expected er_",
  es: "closes nothing, no matching cs_ or rs_",
  er: "closes nothing, no matching cr_ or rr_ in a table",
  else: "is not inside a cs_ or cr_ block"
};

interface Out {
  nodes: XNode[];
  last: XEl | null;
  lastOrigin: string | null;
  /** Source origin and fragment index of the last paragraph fragment, for joining the fragments of one paragraph. */
  lastFrag: { origin: number; idx: number } | null;
  killed: Set<string>;
  /** Paragraph origins (with epoch) that put at least one fragment in the output. */
  emitted: Set<string>;
  /** An untaken branch left the paragraph before it open: the next fragment after its end joins it. */
  pendingJoin: number | null;
  /** True while the end of `last` is literal text ending in exactly one space with nothing but zero-output tags since. */
  seam: boolean;
}

function pushNode(out: Out, node: XNode): void {
  out.nodes.push(node);
  out.lastOrigin = null;
  out.lastFrag = null;
  out.pendingJoin = null;
  out.seam = false;
}

function processTextBoxes(para: Para, scope: Scope, ctx: Ctx): void {
  for (const s of para.segs) {
    if (s.node && !s.el.dead && (s.el.name === "w:drawing" || s.el.name === "w:pict" || s.el.name === "mc:AlternateContent" || s.el.name === "w:object")) {
      for (const box of findDescendants(s.el, "w:txbxContent")) {
        box.children = processList(box.children, scope, ctx);
      }
    }
  }
}

const BLOCK_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The plain-text subset of an `html:` value. Block elements end the paragraph (`\f`: the next paragraph has default
 * properties, as in Docmosis), `<br>` is a line break (`\v`), other tags are dropped and entities decoded.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|table|tr|blockquote)(?:\s[^>]*)?\/?>/gi, "\f")
    .replace(/<br\s*\/?>/gi, "\v")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#")) {
        const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return BLOCK_ENTITIES[e.toLowerCase()] ?? m;
    });
  return text.replace(/\f+/g, "\f").replace(/^\f|\f$/g, "");
}

/**
 * Docmosis drops a paragraph that held nothing but block tags, assignments and comments, and keeps any other as an empty
 * paragraph when it renders to nothing: one with a field, or with a literal character (a space counts unless it only
 * precedes the first tag). A tag written with a space after `<<` does not count as a tag here.
 */
function keepsParagraph(para: Para): boolean {
  if (para.found.length === 0 || para.found.some((f) => f.ins.kind === "field" || f.ins.kind === "unsupported" || /^\s/.test(f.body))) {
    return true;
  }
  const first = para.found[0]!.start;
  let pos = 0;
  const literal = (a: number, b: number): boolean => para.text.slice(a, b) !== "" && (a >= first || para.text.slice(a, b).trim() !== "");
  for (const f of para.found) {
    if (literal(pos, f.start)) {
      return true;
    }
    pos = f.end;
  }
  return literal(pos, para.text.length);
}

const nodeKey = (n: XNode): string => (n.kind === "text" ? n.raw : `${n.open}${n.children.map(nodeKey).join("")}`);

/**
 * Where a branch opens in one paragraph and its end is in another with identical paragraph properties, Docmosis lets the
 * text before the opener run on into the text after the end, and adds no empty paragraphs; with different properties it
 * ends each paragraph where it began.
 */
function runsOn(end: Marker): boolean {
  const open = end.opener;
  if (!open) {
    return false;
  }
  if (open.where === end.where) {
    return true;
  }
  const props = (m: Marker): string => childEls(m.para.el, "w:pPr").map(nodeKey).join("");
  return props(open) === props(end);
}

/** A paragraph with the properties of `el` and no content. */
function emptyLike(el: XEl): XEl {
  const p = makeEl("w:p", el.open, [], false);
  p.ord = el.ord;
  for (const pPr of childEls(el, "w:pPr")) {
    const copy = cloneEl(pPr);
    copy.children = copy.children.filter((c) => !(c.kind === "el" && c.name === "w:sectPr"));
    copy.parent = p;
    p.children.push(copy);
  }
  return p;
}

const WHOLE_PARA = (para: Para, f: Found): boolean => f.start === 0 && f.end === para.text.length && para.found.length === 1;

function withoutParagraphProperties(el: XEl): void {
  el.children = el.children.filter((c) => !(c.kind === "el" && c.name === "w:pPr" && !hasSectPr(el)));
}

interface FragmentResult {
  el: XEl | null | "op";
  /** Whether the end of the fragment is a literal chunk ending in exactly one space, with only zero-output tags since. */
  seam: "own" | "carry" | null;
}

function renderFragment(
  el: XEl,
  scope: Scope,
  ctx: Ctx,
  joined: boolean,
  drop: (() => void) | null,
  whole: boolean,
  start: "tag" | "paragraph" | null
): FragmentResult {
  const para = paraOf(el);
  const keeps = whole && keepsParagraph(para);
  const where = `paragraph ${el.ord}`;
  for (const p of para.problems) {
    ctx.messages.push(`${p} (${ctx.part}, ${where})`);
  }
  if (para.found.some((f) => f.ins.kind === "comment")) {
    if (!hasSectPr(el)) {
      return { el: null, seam: null };
    }
    para.kill(0, para.text.length);
    para.apply();
    return { el, seam: null };
  }
  let hadMarker = false;
  let opBlank = false;
  let pageBreak = false;
  let bare = false;
  let tail = -1;
  let carry = drop !== null;
  let atStart = start !== null;
  let sawTag = start === "tag";
  let prev = 0;
  const failAt = (f: Found, reason: string): void => {
    atStart = false;
    const text = fail(ctx, reason, f.body, where);
    para.kill(f.start, f.end);
    if (ctx.devMode) {
      para.insert(f.start, text);
    }
  };
  const chunk = (a: number, b: number): void => {
    if (b <= a) {
      return;
    }
    if (para.text[a] === " ") {
      if (tail >= 0) {
        para.kill(tail, tail + 1);
      } else if (carry) {
        drop?.();
      } else if (atStart && sawTag) {
        para.kill(a, a + 1);
      }
    }
    atStart = false;
    tail = -1;
    carry = false;
    if (para.text[b - 1] === " " && (b - a === 1 || para.text[b - 2] !== " ")) {
      tail = b - 1;
    }
  };
  for (const f of para.found) {
    chunk(prev, f.start);
    prev = f.end;
    sawTag ||= f.body.trim() !== "pageBreak";
    const ins = f.ins;
    try {
      if (ins.kind === "field") {
        if (f.body.trim() === "pageBreak" && WHOLE_PARA(para, f)) {
          para.kill(f.start, f.end);
          pageBreak = true;
          continue;
        }
        const raw = cleanValue(formatValue(evaluate(ins.expr, scope)));
        const html = (ins as { html?: boolean }).html === true;
        const value = html ? htmlToText(raw) : raw;
        spend(ctx, 0, value.length);
        if (html && WHOLE_PARA(para, f)) {
          bare = true;
        }
        opBlank ||= ins.optionalParagraph && value.trim() === "";
        para.kill(f.start, f.end);
        para.insert(f.start, value);
        if (value !== "") {
          tail = -1;
          carry = false;
          atStart = false;
        }
      } else if (ins.kind === "assign") {
        scope.setVar(ins.name, evaluate(ins.expr, scope));
        para.kill(f.start, f.end);
        hadMarker = true;
      } else if (ins.kind === "comment") {
        para.kill(f.start, f.end);
        hadMarker = true;
      } else if (ins.kind === "unsupported") {
        failAt(f, `unsupported instruction${ins.reason ? ` (${ins.reason})` : ""}`);
        tail = -1;
        carry = false;
      } else {
        failAt(f, ORPHAN[ins.kind] ?? "is not valid here");
        tail = -1;
        carry = false;
      }
    } catch (e) {
      if (e instanceof LimitError) {
        throw e;
      }
      failAt(
        f,
        `Unable to evaluate field expression [${straighten(f.body.trim().replace(/^\{([\s\S]*)\}$/, "$1"))}]:${e instanceof Error ? e.message : String(e)}`
      );
      tail = -1;
      carry = false;
    }
  }
  chunk(prev, para.text.length);
  const seam = tail >= 0 ? "own" : carry ? "carry" : null;
  const content = para.apply();
  if (opBlank) {
    return { el: "op", seam };
  }
  if (hadMarker && !content && !hasSectPr(el) && !joined && !keeps) {
    return { el: null, seam };
  }
  if (pageBreak) {
    withoutParagraphProperties(el);
    const run = makeEl("w:r", "<w:r>", [makeEl("w:br", '<w:br w:type="page"/>', [], true)]);
    run.parent = el;
    el.children.push(run);
  } else if (bare) {
    withoutParagraphProperties(el);
  }
  processTextBoxes(para, scope, ctx);
  splitAfterPageBreaks(el);
  const parts = splitAtBreaks(el);
  if (parts.length > 1) {
    el.rest = parts.slice(1);
  }
  return { el, seam };
}

function emitEntry(entry: ListEntry, scope: Scope, out: Out, clone: boolean, epoch: number, ctx: Ctx): void {
  if (entry.k === "extra") {
    pushNode(out, emptyLike(entry.el));
    return;
  }
  if (entry.k === "keep") {
    const key = `${entry.origin}:${epoch}`;
    if (!out.killed.has(key) && !out.emitted.has(key)) {
      pushNode(out, emptyLike(entry.el));
    }
    return;
  }
  if (entry.k === "frag") {
    const key = `${entry.origin}:${epoch}`;
    if (out.killed.has(key)) {
      return;
    }
    const sameEpoch = out.lastOrigin === key;
    const ordered = out.lastFrag?.origin === entry.origin && out.lastFrag.idx < entry.idx;
    const joined = entry.cont && out.last !== null && (sameEpoch || ordered || out.pendingJoin === entry.origin);
    const source = clone ? cloneIn(ctx, entry.el) : entry.el;
    if (entry.cont && !joined && !entry.keep && paraOf(source).text.trim() === "") {
      return;
    }
    const last = out.last;
    const drop = joined && out.seam && last ? () => trimTrailingSpace(last) : null;
    const afterTag = entry.idx > 0 || entry.cont;
    const start = joined && out.last && hasContent(out.last) ? null : afterTag ? "tag" : "paragraph";
    const { el: r, seam } = renderFragment(source, scope, ctx, joined, drop, entry.whole, start);
    if (r === "op") {
      if (sameEpoch) {
        out.nodes.pop();
      }
      out.killed.add(key);
      out.lastOrigin = null;
      out.lastFrag = null;
      out.seam = false;
    } else if (r) {
      if (joined && out.last) {
        for (const c of r.children) {
          if (c.kind === "el" && c.name === "w:pPr") {
            continue;
          }
          if (c.kind === "el") {
            c.parent = out.last;
          }
          out.last.children.push(c);
        }
      } else {
        out.nodes.push(r);
        out.last = r;
      }
      for (const extra of r.rest ?? []) {
        out.nodes.push(extra);
        out.last = extra;
      }
      out.lastOrigin = key;
      out.pendingJoin = null;
      out.emitted.add(key);
      out.lastFrag = { origin: entry.origin, idx: entry.idx };
      out.seam = seam !== null;
    } else if (seam === null) {
      out.seam = false;
    }
    return;
  }
  const node = entry.node;
  if (node.kind === "text") {
    pushNode(out, node);
    return;
  }
  const el = clone ? cloneIn(ctx, node) : node;
  if (entry.k === "table") {
    const t = processTable(el, scope, ctx);
    if (t) {
      pushNode(out, t);
    }
  } else if (entry.k === "sdt") {
    for (const content of childEls(el, "w:sdtContent")) {
      content.children = processList(content.children, scope, ctx);
    }
    pushNode(out, el);
  } else {
    pushNode(out, el);
  }
}

function emitList(items: TItem<ListEntry>[], scope: Scope, out: Out, clone: boolean, epoch: number, ctx: Ctx): void {
  for (const it of items) {
    if (it.t === "node") {
      emitEntry(it.node, scope, out, clone, epoch, ctx);
      continue;
    }
    const plan = planBlock(it, scope, ctx);
    if (plan.error && ctx.devMode) {
      pushNode(out, syntheticPara(plan.error));
    }
    const repeat = it.kind === "rs";
    it.branches.forEach((branch, i) => {
      if (i === 0 || !repeat) {
        const runs = repeat ? plan.runs : plan.runs.filter(() => plan.taken === i);
        for (const run of runs) {
          const ep = repeat && !it.inline ? ++ctx.epoch : epoch;
          emitList(run.items, run.scope, out, clone || repeat, ep, ctx);
        }
      }
      const end = it.branches[i + 1]?.head ?? it.end;
      const taken = plan.taken === i;
      if (!plan.error && end && end.where !== branch.head.where) {
        if (runsOn(end)) {
          if (!taken && out.lastFrag?.origin === branch.head.where) {
            out.pendingJoin = end.where;
          }
          if (taken && keepsParagraph(branch.head.para) && !keepsParagraph(end.para)) {
            emitEntry({ k: "extra", el: branch.head.para.el }, scope, out, clone, epoch, ctx);
          }
        } else if ((taken || branch.head.kind === "else") && keepsParagraph(branch.head.para)) {
          emitEntry({ k: "extra", el: branch.head.para.el }, scope, out, clone, epoch, ctx);
        }
      }
    });
  }
}

function splitParagraph(el: XEl, para: Para, ms: Marker[], origin: number, seq: Seq<ListEntry>[]): void {
  let kept = false;
  const keeps = keepsParagraph(para);
  const inlineAll = ms.every((m) => m.inline);
  const frag = (a: number, b: number, cont: boolean, force = false, before?: Marker, after?: Marker): void => {
    const soft = before !== undefined && (before.kind === "es" || before.kind === "else") && runsOn(before);
    const keep = after !== undefined && (after.kind === "es" || after.kind === "else") && runsOn(after) && keeps && !inlineAll;
    const empty = cont ? b <= a && !keep : para.text.slice(a, b).trim() === "" && !(keeps && !inlineAll && !soft);
    if (empty && !force) {
      return;
    }
    kept = true;
    const copy = cloneEl(el);
    const p = paraOf(copy);
    p.kill(0, a);
    p.kill(b, para.text.length);
    p.apply();
    seq.push({
      n: { k: "frag", el: copy, origin, idx: seq.filter((x) => "n" in x && x.n.k === "frag" && x.n.origin === origin).length, cont, whole: false, keep }
    });
  };
  for (let i = 0; i < ms.length; i++) {
    frag(
      i === 0 ? 0 : ms[i - 1]!.end,
      ms[i]!.start,
      i > 0 && (ms[i - 1]!.inline || ms[i - 1]!.kind !== "es" || runsOn(ms[i - 1]!)),
      false,
      ms[i],
      i > 0 ? ms[i - 1] : undefined
    );
    seq.push({ m: ms[i]! });
  }
  const last = ms.at(-1)!;
  frag(last.end, para.text.length, last.inline || last.kind !== "es" || runsOn(last), false, undefined, last);
  if (!kept && hasSectPr(el)) {
    frag(para.text.length, para.text.length, false, true);
  }
  if (inlineAll && keeps) {
    seq.push({ n: { k: "keep", el, origin } });
  }
}

/** Removes the page breaks (and the spaces between them) in `para` that sit immediately before `upTo`. Returns true when nothing but breaks and whitespace precedes `upTo`. */
function dropBreaksBefore(para: Para, upTo: number): boolean {
  let pos = upTo - 1;
  let only = true;
  for (; pos >= 0; pos--) {
    const ch = para.text[pos]!;
    if (ch === NODE_CHAR) {
      const seg = para.segs.find((x) => x.start === pos);
      if (seg?.el.name === "w:br" && seg.el.open.includes('w:type="page"')) {
        para.kill(pos, pos + 1);
        continue;
      }
      only = false;
      break;
    }
    if (ch !== " ") {
      only = false;
      break;
    }
  }
  return only;
}

/** Docmosis drops a page break that ends a block: one just before an end tag in the same paragraph, or alone in the paragraph before one. */
function dropTrailingPageBreaks(children: XNode[]): void {
  let prev: XEl | null = null;
  for (const c of children) {
    if (c.kind !== "el" || c.dead) {
      continue;
    }
    if (c.name !== "w:p") {
      prev = null;
      continue;
    }
    const para = paraOf(c);
    const touched = new Set<XEl>();
    for (const f of para.found) {
      if (f.ins.kind !== "es" && f.ins.kind !== "er") {
        continue;
      }
      const before = para.text.slice(0, f.start);
      if (before.trim() === "" && !before.includes(NODE_CHAR) && prev) {
        const pp = paraOf(prev);
        if (dropBreaksBefore(pp, pp.text.length) && pp.text.includes(NODE_CHAR)) {
          touched.add(prev);
        }
      } else {
        dropBreaksBefore(para, f.start);
        touched.add(c);
      }
    }
    for (const t of touched) {
      paraOf(t).apply();
    }
    prev = c;
  }
}

export function processList(children: XNode[], scope: Scope, ctx: Ctx): XNode[] {
  dropTrailingPageBreaks(children);
  const markers: Marker[] = [];
  children.forEach((c, where) => {
    if (c.kind !== "el" || c.dead || c.name !== "w:p") {
      return;
    }
    const para = paraOf(c);
    for (const f of para.found) {
      const k = f.ins.kind;
      if (k === "cs" || k === "rs" || k === "es" || k === "else") {
        markers.push({
          kind: k,
          ins: f.ins,
          text: f.body.trim(),
          loc: `${ctx.part}, paragraph ${c.ord}`,
          where,
          start: f.start,
          end: f.end,
          para,
          inline: false
        });
      }
    }
  });
  const matched = matchMarkers(markers);
  const byPara = new Map<number, Marker[]>();
  for (const m of markers) {
    if (matched.has(m)) {
      const list = byPara.get(m.where) ?? [];
      list.push(m);
      byPara.set(m.where, list);
    }
  }
  const seq: Seq<ListEntry>[] = [];
  children.forEach((c, idx) => {
    if (c.kind === "text" || c.dead) {
      seq.push({ n: { k: "other", node: c } });
    } else if (c.name === "w:p") {
      const ms = byPara.get(idx);
      if (ms) {
        splitParagraph(c, paraOf(c), ms, idx, seq);
      } else {
        seq.push({ n: { k: "frag", el: c, origin: idx, idx: 0, cont: false, whole: true, keep: false } });
      }
    } else {
      seq.push({ n: { k: c.name === "w:tbl" ? "table" : c.name === "w:sdt" ? "sdt" : "other", node: c } });
    }
  });
  const out: Out = { nodes: [], last: null, lastOrigin: null, lastFrag: null, killed: new Set(), emitted: new Set(), pendingJoin: null, seam: false };
  emitList(buildTree(seq), scope, out, false, ctx.epoch, ctx);
  return out.nodes;
}

function ensureTrailingPara(cell: XEl): void {
  const last = childEls(cell).at(-1);
  if (last?.name !== "w:p") {
    const p = makeEl("w:p", "<w:p/>", [], true);
    p.parent = cell;
    cell.children.push(p);
  }
}

function processRow(row: XEl, scope: Scope, ctx: Ctx): XEl {
  for (const cell of childEls(row, "w:tc")) {
    cell.children = processList(cell.children, scope, ctx);
    ensureTrailingPara(cell);
  }
  return row;
}

function emitRows(items: TItem<RowEntry>[], scope: Scope, out: XNode[], clone: boolean, ctx: Ctx): void {
  for (const it of items) {
    if (it.t === "node") {
      const e = it.node;
      if (e.k === "other") {
        out.push(clone && e.node.kind === "el" ? cloneIn(ctx, e.node) : e.node);
      } else {
        out.push(processRow(clone ? cloneIn(ctx, e.el) : e.el, scope, ctx));
      }
      continue;
    }
    const plan = planBlock(it, scope, ctx);
    if (plan.error && ctx.devMode) {
      out.push(syntheticRow(plan.error));
    }
    const repeat = it.kind === "rr";
    for (const run of plan.runs) {
      emitRows(run.items, run.scope, out, clone || repeat, ctx);
    }
  }
}

function rowMarkers(row: XEl, where: number, ctx: Ctx): Marker[] {
  const found: Marker[] = [];
  for (const cell of childEls(row, "w:tc")) {
    let depth = 0;
    for (const p of childEls(cell, "w:p")) {
      const para = paraOf(p);
      for (const f of para.found) {
        const k = f.ins.kind;
        if (k === "cs" || k === "rs") {
          depth++;
        } else if (k === "es") {
          depth = Math.max(0, depth - 1);
        } else if (k === "cr" || k === "rr" || k === "er" || (k === "else" && depth === 0)) {
          found.push({ kind: k, ins: f.ins, text: f.body.trim(), loc: `${ctx.part}, row ${row.ord}`, where, start: f.start, end: f.end, para, inline: false });
        }
      }
    }
  }
  return found;
}

function stripRow(row: XEl, ms: Marker[]): boolean {
  for (const m of ms) {
    m.para.kill(m.start, m.end);
  }
  let content = false;
  for (const cell of childEls(row, "w:tc")) {
    for (const c of childEls(cell)) {
      if (c.name === "w:p") {
        content = paraOf(c).apply() || content;
      } else if (c.name !== "w:tcPr") {
        content = true;
      }
    }
  }
  return content;
}

function processTable(tbl: XEl, scope: Scope, ctx: Ctx): XEl | null {
  const markers: Marker[] = [];
  tbl.children.forEach((c, idx) => {
    if (c.kind === "el" && !c.dead && c.name === "w:tr") {
      markers.push(...rowMarkers(c, idx, ctx));
    }
  });
  const matched = matchMarkers(markers);
  const byRow = new Map<number, Marker[]>();
  for (const m of markers) {
    if (matched.has(m)) {
      byRow.set(m.where, [...(byRow.get(m.where) ?? []), m]);
    }
  }
  const seq: Seq<RowEntry>[] = [];
  tbl.children.forEach((c, idx) => {
    if (c.kind === "text" || c.dead || c.name !== "w:tr") {
      seq.push({ n: { k: "other", node: c } });
      return;
    }
    const ms = byRow.get(idx);
    if (!ms) {
      seq.push({ n: { k: "row", el: c } });
      return;
    }
    const keep = stripRow(c, ms);
    const items: Seq<RowEntry>[] = ms.map((m) => ({ m }));
    if (keep) {
      items.splice(ms[0]!.kind === "er" ? 0 : 1, 0, { n: { k: "row", el: c } });
    }
    seq.push(...items);
  });
  const rows: XNode[] = [];
  emitRows(buildTree(seq), scope, rows, false, ctx);
  tbl.children = rows;
  for (const r of rows) {
    if (r.kind === "el") {
      r.parent = tbl;
    }
  }
  return rows.some((r) => r.kind === "el" && r.name === "w:tr") ? tbl : null;
}

interface Issue {
  para: Para;
  el: XEl;
  reason: string;
  /** Where Docmosis puts its marker: the start of the paragraph, or in front of the tag that was never closed. */
  at: number;
}

const tagName = (body: string): string => body.trim().replace(/^[a-z]+_\s*/i, "");

function sectionEnd(open: { body: string; para: Para; f: Found }, end: { body: string }): string | null {
  const wanted = tagName(end.body);
  const have = tagName(open.body);
  return wanted !== "" && wanted !== have ? `Mismatched sections.  Expecting section end for section "${have}" but end is for section "${wanted}"` : null;
}

interface Tag {
  kind: Instruction["kind"];
  body: string;
  para: Para;
  f: Found;
}

/** Checks that block tags in one run of paragraphs pair up, the way Docmosis analyses a template before it merges anything. */
function checkTags(tags: Tag[], row: boolean, issues: Issue[], inCell = false): void {
  const open: Tag[] = [];
  const issue = (t: Tag, reason: string, at = 0): void => {
    issues.push({ para: t.para, el: t.para.el, reason, at });
  };
  const startKinds = row ? ["cr", "rr"] : ["cs", "rs"];
  const endKind = row ? "er" : "es";
  for (const t of tags) {
    const text = t.body.trim();
    if (startKinds.includes(t.kind)) {
      open.push(t);
    } else if (t.kind === "else") {
      const top = open.at(-1);
      if ((!top || (top.kind !== "cs" && top.kind !== "cr")) && !inCell) {
        issue(t, `Unmatched ending tag "${text}"`);
      }
    } else if (t.kind === endKind) {
      const top = open.pop();
      if (!top) {
        issue(t, `Unmatched ending tag "${text}"`);
      } else {
        const bad = sectionEnd(top, t);
        if (bad) {
          issue(t, bad);
        }
      }
    } else if (!row && !inCell) {
      issue(t, `This table-specific field is not inside a table  Suggestion 1:Did you mean "${text.replace(/^(c|r|e)r_/i, "$1s_")}"? `);
    }
  }
  for (const t of open) {
    issue(t, `Section not ended. Name: ${t.body.trim()}  Suggestion 1:Make sure section "${t.body.trim()}" is ended. `, t.f.start);
  }
}

function listTags(children: XNode[]): Tag[] {
  const tags: Tag[] = [];
  for (const c of children) {
    if (c.kind === "el" && !c.dead && c.name === "w:p") {
      const para = paraOf(c);
      for (const f of para.found) {
        const k = f.ins.kind;
        if (k === "cs" || k === "rs" || k === "es" || k === "else" || k === "cr" || k === "rr" || k === "er") {
          tags.push({ kind: k, body: f.body, para, f });
        }
      }
    }
  }
  return tags;
}

/** Counts brackets outside quotes: true when an opening bracket is never closed. */
function unclosedBracket(expr: string): boolean {
  let depth = 0;
  let quote = "";
  for (const ch of expr) {
    if (quote) {
      quote = ch === quote ? "" : quote;
    } else if ("'\"".includes(ch)) {
      quote = ch;
    } else if (ch === "‘" || ch === "“") {
      quote = ch === "‘" ? "’" : "”";
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
  }
  return depth > 0;
}

function expressionIssues(children: XNode[], issues: Issue[]): void {
  for (const c of children) {
    if (c.kind === "el" && !c.dead && c.name === "w:p") {
      const para = paraOf(c);
      for (const f of para.found) {
        const expr = f.body
          .trim()
          .replace(/^(?:[a-z]{2}_|op:)\s*/i, "")
          .replace(/^\{([\s\S]*)\}$/, "$1");
        if (f.ins.kind !== "comment" && f.ins.kind !== "unsupported" && unclosedBracket(expr)) {
          issues.push({ para, el: c, reason: `Expression error for [${straighten(expr)}]:Function is not closed.`, at: 0 });
        }
      }
    }
  }
}

function analyseList(children: XNode[], ctx: Ctx, issues: Issue[], inCell = false): void {
  checkTags(listTags(children), false, issues, inCell);
  expressionIssues(children, issues);
  for (const c of children) {
    if (c.kind !== "el" || c.dead) {
      continue;
    }
    if (c.name === "w:tbl") {
      analyseTable(c, ctx, issues);
    } else if (c.name === "w:sdt") {
      for (const content of childEls(c, "w:sdtContent")) {
        analyseList(content.children, ctx, issues);
      }
    } else if (c.name === "w:p") {
      const para = paraOf(c);
      for (const s of para.segs) {
        if (s.node && !s.el.dead && (s.el.name === "w:drawing" || s.el.name === "w:pict" || s.el.name === "mc:AlternateContent" || s.el.name === "w:object")) {
          for (const box of findDescendants(s.el, "w:txbxContent")) {
            analyseList(box.children, ctx, issues);
          }
        }
      }
    }
  }
}

function analyseTable(tbl: XEl, ctx: Ctx, issues: Issue[]): void {
  const tags: Tag[] = [];
  tbl.children.forEach((c, idx) => {
    if (c.kind !== "el" || c.dead || c.name !== "w:tr") {
      return;
    }
    const rowTags = rowMarkers(c, idx, ctx).map((m) => ({
      kind: m.kind,
      body: m.text,
      para: m.para,
      f: { start: m.start, end: m.end, body: m.text, ins: m.ins }
    }));
    const rowOnly = rowTags.filter((t) => t.kind === "cr" || t.kind === "rr" || t.kind === "er");
    for (const extra of rowOnly.slice(1)) {
      issues.push({
        para: extra.para,
        el: extra.para.el,
        reason: `Tag "${extra.body.trim()}" can't exist in the same table row as another "rr_xxx", "cr_xxx" or "er_xxx" tag.`,
        at: extra.f.start
      });
    }
    tags.push(...rowOnly.slice(0, 1), ...rowTags.filter((t) => t.kind === "else"));
    for (const cell of childEls(c, "w:tc")) {
      analyseList(cell.children, ctx, issues, true);
    }
  });
  checkTags(tags, true, issues);
}

/** Docmosis rejects a template whose blocks don't pair up before merging anything; in devMode it marks each fault and leaves the text alone. */
function analyse(container: XEl, ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  analyseList(container.children, ctx, issues);
  const unclosed = (i: Issue): boolean => i.reason.startsWith("Section not ended");
  const reported = issues.some((i) => !unclosed(i)) ? issues.filter((i) => !unclosed(i)) : issues;
  return reported.sort((a, b) => a.el.ord - b.el.ord);
}

function reportIssues(issues: Issue[], ctx: Ctx): void {
  const seen = new Set<Issue["para"]>();
  for (const i of issues) {
    ctx.messages.push(`${i.reason.trim()} (${ctx.part}, paragraph ${i.el.ord})`);
    if (ctx.devMode && i.para.segs.length > 0) {
      i.para.insert(i.at, ctx.body ? `<<analysis>>Docmosis${++ctx.counter.n}` : `<<analysis>>${i.reason} `);
      seen.add(i.para);
    }
  }
  for (const p of seen) {
    p.apply();
  }
}

/** A document body cannot end in a table: Word needs a paragraph after it, and Docmosis supplies one. */
function endWithParagraph(body: XEl): void {
  const els = body.children.filter((c): c is XEl => c.kind === "el" && !c.dead);
  const sect = els.at(-1)?.name === "w:sectPr" ? els.pop() : undefined;
  if (els.at(-1)?.name === "w:tbl") {
    const p = makeEl("w:p", "<w:p>", [], false);
    p.parent = body;
    body.children.splice(sect ? body.children.indexOf(sect) : body.children.length, 0, p);
  }
}

export function renderPart(
  xml: string,
  part: string,
  scope: Scope,
  devMode: boolean,
  messages: string[],
  counter: { n: number } = { n: 0 },
  budget: Budget = { limits: resolveLimits(), nodes: 0, bytes: 0 }
): string {
  const doc = parseXml(xml);
  const root = childEls(doc)[0];
  if (!root) {
    return xml;
  }
  const container = root.name === "w:document" ? (childEls(root, "w:body")[0] ?? root) : root;
  const ctx: Ctx = { budget, devMode, messages, part, epoch: 0, counter, body: part === "word/document.xml" };
  const issues = analyse(container, ctx);
  if (issues.length > 0) {
    reportIssues(issues, ctx);
    return serializeXml(doc);
  }
  container.children = processList(container.children, scope, ctx);
  if (container.name === "w:body") {
    endWithParagraph(container);
  }
  const out = serializeXml(doc);
  if (out.length > budget.limits.maxOutputBytes) {
    throw new LimitError(`${part} would be larger than ${Math.round(budget.limits.maxOutputBytes / 1048576)} MiB merged`);
  }
  return out;
}

/** Docmosis drops characters XML cannot carry (including `\v` and `\f`) from a value, and a run of tabs becomes one space. */
function cleanValue(value: string): string {
  return stripIllegalXml(value).replace(/\t+/g, " ");
}
