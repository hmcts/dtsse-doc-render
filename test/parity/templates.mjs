// Generates sample data for real templates and diffs a licensed Docmosis against a dtsse-doc-render instance.
//
//   node test/parity/templates.mjs <path to hmcts/docmosis Templates/Base> <template-name ...> [--dir <out>] [--pdf]
//
// Names are file names without ".docx". The data is built from the data names each template reads: a repeat gets two
// items, a bare condition gets true, everything else a "v_<name>" string, and dates are shaped to the input pattern of the
// dateFormat that reads them. Output files (data, both texts and a diff) go to --dir, default a temp directory.
// Environment variables are the same as compare.mjs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzip } from "../support/zip.ts";
import { diffLines } from "./compare-lib.mjs";
import { outcomeLines, renderOnDocmosis, renderOnRenderer } from "./lib.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const outDir = flag("--dir") ?? mkdtempSync(join(tmpdir(), "parity-templates-"));
const [templatesDir, ...names] = argv;
if (!templatesDir || names.length === 0) {
  console.error("usage: node test/parity/templates.mjs <Templates/Base dir> <template-name ...> [--dir <out>]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const PREFIXED = /^(op|link|ref|html|image|img|bookmark|md):/;
const NOT_DATA = new Set(["true", "false", "null", "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge", "in", "empty"]);
const TOKEN = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|‘[^’]*’|“[^”]*”|\d+(?:\.\d+)?|\$[A-Za-z_]\w*|[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*|\s*\[\s*\d+\s*\])*|\S/g;

function dataRefs(instruction) {
  let b = instruction.trim();
  if (b.startsWith("/*")) {
    return [];
  }
  const block = /^(cs|cr|rs|rr|es|er)_(.*)$/s.exec(b);
  if (block) {
    if (block[1] === "es" || block[1] === "er") {
      return [];
    }
    b = block[2];
  } else if (/^else(_|$)/.test(b)) {
    b = b.slice(5);
  } else {
    b = b.replace(PREFIXED, "");
  }
  const assign = /^\$[A-Za-z_]\w*\s*=(?!=)/.exec(b);
  if (assign) {
    b = b.slice(assign[0].length);
  }
  const refs = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(b); m; m = TOKEN.exec(b)) {
    if (!/^[A-Za-z_]/.test(m[0])) {
      continue;
    }
    let name = m[0].replace(/\s+/g, "");
    if (/^\s*\(/.test(b.slice(TOKEN.lastIndex))) {
      const dot = name.lastIndexOf(".");
      if (dot < 0) {
        continue;
      }
      name = name.slice(0, dot);
    }
    if (!NOT_DATA.has(name.toLowerCase()) && !refs.includes(name)) {
      refs.push(name);
    }
  }
  return refs;
}

/** The instructions of every content part as a tree: blocks hold what is inside them, an else is a child of its block. */
function instructionTree(docx) {
  const parts = unzip(docx);
  const roots = [];
  for (const [name, buffer] of parts) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
      continue;
    }
    const root = { children: [] };
    const stack = [{ node: null, container: root.children }];
    for (const [paragraph] of buffer.toString("utf8").matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
      const text = decode([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));
      for (const [, body] of text.matchAll(/<<([\s\S]*?)>>/g)) {
        const b = body.trim();
        const kw = /^(cs|cr|rs|rr|es|er)_/.exec(b);
        const top = stack[stack.length - 1];
        if (kw && (kw[1] === "es" || kw[1] === "er")) {
          if (stack.length > 1) {
            stack.pop();
          }
        } else if (kw) {
          const node = { type: kw[1] === "rs" || kw[1] === "rr" ? "repeat" : "condition", text: b, dataRefs: dataRefs(b), children: [] };
          top.container.push(node);
          stack.push({ node, container: node.children });
        } else if (/^else(_|$)/.test(b)) {
          const owner = top.node;
          const node = { type: "else", text: b, dataRefs: dataRefs(b), children: [] };
          if (owner) {
            owner.children.push(node);
            top.container = node.children;
          }
        } else {
          top.container.push({ type: "field", text: b, dataRefs: dataRefs(b), children: [] });
        }
      }
    }
    roots.push(root);
  }
  return roots;
}

const segments = (path) => [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? +m[2] : m[1]));
const rank = (v) =>
  Array.isArray(v) || (v && typeof v === "object") ? 5 : v === true ? 4 : typeof v === "string" && !v.startsWith("v_") ? 3 : typeof v === "string" ? 2 : 0;

function dateFor(pattern) {
  const tokens = { yyyy: "2026", yy: "26", MM: "03", dd: "15", HH: "10", hh: "10", mm: "30", ss: "45", SSS: "123", M: "3", d: "15", H: "10", a: "AM" };
  return pattern.replace(/[‘’“”]/g, "'").replace(/'[^']*'|([A-Za-z])\1*/g, (t) => (t[0] === "'" ? t.slice(1, -1) || "'" : (tokens[t] ?? tokens[t[0]] ?? t)));
}

function ensure(obj, reference, kind, root, parent, dateIn) {
  let ref = reference;
  let cur = obj;
  if (ref.startsWith("$root.")) {
    [cur, ref] = [root, ref.slice(6)];
  } else if (ref.startsWith("$parent.")) {
    [cur, ref] = [parent ?? root, ref.slice(8)];
  } else if (ref.startsWith("$this.")) {
    ref = ref.slice(6);
  } else if (ref.startsWith("$")) {
    return;
  }
  const segs = segments(ref);
  for (let i = 0; i < segs.length; i++) {
    const key = segs[i];
    const last = i === segs.length - 1;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) {
        return;
      }
      while (cur.length <= key) {
        cur.push(null);
      }
      if (last) {
        cur[key] ||= "v";
        return;
      }
      if (!cur[key] || typeof cur[key] !== "object") {
        cur[key] = {};
      }
      cur = cur[key];
      continue;
    }
    if (last) {
      const next = kind === "list" ? [{}, {}] : kind === "bool" ? true : dateIn[reference] ? dateFor(dateIn[reference]) : `v_${key}`;
      if ((cur[key] === undefined || rank(next) > rank(cur[key])) && !(Array.isArray(cur[key]) && !Array.isArray(next))) {
        cur[key] = next;
      }
      return;
    }
    if (cur[key] === undefined || typeof cur[key] !== "object" || cur[key] === null) {
      cur[key] = typeof segs[i + 1] === "number" ? [] : {};
    }
    cur = cur[key];
  }
}

function fill(nodes, obj, root, parent, dateIn) {
  for (const n of nodes) {
    if (n.type === "repeat") {
      const ref = n.dataRefs[0];
      if (!ref) {
        continue;
      }
      ensure(obj, ref, "list", root, parent, dateIn);
      let target = obj;
      let path = ref;
      if (ref.startsWith("$root.")) {
        [target, path] = [root, ref.slice(6)];
      } else if (ref.startsWith("$parent.")) {
        [target, path] = [parent ?? root, ref.slice(8)];
      }
      for (const key of segments(path)) {
        target = target?.[key];
      }
      const usesThis = n.children.some((c) => /\$this(?![\w.])/.test(c.text) && c.type !== "repeat");
      if (Array.isArray(target) && usesThis && target.every((x) => x && typeof x === "object" && !Object.keys(x).length)) {
        for (let i = 0; i < target.length; i++) {
          target[i] = `item${i + 1}`;
        }
      }
      if (Array.isArray(target)) {
        for (const item of target) {
          if (item && typeof item === "object") {
            fill(n.children, item, root, obj, dateIn);
          }
        }
      }
      continue;
    }
    const bare = /^\s*(?:cs_|cr_|else_)\s*\{?\s*!?\s*([A-Za-z_][\w.[\]]*)\s*\}?\s*$/.test(n.text);
    const boolRefs = new Set([...n.text.matchAll(/([A-Za-z_][\w.[\]]*)\s*={1,2}\s*[‘’']?true[‘’']?/g)].map((m) => m[1]));
    for (const ref of n.dataRefs) {
      ensure(obj, ref, (n.type === "condition" || n.type === "else") && (bare || boolRefs.has(ref)) ? "bool" : "str", root, parent, dateIn);
    }
    fill(n.children, obj, root, parent, dateIn);
  }
}

function dateInputs(nodes, found = {}) {
  for (const n of nodes) {
    for (const m of n.text.matchAll(/dateFormat\(\s*([\w$.[\]]+)\s*,\s*[‘’'“”"].*?[‘’'“”"]\s*,\s*[‘’'“”"](.*?)[‘’'“”"]\s*\)/g)) {
      found[m[1].replace(/^\$this\./, "")] = m[2];
    }
    dateInputs(n.children, found);
  }
  return found;
}

export function generateData(docx) {
  const roots = instructionTree(docx);
  const dateIn = {};
  for (const root of roots) {
    dateInputs(root.children, dateIn);
  }
  const data = {};
  for (const root of roots) {
    fill(root.children, data, data, data, dateIn);
  }
  return data;
}

let differing = 0;
for (const name of names) {
  const file = join(templatesDir, `${name.replace(/\.docx$/, "")}.docx`);
  const data = generateData(readFileSync(file));
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(data, null, 1));
  const [docmosis, renderer] = [
    await renderOnDocmosis(file, data, { devMode: true, label: name }),
    await renderOnRenderer(file, data, { devMode: true, label: name })
  ];
  const [a, b] = [outcomeLines(docmosis), outcomeLines(renderer)];
  writeFileSync(join(outDir, `${name}.docmosis.txt`), `${a.join("\n")}\n`);
  writeFileSync(join(outDir, `${name}.renderer.txt`), `${b.join("\n")}\n`);
  const diff = diffLines(a, b);
  if (diff.length) {
    differing++;
    writeFileSync(join(outDir, `${name}.diff`), `${diff.join("\n")}\n`);
    console.log(`DIFF ${name}: ${diff.length / 3} lines differ`);
    console.log(diff.slice(0, 30).join("\n"));
  } else {
    console.log(`same ${name}`);
  }
}
console.log(`\n${names.length - differing} of ${names.length} templates match. Files are in ${outDir}`);
process.exit(differing ? 1 : 0);
