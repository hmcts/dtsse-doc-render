// Regenerates every fixture's expected output from a licensed Docmosis, so the expectations are Docmosis's own and not
// what this service's author believed Docmosis does.
//
//   node test/parity/capture.mjs [fixture-name ...]
//
// Environment: DOCMOSIS_URL (default http://127.0.0.1:18087), DOCMOSIS_ACCESS_KEY (default: read from the container's
// DOCMOSIS_ACCESSKEY), DOCMOSIS_CONTAINER (default docmosis-local, which templates are copied into).
//
// A fixture directory writes:
//   merge fixtures   expected.txt            the merged text of the docx render
//   "_" fixtures     expected-error.txt      Docmosis's HTTP status and error message with devMode off
//                    expected-devmode.txt    the document text with devMode on, where errors are written in place
// An "_" fixture's error-phrase.txt is hand-written: the phrase every backend's error message must contain. This script
// fails if Docmosis's own message does not contain it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docxText, fixtureData, fixtureNames, fixturesDir, renderOnDocmosis, srcDir } from "./lib.mjs";

execFileSync(process.execPath, [fileURLToPath(new URL("../fixtures/build.mjs", import.meta.url))], { stdio: "inherit" });

const wanted = process.argv.slice(2);
const names = fixtureNames().filter((name) => wanted.length === 0 || wanted.includes(name));
let failures = 0;

for (const name of names) {
  const docx = join(fixturesDir, `${name}.docx`);
  const dir = join(srcDir, name);
  const data = fixtureData(name);

  if (name.startsWith("_")) {
    const failed = await renderOnDocmosis(docx, data, { label: name });
    if (failed.ok) {
      console.log(`FAIL ${name}: Docmosis rendered a fixture that is meant to be an error`);
      failures++;
      continue;
    }
    const phrase = readFileSync(join(dir, "error-phrase.txt"), "utf8").trim();
    const message = failed.error.shortMsg ?? "";
    if (!message.toLowerCase().includes(phrase.toLowerCase())) {
      console.log(`FAIL ${name}: error-phrase "${phrase}" is not in Docmosis's message: ${message}`);
      failures++;
      continue;
    }
    writeFileSync(
      join(dir, "expected-error.txt"),
      `status: ${failed.status}\nshortMsg: ${message}\n${failed.error.longMsg ? `longMsg: ${failed.error.longMsg}\n` : ""}`
    );
    const dev = await renderOnDocmosis(docx, data, { devMode: true, label: `${name}-dev` });
    if (!dev.ok) {
      console.log(`FAIL ${name}: devMode render failed: ${dev.error?.shortMsg}`);
      failures++;
      continue;
    }
    writeFileSync(join(dir, "expected-devmode.txt"), `${docxText(dev.buffer).join("\n")}\n`);
    console.log(`ok   ${name}: ${failed.status} ${message}`);
    continue;
  }

  const result = await renderOnDocmosis(docx, data, { label: name });
  if (!result.ok) {
    console.log(`FAIL ${name}: ${result.error?.shortMsg}`);
    failures++;
    continue;
  }
  const lines = docxText(result.buffer);
  const path = join(dir, "expected.txt");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  writeFileSync(path, `${lines.join("\n")}\n`);
  console.log(`${before === null ? "new " : before === `${lines.join("\n")}\n` ? "same" : "CHG "} ${name}: ${lines.length} lines`);
}

process.exit(failures ? 1 : 0);
