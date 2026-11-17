import { describe, expect, it, vi } from "vitest";
import { cell, makeDocx, para, paragraphs, row, rows, table } from "../../test/helpers/docx.ts";
import type { Scope } from "./expr.ts";
import { MergeError, mergeDocx } from "./index.ts";

// Stands in for the parts of expr.ts a test needs beyond plain paths: else_<cond>, assignment and variable reads.
vi.mock("./expr.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./expr.ts")>();
  const readVar = (name: string, scope: Scope | undefined): unknown => {
    for (let s = scope; s; s = s.parent) {
      if (s.vars.has(name)) {
        return s.vars.get(name);
      }
    }
    return undefined;
  };
  return {
    ...real,
    parseInstruction(text: string) {
      const t = text.trim();
      const elseIf = /^else_\s*(.+)$/.exec(t);
      if (elseIf) {
        return { kind: "else", cond: elseIf[1] };
      }
      const set = /^set (\w+)=(.*)$/.exec(t);
      if (set) {
        return { kind: "assign", name: set[1], expr: set[2] };
      }
      if (t.startsWith("/*")) {
        return { kind: "comment" };
      }
      if (t === "bad") {
        return { kind: "unsupported", text: t, reason: "nope" };
      }
      if (t === "boom") {
        throw new real.ExpressionError("cannot parse");
      }
      return real.parseInstruction(text);
    },
    evaluate(expr: string, scope: Scope) {
      const t = expr.trim();
      if (t === "fail") {
        throw new real.ExpressionError("bad expression");
      }
      if (t.startsWith("$")) {
        return readVar(t.slice(1), scope);
      }
      return real.evaluate(expr, scope);
    }
  };
});

const strict = { devMode: false };
const dev = { devMode: true };
const run = async (body: string, data: unknown, options = strict): Promise<string[]> => paragraphs(await mergeDocx(makeDocx(body), data, options));

describe("else_ chains", () => {
  const body =
    para("<<cs_a>>") + para("A") + para("<<else_b>>") + para("B") + para("<<else_c>>") + para("C") + para("<<else>>") + para("none") + para("<<es_>>");

  it("takes the first true branch", async () => {
    expect(await run(body, { a: true, b: true })).toEqual(["A"]);
    expect(await run(body, { b: true, c: true })).toEqual(["B"]);
    expect(await run(body, { c: true })).toEqual(["C"]);
    expect(await run(body, {})).toEqual(["none"]);
  });

  it("works inline", async () => {
    const b = para("x <<cs_a>>A<<else_b>>B<<else>>Z<<es_>> y");
    expect(await run(b, { b: true })).toEqual(["x B y"]);
    expect(await run(b, {})).toEqual(["x Z y"]);
  });

  it("works across rows", async () => {
    const b = table(row(cell(para("<<cr_a>>"))), row(cell(para("A"))), row(cell(para("<<else_b>>"))), row(cell(para("B"))), row(cell(para("<<er_>>"))));
    const out = await mergeDocx(makeDocx(b), { b: true }, strict);
    expect(rows(out)).toEqual(["B"]);
  });
});

describe("assignment", () => {
  it("evaluates assignments in document order", async () => {
    const b = para("<<$x>>|") + para("<<set x=first>>") + para("<<$x>>|") + para("<<set x=second>>") + para("<<$x>>");
    expect(await run(b, { first: "one", second: "two" })).toEqual(["|", "one|", "two"]);
  });

  it("does not run an assignment in a dropped branch", async () => {
    const b = para("<<cs_no>>") + para("<<set x=first>>") + para("<<es_>>") + para("[<<$x>>]");
    expect(await run(b, { first: "one" })).toEqual(["[]"]);
  });

  it("runs an assignment in every repeat iteration, in order", async () => {
    const b = para("<<rs_l>>") + para("<<set v=n>>") + para("<<n>>:<<$v>>") + para("<<es_>>");
    expect(await run(b, { l: [{ n: "a" }, { n: "b" }] })).toEqual(["a:a", "b:b"]);
  });

  it("removes a paragraph left empty by an assignment, but not an empty one", async () => {
    expect(await run(para("") + para("<<set x=first>>") + para("<</* c */>>") + para("end"), { first: 1 })).toEqual(["", "end"]);
  });
});

describe("expression failures", () => {
  it("collects an ExpressionError from a field", async () => {
    const err = await mergeDocx(makeDocx(para("a <<fail>>")), {}, strict).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeError);
    expect((err as MergeError).details[0]).toContain("bad expression");
    expect((err as MergeError).details[0]).toContain("<<fail>>");
  });

  it("writes the failed instruction and a number into the document in devMode", async () => {
    expect(await run(para("a <<fail>> b"), {}, dev)).toEqual(["a <<fail>>Docmosis1 b"]);
  });

  it("reports unsupported instructions and parse failures", async () => {
    expect(await run(para("<<bad>> <<boom>>"), {}, dev)).toEqual(["<<bad>>Docmosis1 <<boom>>Docmosis2"]);
  });

  it("writes a failing condition as its own paragraph and treats it as false", async () => {
    const b = para("<<cs_fail>>") + para("hidden") + para("<<es_>>") + para("after");
    expect(await run(b, {}, dev)).toEqual(["<<fail>>Docmosis1", "after"]);
  });

  it("writes a failing repeat as its own paragraph", async () => {
    const b = para("<<rs_fail>>") + para("x") + para("<<es_>>");
    expect(await run(b, {}, dev)).toEqual(["<<fail>>Docmosis1"]);
  });

  it("writes a failing row condition as a row", async () => {
    const b = table(row(cell(para("<<cr_fail>>"))), row(cell(para("r"))), row(cell(para("<<er_>>"))));
    const out = await mergeDocx(makeDocx(b), {}, dev);
    expect(rows(out)).toEqual(["<<fail>>Docmosis1"]);
  });

  it("reports an assignment that fails", async () => {
    expect(await run(para("<<set v=fail>>x"), {}, dev)).toEqual(["<<set v=fail>>Docmosis1x"]);
  });
});
