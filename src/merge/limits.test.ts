import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeDocx, para, paragraphs, partXml } from "../../test/helpers/docx.ts";
import { Scope } from "./expr.ts";
import { MergeError, mergeDocx } from "./index.ts";

const strict = { devMode: false };

function withEntries(docx: Buffer, extra: Record<string, Uint8Array>): Buffer {
  const files = { ...unzipSync(new Uint8Array(docx)), ...extra };
  return Buffer.from(zipSync(files));
}

/** Rewrites the uncompressed size declared by the entry `name`, in both its local and central headers. */
function lieAboutSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i + 46 < out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && out.toString("latin1", i + 30, i + 30 + out.readUInt16LE(i + 26)) === name) {
      out.writeUInt32LE(size, i + 22);
    }
    if (sig === 0x02014b50 && out.toString("latin1", i + 46, i + 46 + out.readUInt16LE(i + 28)) === name) {
      out.writeUInt32LE(size, i + 24);
    }
  }
  return out;
}

const details = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MergeError);
  return (err as MergeError).details;
};

describe("zip limits", () => {
  const base = makeDocx(para("hello"));

  it("refuses a small zip that inflates to more than the entry limit", async () => {
    const bomb = withEntries(base, { "word/media/zeros.bin": new Uint8Array(65 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const [msg] = await details(mergeDocx(bomb, {}, strict));
    expect(msg).toMatch(/word\/media\/zeros\.bin is larger than 64 MiB/);
  }, 30_000);

  it("refuses an archive whose entries together exceed the total limit", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) {
      files[`word/media/z${i}.bin`] = new Uint8Array(1024 * 1024);
    }
    const [msg] = await details(mergeDocx(withEntries(base, files), {}, { ...strict, limits: { maxTotalBytes: 4 * 1024 * 1024 } }));
    expect(msg).toMatch(/archive is larger than 4 MiB/);
  });

  it("refuses too many entries", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2100; i++) {
      files[`word/media/f${i}.txt`] = strToU8("x");
    }
    const [msg] = await details(mergeDocx(withEntries(base, files), {}, strict));
    expect(msg).toMatch(/more than 2000 entries/);
  });

  it("refuses a declared size over the limit without inflating", async () => {
    const lie = lieAboutSize(withEntries(base, { "word/media/a.bin": new Uint8Array(1000) }), "word/media/a.bin", 0x7fffffff);
    const [msg] = await details(mergeDocx(lie, {}, strict));
    expect(msg).toMatch(/word\/media\/a\.bin is larger than/);
  });

  it("never inflates past the declared size, so an understated size cannot hide a bomb", async () => {
    const lie = lieAboutSize(withEntries(base, { "word/media/a.bin": new Uint8Array(5_000_000) }), "word/media/a.bin", 10);
    const merged = await mergeDocx(lie, {}, strict);
    expect(unzipSync(new Uint8Array(merged))["word/media/a.bin"]!.length).toBeLessThanOrEqual(10);
  });

  it("refuses an entry that declares no size but carries data", async () => {
    const lie = lieAboutSize(withEntries(base, { "word/media/a.bin": new Uint8Array(5_000_000) }), "word/media/a.bin", 0);
    expect((await details(mergeDocx(lie, {}, strict)))[0]).toMatch(/declares no uncompressed size/);
  });

  it("reads limits from the environment", async () => {
    process.env.MERGE_MAX_ENTRIES = "3";
    try {
      const [msg] = await details(mergeDocx(withEntries(base, { "a.txt": strToU8("x"), "b.txt": strToU8("y") }), {}, strict));
      expect(msg).toMatch(/more than 3 entries/);
    } finally {
      delete process.env.MERGE_MAX_ENTRIES;
    }
  });
});

describe("expansion limits", () => {
  const nested = (depth: number): string => {
    let body = para("x");
    for (let i = 0; i < depth; i++) {
      body = para("<<rs_$root.list>>") + body + para("<<es_>>");
    }
    return body;
  };
  const list = Array.from({ length: 20 }, (_, i) => i);

  it("aborts nested repeats that would expand without bound", async () => {
    const started = Date.now();
    const [msg] = await details(mergeDocx(makeDocx(nested(6)), { list }, strict));
    expect(msg).toMatch(/more than 2000000 nodes/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("allows a repeat within the budget", async () => {
    const out = await mergeDocx(makeDocx(nested(2)), { list }, strict);
    expect(paragraphs(out)).toHaveLength(400);
  });

  it("caps the items in one repeat block", async () => {
    const body = para("<<rs_$root.list>>") + para("<<$this>>") + para("<<es_>>");
    const out = await mergeDocx(makeDocx(body), { list: new Array(10_000).fill("a") }, strict);
    expect(paragraphs(out)).toHaveLength(10_000);
    const [msg] = await details(mergeDocx(makeDocx(body), { list: new Array(10_001).fill("a") }, strict));
    expect(msg).toMatch(/10001 items, more than the limit of 10000/);
  });

  it("caps the bytes inserted by values", async () => {
    const body = para("<<rs_$root.list>>") + para("<<$root.big>>") + para("<<es_>>");
    const [msg] = await details(mergeDocx(makeDocx(body), { list: [1, 2, 3, 4], big: "y".repeat(1000) }, { ...strict, limits: { maxOutputBytes: 3000 } }));
    expect(msg).toMatch(/MiB of output|MiB merged/);
  });

  it("caps the serialised part", async () => {
    const [msg] = await details(mergeDocx(makeDocx(para("x".repeat(5000))), {}, { ...strict, limits: { maxOutputBytes: 1000 } }));
    expect(msg).toMatch(/larger than/);
  });

  it("surfaces limits in devMode too", async () => {
    await details(mergeDocx(makeDocx(nested(6)), { list }, { devMode: true }));
  });
});

describe("expression caches", () => {
  it("are private to one render, so they cannot grow across renders", () => {
    const a = Scope.withNow({}, new Date());
    const b = Scope.withNow({}, new Date());
    expect(a.caches).not.toBe(b.caches);
    expect(a.child(1, 1, 1).caches).toBe(a.caches);
  });

  it("do not accumulate across many renders", async () => {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 300; i++) {
      await mergeDocx(makeDocx(para(`<<field${i}.a.b + ${i}>>`)), {}, { devMode: true });
    }
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200 * 1024 * 1024);
  });
});

describe("XML-illegal characters in values", () => {
  const out = async (v: string): Promise<string> => partXml(await mergeDocx(makeDocx(para("a<<v>>b")), { v }, strict));

  it("drops them, as Docmosis does", async () => {
    const xml = await out("1\u0002\u000B\u001B\u0000\u000C𐀀\uDC00\uD800￾￿2");
    expect(xml).toContain(">a1\u{10000}2b<");
  });

  it("turns a run of tabs into one space and splits paragraphs at CR, CRLF and LF", async () => {
    expect(await out("1\t\t2")).toContain(">a1 2b<");
    const merged = await mergeDocx(makeDocx(para("<<v>>")), { v: "a\rb\r\nc\nd" }, strict);
    expect(paragraphs(merged)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("prototype chain", () => {
  it("is not reachable from a path", async () => {
    const body = para("[<<x.constructor>>][<<x.__proto__>>][<<toString>>][<<x.toString>>][<<hasOwnProperty>>][<<$root.constructor.name>>]");
    const out = await mergeDocx(makeDocx(body), { x: { a: 1 } }, { devMode: true });
    expect(paragraphs(out)[0]).not.toMatch(/function|object|Object/i);
  });

  it("reads .length of a string as Docmosis does, which is 0", async () => {
    const out = await mergeDocx(makeDocx(para("<<x.length>>")), { x: "hello" }, strict);
    expect(paragraphs(out)).toEqual(["0"]);
  });

  it("still reads array indices and length", async () => {
    const out = await mergeDocx(makeDocx(para("<<x[1]>> <<x.length>> <<x.size>>")), { x: ["a", "b", "c"] }, strict);
    expect(paragraphs(out)).toEqual(["b 3 3"]);
  });
});
