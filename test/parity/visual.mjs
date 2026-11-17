// Measures how visually close dtsse-doc-render's PDFs are to a licensed Docmosis's.
//
//   node test/parity/visual.mjs <Templates/Base dir> [name ...] [--sample N] [--include <file>] [--out <dir>] [--seed S] [--jobs J] [--reuse]
//
// With names, those templates are measured. With --sample N, a sample of N is drawn, proportional by jurisdiction prefix
// (the text before the first "-"), and every name listed in the --include file (one per line) is always in it.
// Each template is rendered to PDF on both backends with devMode on, the PDFs are rasterised and compared in a
// throwaway container built from test/parity/visual/Dockerfile, and <out>/summary.json and <out>/report.html are written.
// --reuse keeps PDFs already in <out>/work and only re-analyses them. Environment variables are the same as compare.mjs; VISUAL_FUZZ sets the anti-alias tolerance (default 12%).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataWithIncludes } from "./datagen.mjs";
import { renderOnDocmosis, renderOnRenderer } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = "dtsse-doc-render-visual";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv.splice(i, 2)[1];
};
const outDir = resolve(flag("--out", "visual-out"));
const sampleSize = Number(flag("--sample", 0));
const includeFile = flag("--include");
const seed = Number(flag("--seed", 1));
const jobs = Number(flag("--jobs", 3));
const reuse = argv.includes("--reuse") && argv.splice(argv.indexOf("--reuse"), 1).length > 0;
const [templatesDir, ...explicit] = argv;
if (!templatesDir || (!explicit.length && !sampleSize)) {
  console.error("usage: node test/parity/visual.mjs <Templates/Base dir> [name ...] [--sample N] [--include file] [--out dir]");
  process.exit(2);
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1 << 28, ...opts }).toString();
const stripExt = (n) => n.replace(/\.docx$/, "");

function rng(s) {
  let x = s >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}

/** A sample of the given size, proportional by prefix with at least one per prefix, always holding the required names. */
const MIN_STRATUM = 15;

export function stratifiedSample(all, size, required, seedValue) {
  const rand = rng(seedValue);
  const chosen = new Set(required.filter((n) => all.includes(n)));
  const counts = {};
  for (const n of all) {
    counts[n.split("-")[0]] = (counts[n.split("-")[0]] ?? 0) + 1;
  }
  const groups = new Map();
  for (const n of all) {
    const p = n.split("-")[0];
    const stratum = counts[p] >= MIN_STRATUM ? p : "other";
    groups.set(stratum, [...(groups.get(stratum) ?? []), n]);
  }
  const quotas = [...groups].map(([prefix, members]) => ({
    prefix,
    members,
    quota: Math.max(1, Math.round((members.length / all.length) * size))
  }));
  for (const { members, quota } of quotas.sort((a, b) => b.members.length - a.members.length)) {
    const have = members.filter((m) => chosen.has(m)).length;
    const pool = members.filter((m) => !chosen.has(m));
    for (let i = have; i < quota && pool.length; i++) {
      chosen.add(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }
  return [...chosen].sort();
}

const median = (xs) => {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function parseLines(html) {
  const pages = [];
  for (const [, pageAttrs, body] of html.matchAll(/<page([^>]*)>([\s\S]*?)<\/page>/g)) {
    const height = Number(/height="([\d.]+)"/.exec(pageAttrs)?.[1] ?? 842);
    const lines = [];
    lines.height = height;
    for (const [, attrs, inner] of body.matchAll(/<line ([^>]*)>([\s\S]*?)<\/line>/g)) {
      const num = (k) => Number(new RegExp(`${k}="([\\d.]+)"`).exec(attrs)[1]);
      const text = [...inner.matchAll(/<word[^>]*>([^<]*)<\/word>/g)]
        .map((m) => m[1])
        .join(" ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        lines.push({ text, x: num("xMin"), y: num("yMin"), band: num("yMin") < 70 || num("yMin") > height - 70 });
      }
    }
    pages.push(lines);
  }
  return pages;
}

/** Lines matched by text (the nth occurrence of a text on one side against the nth on the other), with how far each moved. */
export function shift(pagesA, pagesB) {
  const index = (pages) => {
    const m = new Map();
    for (const [page, lines] of pages.entries()) {
      for (const l of lines) {
        m.set(l.text, [...(m.get(l.text) ?? []), { ...l, page }]);
      }
    }
    return m;
  };
  const [ia, ib] = [index(pagesA), index(pagesB)];
  const dx = [];
  const dy = [];
  let matched = 0;
  let movedPage = 0;
  let total = 0;
  for (const [text, as] of ia) {
    total += as.length;
    const bs = ib.get(text) ?? [];
    as.slice(0, bs.length).forEach((a, i) => {
      matched++;
      const b = bs[i];
      if (a.page !== b.page) {
        movedPage++;
        return;
      }
      dx.push(Math.abs(b.x - a.x));
      dy.push(Math.abs(b.y - a.y));
    });
  }
  const totalB = [...ib.values()].reduce((n, v) => n + v.length, 0);
  const unmatched = (from, other) => [...from].flatMap(([text, ls]) => ls.slice((other.get(text) ?? []).length));
  const missingFromB = unmatched(ia, ib);
  const extraInB = unmatched(ib, ia);
  const bag = (pages) => {
    const m = new Map();
    for (const l of pages.flat().filter((x) => !x.band)) {
      for (const w of l.text.replace(/-$/, "").split(" ")) {
        m.set(w, (m.get(w) ?? 0) + 1);
      }
    }
    return m;
  };
  const wordsOnly = (x, y) => [...x].reduce((n, [w, c]) => n + Math.max(0, c - (y.get(w) ?? 0)), 0);
  const [bagA, bagB] = [bag(pagesA), bag(pagesB)];
  const hyphenEnds = (pages) => pages.flat().filter((l) => /[a-z]-$/.test(l.text)).length;
  const bandOf = (ls) => ls.filter((l) => l.band).length;
  const r = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    linesA: total,
    linesB: totalB,
    matched,
    movedPage,
    wordsOnlyDocmosis: wordsOnly(bagA, bagB),
    wordsOnlyRenderer: wordsOnly(bagB, bagA),
    words: [...bagA.values()].reduce((n, c) => n + c, 0),
    hyphenatedLinesDocmosis: hyphenEnds(pagesA),
    hyphenatedLinesRenderer: hyphenEnds(pagesB),
    onlyDocmosis: missingFromB.length,
    onlyRenderer: extraInB.length,
    onlyDocmosisInHeaderFooter: bandOf(missingFromB),
    onlyRendererInHeaderFooter: bandOf(extraInB),
    rawTagLinesDocmosis: [...ia.keys()].filter((t) => /<<|>>/.test(t)).length,
    rawTagLinesRenderer: [...ib.keys()].filter((t) => /<<|>>/.test(t)).length,
    medianDx: r(median(dx)),
    maxDx: r(dx.length ? Math.max(...dx) : null),
    medianDy: r(median(dy)),
    maxDy: r(dy.length ? Math.max(...dy) : null)
  };
}

const fontNames = (txt) =>
  txt
    .split("\n")
    .slice(2)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((n) => n.replace(/^[A-Z]{6}\+/, ""));

/** Families that are metric-compatible are one family, so Arial against Liberation Sans is not a layout difference. */
const FAMILY = [
  [/^(arial(?!black)|helvetica|liberationsans)/, "sans-arial"],
  [/^(timesnewroman|times|liberationserif)/, "serif-times"],
  [/^(calibri(?!light)|carlito)/, "calibri"],
  [/^(couriernew|courier|liberationmono)/, "mono-courier"]
];
const family = (n) => {
  const k = n.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FAMILY.find(([re]) => re.test(k))?.[1] ?? k.replace(/(bold|italic|oblique|regular|mt|ps)+$/g, "");
};

const imageCount = (txt) => Math.max(0, txt.split("\n").filter((l) => /^\s*\d+\s+\d+\s+(image|smask)/.test(l)).length);

/** Heuristic labels for why a template differs, most significant first. They point at where to look, they do not prove a cause. */
function causes(r) {
  const sh = r.shift;
  const out = [];
  const inBand = sh.onlyDocmosisInHeaderFooter + sh.onlyRendererInHeaderFooter;
  const wordDiff = sh.wordsOnlyDocmosis + sh.wordsOnlyRenderer;
  if (sh.rawTagLinesRenderer > sh.rawTagLinesDocmosis) {
    out.push("merge");
  }
  if (inBand > 0) {
    out.push("header-footer");
  }
  if (r.imagesDocmosis !== r.imagesRenderer) {
    out.push("images");
  }
  if (r.fontsDiffer) {
    out.push("fonts");
  }
  if (!r.fontsDiffer && (sh.maxDx ?? 0) > 3) {
    out.push("horizontal");
  }
  if (wordDiff > Math.max(6, 0.03 * sh.words)) {
    out.push("text-reflow");
  }
  if (Math.abs(sh.hyphenatedLinesDocmosis - sh.hyphenatedLinesRenderer) >= 2) {
    out.push("hyphenation");
  }
  if (!r.samePageCount) {
    out.push("page-count");
  }
  if (!out.length && ((sh.medianDy ?? 0) > 1 || (r.meanMismatchPct ?? 0) > 1.5)) {
    out.push("layout-engine");
  }
  return out;
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        await fn(queue.shift());
      }
    })
  );
}

const all = readdirSync(templatesDir)
  .filter((f) => f.endsWith(".docx"))
  .map(stripExt)
  .sort();
const required =
  includeFile && existsSync(includeFile)
    ? readFileSync(includeFile, "utf8")
        .split("\n")
        .map((l) => stripExt(l.trim()))
        .filter(Boolean)
    : [];
const names = explicit.length ? explicit.map(stripExt) : stratifiedSample(all, sampleSize, required, seed);

const work = join(outDir, "work");
if (!reuse) {
  rmSync(work, { recursive: true, force: true });
}
mkdirSync(work, { recursive: true });
console.log(`measuring ${names.length} templates into ${outDir}`);

const results = new Map();
await pool(names, jobs, async (name) => {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const file = join(templatesDir, `${name}.docx`);
  const rec = { name };
  results.set(name, rec);
  if (reuse && existsSync(join(dir, "a.pdf")) && existsSync(join(dir, "b.pdf"))) {
    Object.assign(rec, { docmosisOk: true, rendererOk: true });
    return;
  }
  try {
    const { data, includes } = dataWithIncludes(readFileSync(file), templatesDir);
    writeFileSync(join(dir, "data.json"), JSON.stringify(data, null, 1));
    const [a, b] = await Promise.all([
      renderOnDocmosis(file, data, { format: "pdf", devMode: true, label: name, includes }),
      renderOnRenderer(file, data, { format: "pdf", devMode: true, includes })
    ]);
    rec.docmosisOk = a.ok;
    rec.rendererOk = b.ok;
    if (a.ok) {
      writeFileSync(join(dir, "a.pdf"), a.buffer);
    }
    if (b.ok) {
      writeFileSync(join(dir, "b.pdf"), b.buffer);
    }
    if (!a.ok || !b.ok) {
      rec.error = { docmosis: a.error?.shortMsg, renderer: b.error?.shortMsg ?? b.error?.longMsg };
    }
  } catch (e) {
    rec.error = { generator: String(e.message ?? e) };
  }
  console.log(`rendered ${name}${rec.error ? " (failed)" : ""}`);
});

const measurable = [...results.values()].filter((r) => r.docmosisOk && r.rendererOk);
for (const r of results.values()) {
  if (!(r.docmosisOk && r.rendererOk) && !reuse) {
    rmSync(join(work, r.name), { recursive: true, force: true });
  }
}

if (measurable.length) {
  sh("docker", ["build", "-q", "-t", IMAGE, join(here, "visual")]);
  const container = sh("docker", ["create", "-e", `FUZZ=${process.env.VISUAL_FUZZ ?? "12%"}`, IMAGE, "/work"]).trim();
  try {
    sh("docker", ["cp", `${work}/.`, `${container}:/work`]);
    sh("docker", ["start", "-a", container]);
    sh("docker", ["cp", `${container}:/work/.`, work]);
  } finally {
    sh("docker", ["rm", "-f", container]);
  }
}

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
for (const r of measurable) {
  const dir = join(work, r.name);
  const [fa, fb] = [read(join(dir, "a.fonts")), read(join(dir, "b.fonts"))];
  r.fontsDocmosis = [...new Set(fontNames(fa))].sort();
  r.fontsRenderer = [...new Set(fontNames(fb))].sort();
  const fam = (xs) => [...new Set(xs.map(family))].sort().join("|");
  r.fontsDiffer = fam(r.fontsDocmosis) !== fam(r.fontsRenderer);
  r.fontsOnlyDocmosis = [...new Set(r.fontsDocmosis.map(family))].filter((f) => !r.fontsRenderer.map(family).includes(f));
  r.fontsOnlyRenderer = [...new Set(r.fontsRenderer.map(family))].filter((f) => !r.fontsDocmosis.map(family).includes(f));
  r.imagesDocmosis = imageCount(read(join(dir, "a.images")));
  r.imagesRenderer = imageCount(read(join(dir, "b.images")));
  const pa = parseLines(read(join(dir, "a.html")));
  const pb = parseLines(read(join(dir, "b.html")));
  r.pagesDocmosis = pa.length;
  r.pagesRenderer = pb.length;
  r.samePageCount = pa.length === pb.length;
  r.shift = shift(pa, pb);
  r.causes = causes(r);
  r.pages = read(join(dir, "metrics.tsv"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [n, ae, area, inkA, inkB, size] = l.split("\t");
      const ink = Math.max(Number(inkA), Number(inkB), 1);
      return {
        page: Number(n),
        mismatchPct: Math.round((Number(ae) / Number(area)) * 1e4) / 100,
        mismatchOfInkPct: Math.round(Math.min(100, (Number(ae) / ink) * 100) * 10) / 10,
        size
      };
    });
  const pcts = r.pages.map((p) => p.mismatchPct);
  r.meanMismatchPct = pcts.length ? Math.round((pcts.reduce((s, x) => s + x, 0) / pcts.length) * 100) / 100 : null;
  r.worstMismatchPct = pcts.length ? Math.max(...pcts) : null;
  r.worstPage = r.pages.find((p) => p.mismatchPct === r.worstMismatchPct)?.page ?? null;
}

const pct = (xs, p) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const dist = (xs) => Object.fromEntries([50, 75, 90, 95, 100].map((p) => [`p${p}`, pct(xs, p)]));
const summary = {
  measured: measurable.length,
  failed: [...results.values()]
    .filter((r) => !(r.docmosisOk && r.rendererOk))
    .map((r) => ({ name: r.name, error: r.error, docmosisOk: r.docmosisOk, rendererOk: r.rendererOk })),
  equalPageCount: measurable.filter((r) => r.samePageCount).length,
  fontSetsDiffer: measurable.filter((r) => r.fontsDiffer).length,
  causeCounts: measurable.flatMap((r) => r.causes).reduce((c, k) => Object.assign(c, { [k]: (c[k] ?? 0) + 1 }), {}),
  meanMismatchPct: dist(measurable.map((r) => r.meanMismatchPct)),
  worstPageMismatchPct: dist(measurable.map((r) => r.worstMismatchPct)),
  medianLineOffsetPt: { dx: dist(measurable.map((r) => r.shift.medianDx)), dy: dist(measurable.map((r) => r.shift.medianDy)) },
  maxLineOffsetPt: { dx: dist(measurable.map((r) => r.shift.maxDx)), dy: dist(measurable.map((r) => r.shift.maxDy)) },
  templates: measurable.sort((a, b) => (b.meanMismatchPct ?? 0) - (a.meanMismatchPct ?? 0))
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
const shown = summary.templates.slice(0, 25);
const cards = shown
  .map((r) => {
    const imgs = (n) =>
      `<div class="row"><figure><figcaption>Docmosis</figcaption><img loading="lazy" src="work/${encodeURI(r.name)}/a-${n}.png"></figure><figure><figcaption>dtsse-doc-render</figcaption><img loading="lazy" src="work/${encodeURI(r.name)}/b-${n}.png"></figure><figure><figcaption>Diff (red differs)</figcaption><img loading="lazy" src="work/${encodeURI(r.name)}/d-${n}.png"></figure></div>`;
    const worst = [...r.pages].sort((x, y) => y.mismatchPct - x.mismatchPct).slice(0, 2);
    return `<section><h2>${esc(r.name)}</h2><p>pages ${r.pagesDocmosis} vs ${r.pagesRenderer}; mean mismatch ${r.meanMismatchPct}%; median offset dx ${r.shift.medianDx}pt dy ${r.shift.medianDy}pt; max dx ${r.shift.maxDx}pt dy ${r.shift.maxDy}pt; fonts Docmosis [${esc(r.fontsDocmosis.join(", "))}] vs [${esc(r.fontsRenderer.join(", "))}]</p>${worst.map((p) => `<h3>page ${p.page}: ${p.mismatchPct}% differ</h3>${imgs(p.page.toString().padStart(Math.max(1, String(r.pagesDocmosis).length), "0"))}`).join("")}</section>`;
  })
  .join("\n");
const rows = summary.templates
  .map(
    (r) =>
      `<tr><td>${esc(r.name)}</td><td>${r.pagesDocmosis}/${r.pagesRenderer}</td><td>${r.meanMismatchPct}</td><td>${r.worstMismatchPct}</td><td>${r.shift.medianDx}</td><td>${r.shift.medianDy}</td><td>${r.shift.maxDx}</td><td>${r.shift.maxDy}</td><td>${r.fontsDiffer ? "differ" : "same"}</td><td>${r.causes.join(", ")}</td></tr>`
  )
  .join("");
writeFileSync(
  join(outDir, "report.html"),
  `<!doctype html><meta charset="utf-8"><title>Visual parity</title><style>body{font:14px sans-serif;margin:1em}.row{display:flex;gap:8px}figure{margin:0;flex:1}img{width:100%;border:1px solid #ccc}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px;text-align:right}td:first-child{text-align:left}</style><h1>Visual parity</h1><p>${summary.measured} templates measured, ${summary.equalPageCount} with equal page count. Mismatch is the percentage of pixels differing at 100 dpi after a ${process.env.VISUAL_FUZZ ?? "12%"} colour tolerance.</p><pre>${esc(JSON.stringify({ meanMismatchPct: summary.meanMismatchPct, worstPageMismatchPct: summary.worstPageMismatchPct, medianLineOffsetPt: summary.medianLineOffsetPt, maxLineOffsetPt: summary.maxLineOffsetPt }, null, 1))}</pre><table><tr><th>template</th><th>pages D/R</th><th>mean %</th><th>worst %</th><th>med dx</th><th>med dy</th><th>max dx</th><th>max dy</th><th>fonts</th><th>causes</th></tr>${rows}</table><h1>Worst ${shown.length}</h1>${cards}`
);
console.log(`\n${summary.measured} measured, ${summary.failed.length} failed to render. ${join(outDir, "report.html")}`);
