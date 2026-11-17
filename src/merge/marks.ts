import { childEls, type XEl, type XNode } from "./xml.ts";

/**
 * Docmosis loads the merged document into LibreOffice through its API, and what comes out has the formatting of the
 * paragraph mark (the `w:rPr` inside `w:pPr`, which a numbered paragraph's label is drawn with) rewritten from the
 * paragraph's text:
 *
 * - when every run has the same formatting, the mark keeps its own properties and gains the run's;
 * - when the runs differ, the mark loses every property, so the label falls back to the style's font and size.
 *
 * Handing LibreOffice the mark as written leaves a bold-then-plain numbered paragraph with an Arial label where
 * Docmosis has a Calibri one, so the merge makes the same rewrite.
 */

const RUN_ORDER = [
  "w:rStyle",
  "w:rFonts",
  "w:b",
  "w:bCs",
  "w:i",
  "w:iCs",
  "w:caps",
  "w:smallCaps",
  "w:strike",
  "w:dstrike",
  "w:outline",
  "w:shadow",
  "w:emboss",
  "w:imprint",
  "w:noProof",
  "w:snapToGrid",
  "w:vanish",
  "w:webHidden",
  "w:color",
  "w:spacing",
  "w:w",
  "w:kern",
  "w:position",
  "w:sz",
  "w:szCs",
  "w:highlight",
  "w:u",
  "w:effect",
  "w:bdr",
  "w:shd",
  "w:fitText",
  "w:vertAlign",
  "w:rtl",
  "w:cs",
  "w:em",
  "w:lang",
  "w:eastAsianLayout",
  "w:specVanish",
  "w:oMath"
];

const CONTENT = new Set([
  "w:t",
  "w:tab",
  "w:br",
  "w:cr",
  "w:sym",
  "w:ptab",
  "w:noBreakHyphen",
  "w:softHyphen",
  "w:drawing",
  "w:pict",
  "w:object",
  "w:footnoteReference",
  "w:endnoteReference"
]);
const OPAQUE = new Set(["w:pPr", "w:drawing", "w:pict", "w:object", "mc:AlternateContent", "w:txbxContent"]);
const TRACKED = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange"]);

const canon = (node: XNode): string => {
  if (node.kind === "text") {
    return node.raw;
  }
  return `${node.open.replace(/\sw:rsid\w*="[^"]*"/g, "")}${node.children.map(canon).join("")}`;
};

function hasContent(run: XEl): boolean {
  return run.children.some(
    (c) => c.kind === "el" && !c.dead && CONTENT.has(c.name) && (c.name !== "w:t" || c.children.some((t) => t.kind === "text" && t.raw !== ""))
  );
}

function collectRuns(el: XEl, into: XEl[]): void {
  for (const c of childEls(el)) {
    if (c.name === "w:r") {
      into.push(c);
    } else if (!OPAQUE.has(c.name)) {
      collectRuns(c, into);
    }
  }
}

/** The formatting of each stretch of text in the paragraph, runs with identical formatting counting once. */
function portions(p: XEl): XEl[][] {
  const runs: XEl[] = [];
  collectRuns(p, runs);
  const out: XEl[][] = [];
  let last: string | undefined;
  for (const run of runs.filter(hasContent)) {
    const props = childEls(run, "w:rPr")[0];
    const key = props ? props.children.map(canon).join("") : "";
    if (key !== last) {
      out.push(props ? childEls(props) : []);
      last = key;
    }
  }
  return out;
}

const rank = (el: XEl): number => {
  const i = RUN_ORDER.indexOf(el.name);
  return i < 0 ? RUN_ORDER.length : i;
};

function rewriteMark(p: XEl): void {
  const pPr = childEls(p, "w:pPr")[0];
  const mark = pPr && childEls(pPr, "w:rPr")[0];
  if (!pPr || !mark) {
    return;
  }
  const own = childEls(mark);
  if (own.some((c) => TRACKED.has(c.name))) {
    return;
  }
  const found = portions(p);
  if (found.length === 0) {
    return;
  }
  if (found.length > 1) {
    mark.children = [];
    mark.selfClose = false;
    mark.open = "<w:rPr>";
    return;
  }
  const have = new Set(own.map((c) => c.name));
  const added = found[0]!.filter((c) => c.name !== "w:rStyle" && !have.has(c.name));
  if (added.length === 0) {
    return;
  }
  const merged = [...own, ...added].sort((a, b) => rank(a) - rank(b));
  mark.children = merged.map((c) => ({ ...c, parent: mark }));
  mark.selfClose = false;
  mark.open = mark.open.replace(/\/>$/, ">");
}

function walk(el: XEl): void {
  for (const c of childEls(el)) {
    if (c.name === "w:p") {
      rewriteMark(c);
    }
    walk(c);
  }
}

export function rewriteParagraphMarks(container: XEl): void {
  walk(container);
}
