// Renders every fixture on a licensed Docmosis and on a dtsse-doc-render instance and prints where they differ.
// For a developer to run locally; it is not part of CI, because it needs a licensed Docmosis.
//
//   node test/parity/compare.mjs [fixture-name ...]
//
// Environment (see "Checking parity with Docmosis" in the README):
//   DOCMOSIS_URL, DOCMOSIS_ACCESS_KEY, DOCMOSIS_CONTAINER   the licensed Docmosis (defaults match `docmosis local start`)
//   DR_URL (default http://127.0.0.1:18099)   the dtsse-doc-render under test
//
// Merge fixtures are compared line by line. "_" fixtures must be rejected by both with the same status and, from the
// renderer, a message containing the fixture's error-phrase.txt; they are then rendered again with devMode on and
// compared line by line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffLines } from "./compare-lib.mjs";
import { fixtureData, fixtureNames, fixturesDir, outcomeLines, renderOnDocmosis, renderOnRenderer, srcDir } from "./lib.mjs";

const wanted = process.argv.slice(2);
const names = fixtureNames().filter((name) => wanted.length === 0 || wanted.includes(name));

function compareRejections(name, docmosis, renderer) {
  const phrase = readFileSync(join(srcDir, name, "error-phrase.txt"), "utf8")
    .trim()
    .toLowerCase();
  const out = [];
  if (docmosis.ok || renderer.ok) {
    out.push(`  docmosis ${docmosis.ok ? "rendered" : "rejected"}, renderer ${renderer.ok ? "rendered" : "rejected"}`);
    return out;
  }
  if (docmosis.status !== renderer.status) {
    out.push(`  status: docmosis ${docmosis.status}, renderer ${renderer.status}`);
  }
  if (!(renderer.error?.shortMsg ?? "").toLowerCase().includes(phrase)) {
    out.push(`  renderer message lacks "${phrase}"`, `    docmosis: ${docmosis.error?.shortMsg}`, `    renderer: ${renderer.error?.shortMsg}`);
  }
  return out;
}

let differing = 0;
const report = (label, problems) => {
  console.log(problems.length ? `DIFF ${label}\n${problems.join("\n")}` : `same ${label}`);
  if (problems.length) {
    differing++;
  }
};

for (const name of names) {
  const docx = join(fixturesDir, `${name}.docx`);
  const data = fixtureData(name);
  const both = async (devMode) => [await renderOnDocmosis(docx, data, { devMode, label: name }), await renderOnRenderer(docx, data, { devMode, label: name })];

  const [docmosis, renderer] = await both(false);
  if (name.startsWith("_")) {
    report(name, compareRejections(name, docmosis, renderer));
    const [docmosisDev, rendererDev] = await both(true);
    report(
      `${name} (devMode)`,
      docmosisDev.ok && rendererDev.ok
        ? diffLines(outcomeLines(docmosisDev), outcomeLines(rendererDev))
        : ["  a devMode render failed", `    docmosis: ${outcomeLines(docmosisDev)[0]}`, `    renderer: ${outcomeLines(rendererDev)[0]}`]
    );
  } else if (docmosis.ok && renderer.ok) {
    report(name, diffLines(outcomeLines(docmosis), outcomeLines(renderer)));
  } else {
    report(name, [`  docmosis: ${outcomeLines(docmosis)[0]}`, `  renderer: ${outcomeLines(renderer)[0]}`]);
  }
}

console.log(`\n${differing === 0 ? "all" : `${differing} differ, the rest`} match`);
process.exit(differing ? 1 : 0);
