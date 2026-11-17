// Surveys the font families a directory of .docx templates asks for, and what each backend's fontconfig substitutes.
//
//   node test/parity/fonts.mjs <Templates/Base dir> [--top 30] [--out fonts.json]
//
// A family counts once per template. "used" is a family named by a w:rFonts in styles.xml or document.xml (a theme font
// is resolved through word/theme/theme1.xml); "declared" is one listed in word/fontTable.xml. The top families by used count
// are matched with fc-match inside DOCMOSIS_CONTAINER (default docmosis-local) and DR_CONTAINER (default dr-int).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzip } from "../support/zip.ts";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv.splice(i, 2)[1];
};
const top = Number(flag("--top", 30));
const outFile = flag("--out");
const [dir] = argv;
if (!dir) {
  console.error("usage: node test/parity/fonts.mjs <Templates/Base dir> [--top N] [--out file.json]");
  process.exit(2);
}
const containers = { docmosis: process.env.DOCMOSIS_CONTAINER || "docmosis-local", renderer: process.env.DR_CONTAINER || "dr-int" };

const used = new Map();
const declared = new Map();
const broken = [];
const perTemplate = [];
let scanned = 0;
const bump = (map, set) => {
  for (const f of set) {
    map.set(f, (map.get(f) ?? 0) + 1);
  }
};

for (const file of readdirSync(dir).filter((f) => f.endsWith(".docx"))) {
  let parts;
  try {
    parts = unzip(readFileSync(join(dir, file)));
  } catch {
    broken.push(file);
    continue;
  }
  scanned++;
  const text = (name) => parts.get(name)?.toString("utf8") ?? "";
  const theme = text("word/theme/theme1.xml");
  const themeFont = (kind) => new RegExp(`<a:${kind}Font>\\s*<a:latin typeface="([^"]*)"`).exec(theme)?.[1];
  const usedHere = new Set();
  for (const part of [...parts.keys()].filter((n) => /^word\/(styles|document|header\d*|footer\d*)\.xml$/.test(n))) {
    for (const [, attrs] of text(part).matchAll(/<w:rFonts\s([^>]*)\/?>/g)) {
      for (const [, key, value] of attrs.matchAll(/w:(ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)) {
        if (key !== "eastAsia" && value) {
          usedHere.add(value);
        }
      }
      for (const [, , value] of attrs.matchAll(/w:(ascii|hAnsi)Theme="(major|minor)\w*"/g)) {
        const resolved = themeFont(value);
        if (resolved) {
          usedHere.add(resolved);
        }
      }
    }
  }
  const declaredHere = new Set([...text("word/fontTable.xml").matchAll(/<w:font\s+w:name="([^"]*)"/g)].map((m) => m[1]));
  bump(used, usedHere);
  perTemplate.push(usedHere);
  bump(declared, declaredHere);
}

const fc = (container, family) => {
  try {
    const out = execFileSync("docker", ["exec", container, "fc-match", family, "-f", "%{family[0]}|%{style[0]}|%{file}"]).toString();
    const [name, style, path] = out.split("|");
    return { name, style, file: path.split("/").pop(), path };
  } catch (e) {
    return { name: "error", style: "", file: String(e.message).slice(0, 60), path: "" };
  }
};

const ranked = [...used].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
const table = ranked.map(([family, templates]) => {
  const docmosis = fc(containers.docmosis, family);
  const renderer = fc(containers.renderer, family);
  return {
    family,
    templatesUsing: templates,
    templatesDeclaring: declared.get(family) ?? 0,
    docmosis: `${docmosis.name} (${docmosis.file})`,
    renderer: `${renderer.name} (${renderer.file})`,
    sameFile: docmosis.file === renderer.file
  };
});
const METRIC_COMPATIBLE = /^(Liberation|Carlito|Caladea)/;
const covered = new Set(
  [...used.keys()].filter((family) => METRIC_COMPATIBLE.test(fc(containers.renderer, family).name) || family === fc(containers.renderer, family).name)
);
const needsSubstitute = perTemplate.filter((fonts) => [...fonts].some((family) => !covered.has(family))).length;
const version = (c, cmd) => {
  try {
    return execFileSync("docker", ["exec", c, "sh", "-c", cmd]).toString().trim().split("\n")[0];
  } catch {
    return "unknown";
  }
};
const result = {
  templatesScanned: scanned,
  unreadable: broken,
  libreoffice: {
    docmosis: version(containers.docmosis, "/opt/libreoffice/program/soffice --version"),
    renderer: version(containers.renderer, "soffice --version")
  },
  templatesAskingForAFontTheRendererCannotMatchByMetrics: needsSubstitute,
  fonts: table
};
if (outFile) {
  writeFileSync(outFile, JSON.stringify({ ...result, allUsed: Object.fromEntries(used), allDeclared: Object.fromEntries(declared) }, null, 1));
}
console.log(
  `${needsSubstitute} of ${scanned} templates ask for at least one family that dtsse-doc-render has neither installed nor a metric-compatible stand-in for.`
);
console.log(`${scanned} templates scanned, ${broken.length} unreadable. ${result.libreoffice.docmosis} vs ${result.libreoffice.renderer}\n`);
console.log("| family | used by | declared in | Docmosis | dtsse-doc-render | same file |\n|---|---|---|---|---|---|");
for (const r of table) {
  console.log(`| ${r.family} | ${r.templatesUsing} | ${r.templatesDeclaring} | ${r.docmosis} | ${r.renderer} | ${r.sameFile ? "yes" : "no"} |`);
}
