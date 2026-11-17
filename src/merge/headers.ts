import { paraOf } from "./para.ts";
import { childEls, type XEl } from "./xml.ts";

/**
 * Docmosis keeps a section's first-page header and footer on the section's first paragraph or table. When the merge
 * removes that first element (a paragraph of nothing but a block start tag or a comment, or a table whose first row is
 * a row block), the section loses its first-page header, footer and `titlePg`, and page one takes the default ones.
 */

const hasPageBreakSection = (p: XEl): boolean => childEls(p, "w:pPr").some((pr) => childEls(pr, "w:sectPr").length > 0);

function structural(p: XEl): boolean {
  const para = paraOf(p);
  if (!para.found.some((f) => f.ins.kind === "cs" || f.ins.kind === "rs" || f.ins.kind === "comment")) {
    return false;
  }
  let rest = "";
  let pos = 0;
  for (const f of para.found) {
    rest += para.text.slice(pos, f.start);
    pos = f.end;
  }
  return (rest + para.text.slice(pos)).trim() === "";
}

function rowBlockFirst(tbl: XEl): boolean {
  const row = childEls(tbl, "w:tr")[0];
  return !!row && childEls(row, "w:tc").some((tc) => childEls(tc, "w:p").some((p) => paraOf(p).found.some((f) => f.ins.kind === "cr" || f.ins.kind === "rr")));
}

/** For each section of the body, in order, whether its first element is one the merge will remove. */
export function removedFirsts(body: XEl): boolean[] {
  const out: boolean[] = [];
  let first = true;
  for (const c of childEls(body)) {
    if (c.name === "w:sectPr") {
      if (first) {
        out.push(false);
      }
      break;
    }
    if (c.name !== "w:p" && c.name !== "w:tbl") {
      continue;
    }
    if (first) {
      out.push(c.name === "w:p" ? !hasPageBreakSection(c) && structural(c) : rowBlockFirst(c));
      first = false;
    }
    if (c.name === "w:p" && hasPageBreakSection(c)) {
      first = true;
    }
  }
  return out;
}

function sectionProps(body: XEl): XEl[] {
  const out: XEl[] = [];
  for (const c of childEls(body)) {
    if (c.name === "w:p") {
      out.push(...childEls(c, "w:pPr").flatMap((pr) => childEls(pr, "w:sectPr")));
    } else if (c.name === "w:sectPr") {
      out.push(c);
    }
  }
  return out;
}

/** Strips the first-page header, footer and `titlePg` from each section whose first element was removed. */
export function dropFirstPageStyles(body: XEl, removed: boolean[]): void {
  const sects = sectionProps(body);
  if (!removed.some(Boolean) || sects.length !== removed.length) {
    return;
  }
  sects.forEach((sect, i) => {
    if (!removed[i]) {
      return;
    }
    for (const c of childEls(sect)) {
      const first = /\sw:type\s*=\s*"first"/.test(c.open);
      if (c.name === "w:titlePg" || (first && (c.name === "w:headerReference" || c.name === "w:footerReference"))) {
        c.dead = true;
      }
    }
  });
}
