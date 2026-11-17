/** Line-by-line differences between two texts, three output lines per differing line. */
export function diffLines(expected, actual) {
  const out = [];
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      out.push(`  line ${i + 1}`, `    docmosis: ${JSON.stringify(expected[i] ?? null)}`, `    renderer: ${JSON.stringify(actual[i] ?? null)}`);
    }
  }
  return out;
}
