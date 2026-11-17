import { ExpressionError, evaluate, formatValue, type Instruction, type Scope, truthy } from "./expr.ts";
import { type Found, type Para, paraOf } from "./para.ts";
import { childEls, cloneEl, encodeText, findDescendants, makeEl, parseXml, serializeXml, type XEl, type XNode } from "./xml.ts";

export interface Ctx {
  devMode: boolean;
  messages: string[];
  part: string;
  epoch: number;
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
}

type TItem<N> = { t: "node"; node: N } | TBlock<N>;

type Seq<N> = { m: Marker } | { n: N };

type ListEntry = { k: "frag"; el: XEl; origin: number; cont: boolean } | { k: "table" | "sdt" | "other"; node: XNode };

type RowEntry = { k: "row"; el: XEl } | { k: "other"; node: XNode };

const isStart = (k: Marker["kind"]): boolean => k === "cs" || k === "cr" || k === "rs" || k === "rr";

function fail(ctx: Ctx, reason: string, text: string, where: string): string {
  ctx.messages.push(`${reason}: <<${text}>> (${ctx.part}, ${where})`);
  return `[ERROR: ${reason} <<${text}>>]`;
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
        top.push(m);
      }
    } else {
      const top = stack.pop();
      if (top) {
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
      const block: TBlock<N> = { t: "block", kind: m.kind as TBlock<N>["kind"], head: m, inline: m.inline, branches: [{ head: m, items: [] }] };
      cur.push(block);
      stack.push({ block, parent: cur });
      cur = block.branches[0]!.items;
    } else if (m.kind === "else") {
      const branch: TBranch<N> = { head: m, items: [] };
      stack.at(-1)!.block.branches.push(branch);
      cur = branch.items;
    } else {
      cur = stack.pop()!.parent;
    }
  }
  return root;
}

interface Plan<N> {
  runs: { items: TItem<N>[]; scope: Scope }[];
  error?: string;
}

function planBlock<N>(block: TBlock<N>, scope: Scope, ctx: Ctx): Plan<N> {
  try {
    if (block.kind === "cs" || block.kind === "cr") {
      for (const br of block.branches) {
        const ins = br.head.ins;
        const cond = ins.kind === "cs" || ins.kind === "cr" || ins.kind === "else" ? ins.cond : undefined;
        if (cond === undefined || truthy(evaluate(cond, scope))) {
          return { runs: [{ items: br.items, scope }] };
        }
      }
      return { runs: [] };
    }
    const ins = block.head.ins;
    const value = ins.kind === "rs" || ins.kind === "rr" ? evaluate(ins.expr, scope) : undefined;
    const list = Array.isArray(value) ? value : truthy(value) ? [value] : [];
    return { runs: list.map((item, i) => ({ items: block.branches[0]!.items, scope: scope.child(item, i + 1, list.length) })) };
  } catch (e) {
    const reason = e instanceof ExpressionError || e instanceof Error ? e.message : String(e);
    return { runs: [], error: fail(ctx, reason, block.head.text, block.head.loc) };
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
  killed: Set<string>;
}

function pushNode(out: Out, node: XNode): void {
  out.nodes.push(node);
  out.lastOrigin = null;
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

function renderFragment(el: XEl, scope: Scope, ctx: Ctx): XEl | null | "op" {
  const para = paraOf(el);
  const where = `paragraph ${el.ord}`;
  for (const p of para.problems) {
    ctx.messages.push(`${p} (${ctx.part}, ${where})`);
  }
  if (para.found.length === 0) {
    processTextBoxes(para, scope, ctx);
    return el;
  }
  let hadMarker = false;
  let opBlank = false;
  const failAt = (f: Found, reason: string): void => {
    const text = fail(ctx, reason, f.body.trim(), where);
    para.kill(f.start, f.end);
    if (ctx.devMode) {
      para.insert(f.start, text);
    }
  };
  for (const f of para.found) {
    const ins = f.ins;
    try {
      if (ins.kind === "field") {
        const value = formatValue(evaluate(ins.expr, scope));
        opBlank ||= ins.optionalParagraph && value.trim() === "";
        para.kill(f.start, f.end);
        para.insert(f.start, value);
      } else if (ins.kind === "assign") {
        scope.setVar(ins.name, evaluate(ins.expr, scope));
        para.kill(f.start, f.end);
        hadMarker = true;
      } else if (ins.kind === "comment") {
        para.kill(f.start, f.end);
        hadMarker = true;
      } else if (ins.kind === "unsupported") {
        failAt(f, `unsupported instruction${ins.reason ? ` (${ins.reason})` : ""}`);
      } else {
        failAt(f, ORPHAN[ins.kind] ?? "is not valid here");
      }
    } catch (e) {
      failAt(f, e instanceof Error ? e.message : String(e));
    }
  }
  const content = para.apply();
  if (opBlank) {
    return "op";
  }
  if (hadMarker && !content && !hasSectPr(el)) {
    return null;
  }
  processTextBoxes(para, scope, ctx);
  return el;
}

function emitEntry(entry: ListEntry, scope: Scope, out: Out, clone: boolean, epoch: number, ctx: Ctx): void {
  if (entry.k === "frag") {
    const key = `${entry.origin}:${epoch}`;
    if (out.killed.has(key)) {
      return;
    }
    const r = renderFragment(clone ? cloneEl(entry.el) : entry.el, scope, ctx);
    if (r === "op") {
      if (out.lastOrigin === key) {
        out.nodes.pop();
      }
      out.killed.add(key);
      out.lastOrigin = null;
    } else if (r) {
      if (entry.cont && out.lastOrigin === key && out.last) {
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
        out.lastOrigin = key;
      }
    }
    return;
  }
  const node = entry.node;
  if (node.kind === "text") {
    pushNode(out, node);
    return;
  }
  const el = clone ? cloneEl(node) : node;
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
    for (const run of plan.runs) {
      const ep = repeat && !it.inline ? ++ctx.epoch : epoch;
      emitList(run.items, run.scope, out, clone || repeat, ep, ctx);
    }
  }
}

function splitParagraph(el: XEl, para: Para, ms: Marker[], origin: number, seq: Seq<ListEntry>[]): void {
  let kept = false;
  const frag = (a: number, b: number, cont: boolean, force = false): void => {
    const empty = cont ? b <= a : para.text.slice(a, b).trim() === "";
    if (empty && !force) {
      return;
    }
    kept = true;
    const copy = cloneEl(el);
    const p = paraOf(copy);
    p.kill(0, a);
    p.kill(b, para.text.length);
    p.apply();
    seq.push({ n: { k: "frag", el: copy, origin, cont } });
  };
  for (let i = 0; i < ms.length; i++) {
    frag(i === 0 ? 0 : ms[i - 1]!.end, ms[i]!.start, i > 0 && ms[i - 1]!.inline);
    seq.push({ m: ms[i]! });
  }
  const last = ms.at(-1)!;
  frag(last.end, para.text.length, last.inline);
  if (!kept && hasSectPr(el)) {
    frag(para.text.length, para.text.length, false, true);
  }
}

export function processList(children: XNode[], scope: Scope, ctx: Ctx): XNode[] {
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
        seq.push({ n: { k: "frag", el: c, origin: idx, cont: false } });
      }
    } else {
      seq.push({ n: { k: c.name === "w:tbl" ? "table" : c.name === "w:sdt" ? "sdt" : "other", node: c } });
    }
  });
  const out: Out = { nodes: [], last: null, lastOrigin: null, killed: new Set() };
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
        out.push(clone && e.node.kind === "el" ? cloneEl(e.node) : e.node);
      } else {
        out.push(processRow(clone ? cloneEl(e.el) : e.el, scope, ctx));
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

export function renderPart(xml: string, part: string, scope: Scope, devMode: boolean, messages: string[]): string {
  const doc = parseXml(xml);
  const root = childEls(doc)[0];
  if (!root) {
    return xml;
  }
  const container = root.name === "w:document" ? (childEls(root, "w:body")[0] ?? root) : root;
  const ctx: Ctx = { devMode, messages, part, epoch: 0 };
  container.children = processList(container.children, scope, ctx);
  return serializeXml(doc);
}
