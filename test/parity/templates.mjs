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
import { generateData } from "./datagen.mjs";
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
