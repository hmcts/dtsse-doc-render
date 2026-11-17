import { describe, expect, it } from "vitest";
import { collapseParentSegments, dropBodyClose, openTagOfSelfClosed } from "./include.ts";
import { groupThousands, trimTrailingZeros } from "./renderer.ts";
import { stripIllegalXml } from "./xml.ts";

const N = 50_000;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

describe("illegal XML characters", () => {
  it("drops C0 controls except tab, LF and CR, lone surrogates, U+FFFE and U+FFFF", () => {
    expect(stripIllegalXml("1\u0002\u000B\u001B\u0000\u000C𐀀\uDC00\uD800\uFFFE\uFFFF2\t\n\r")).toBe("1𐀀2\t\n\r");
  });

  it("keeps a valid surrogate pair and drops a lone high surrogate before text", () => {
    expect(stripIllegalXml("\u{1F600}\uD83Dx\uDE00")).toBe("\u{1F600}x");
  });

  it("is fast on a long run of illegal characters", () => {
    const { result, ms } = timed(() => stripIllegalXml("\u0001".repeat(N)));
    expect(result).toBe("");
    expect(ms).toBeLessThan(200);
  });
});

describe("linear-time string handling", () => {
  it("drops a trailing </w:body> with the whitespace before it, in linear time", () => {
    expect(dropBodyClose("<w:sectPr/>  \n</w:body>")).toBe("<w:sectPr/>");
    expect(dropBodyClose("<w:sectPr/>")).toBe("<w:sectPr/>");
    const { ms } = timed(() => dropBodyClose(`<w:sectPr/>${" ".repeat(N)}x`));
    expect(ms).toBeLessThan(200);
  });

  it("collapses segment/../ pairs left to right, in linear time", () => {
    expect(collapseParentSegments("word/../media/a.png")).toBe("media/a.png");
    expect(collapseParentSegments("word/../../x")).toBe("../x");
    expect(collapseParentSegments("a/b/../c/../d")).toBe("a/d");
    expect(collapseParentSegments("word/..")).toBe("word/..");
    expect(collapseParentSegments("word/media/a.png")).toBe("word/media/a.png");
    const { ms } = timed(() => collapseParentSegments(`word/${"a".repeat(N)}`));
    expect(ms).toBeLessThan(200);
    const many = timed(() => collapseParentSegments(`word/${"a/".repeat(N / 2)}`));
    expect(many.ms).toBeLessThan(200);
  });

  it("turns a self-closed opening tag into an open one, in linear time", () => {
    expect(openTagOfSelfClosed("<w:p w:rsidR='1' />")).toBe("<w:p w:rsidR='1'>");
    expect(openTagOfSelfClosed("<w:p/>")).toBe("<w:p>");
    expect(openTagOfSelfClosed("<w:p>")).toBe("<w:p>");
    const { ms } = timed(() => openTagOfSelfClosed(`<w:p${" ".repeat(N)}x`));
    expect(ms).toBeLessThan(200);
  });

  it("groups digits in thousands, in linear time", () => {
    expect(groupThousands("0")).toBe("0");
    expect(groupThousands("123")).toBe("123");
    expect(groupThousands("1234")).toBe("1,234");
    expect(groupThousands("1234567")).toBe("1,234,567");
    expect(groupThousands("123456")).toBe("123,456");
    const { result, ms } = timed(() => groupThousands("7".repeat(N + 1)));
    expect(result.replaceAll(",", "")).toBe("7".repeat(N + 1));
    expect(ms).toBeLessThan(200);
  });

  it("trims trailing zeros, in linear time", () => {
    expect(trimTrailingZeros("5000")).toBe("5");
    expect(trimTrailingZeros("000")).toBe("");
    expect(trimTrailingZeros("")).toBe("");
    const { result, ms } = timed(() => trimTrailingZeros(`${"0".repeat(N)}1`));
    expect(result).toBe(`${"0".repeat(N)}1`);
    expect(ms).toBeLessThan(200);
  });
});
