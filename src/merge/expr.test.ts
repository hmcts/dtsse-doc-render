import { describe, expect, it } from "vitest";
import { ExpressionError, evaluate, formatValue, type Instruction, parseInstruction, Scope, truthy } from "./expr.ts";

const NOW = new Date(Date.UTC(2026, 10, 16, 9, 30));
const data = {
  issuedOn: "2026-11-16",
  issueDate: "2026-11-16",
  base: { in_use: false },
  applicationType: "SOMETHING",
  defendant1: { isIndividual: true },
  commonDetails: { howToPay: "BY_INSTALMENTS" },
  applicants: [{ n: "a" }],
  hearing: { unavailableDates: [1, 2] },
  documentCount: 3,
  primaryAddress: { AddressLine2: "Flat 2" },
  employerDetails: [{ employerName: "Acme" }],
  D8ReasonForDivorceAdulteryWishToName: "YES",
  deep: { a: { b: [{ c: { d: 5 } }] } },
  name: "root-name"
};
const root = () => Scope.withNow(data, NOW);
const ev = (expr: string, scope = root()) => evaluate(expr, scope);

describe("parseInstruction blocks", () => {
  it.each([
    ["cs_{a = b}", { kind: "cs", cond: "{a = b}" }],
    ["cs_ {a}", { kind: "cs", cond: "{a}" }],
    ["cr_flag", { kind: "cr", cond: "flag" }],
    ["rs_ list", { kind: "rs", expr: "list" }],
    ["rr_$this.items", { kind: "rr", expr: "$this.items" }],
    ["rs_$parent.x", { kind: "rs", expr: "$parent.x" }],
    ["es_", { kind: "es" }],
    ["es_timeline", { kind: "es" }],
    ["er_[rows]", { kind: "er" }],
    ["er_", { kind: "er" }],
    ["else", { kind: "else" }],
    ["else_{a=1}", { kind: "else", cond: "{a=1}" }],
    ["else_flag", { kind: "else", cond: "flag" }],
    ["else{a=1}", { kind: "else", cond: "{a=1}" }],
    ["else {a=1}", { kind: "else", cond: "{a=1}" }],
    ["/* note */", { kind: "comment" }],
    ["/* unterminated", { kind: "comment" }]
  ] as [string, Instruction][])("%s", (text, expected) => {
    expect(parseInstruction(text)).toEqual(expected);
  });

  it("is not fooled by a field that starts with else", () => {
    expect(parseInstruction("elsewhere")).toEqual({ kind: "field", expr: "elsewhere", optionalParagraph: false });
  });
});

describe("parseInstruction assignments and fields", () => {
  it.each([
    ["$rowNum={round($rowNum+1)}", { kind: "assign", name: "rowNum", expr: "round($rowNum+1)" }],
    ["$x={a = b}", { kind: "assign", name: "x", expr: "a = b" }],
    ["$x = {a}", { kind: "assign", name: "x", expr: "a" }],
    ["$n=0", { kind: "assign", name: "n", expr: "0" }],
    ["$f=true", { kind: "assign", name: "f", expr: "true" }],
    ["$s=hello world", { kind: "assign", name: "s", expr: "'hello world'" }],
    ["$s=‘quoted’", { kind: "assign", name: "s", expr: "‘quoted’" }],
    ["$s=it's", { kind: "assign", name: "s", expr: '"it\'s"' }]
  ] as [string, Instruction][])("%s", (text, expected) => {
    expect(parseInstruction(text)).toEqual(expected);
  });

  it("does not treat == as an assignment", () => {
    expect(parseInstruction("$a == 1")).toEqual({ kind: "field", expr: "$a == 1", optionalParagraph: false });
  });

  it("literal assignment evaluates to the literal", () => {
    for (const [text, expected] of [
      ["$s=hello world", "hello world"],
      ["$s=it's", "it's"],
      ["$n=0", 0]
    ] as const) {
      const inst = parseInstruction(text);
      expect(inst.kind === "assign" && ev(inst.expr)).toBe(expected);
    }
  });

  it("literal with every delimiter falls back to single quotes", () => {
    expect(parseInstruction(`$s=a'b"c‘d“e`)).toMatchObject({ kind: "assign", expr: `'a'b"c‘d“e'` });
  });

  it("parses fields", () => {
    expect(parseInstruction("a.b")).toEqual({ kind: "field", expr: "a.b", optionalParagraph: false });
    expect(parseInstruction(" {x + 1} ")).toEqual({ kind: "field", expr: "x + 1", optionalParagraph: false });
    expect(parseInstruction("op:a.b")).toEqual({ kind: "field", expr: "a.b", optionalParagraph: true });
    expect(parseInstruction("op:{a}")).toEqual({ kind: "field", expr: "{a}", optionalParagraph: true });
  });

  it.each([["link:http://x"], ["ref:other"], ["html:body"], ["refLookup:x"], ["image:a.png"], ["img:a"], ["md:text"], ["bookmark:b"]])(
    "%s is unsupported",
    (text) => {
      const inst = parseInstruction(text);
      expect(inst.kind).toBe("unsupported");
      expect(inst).toMatchObject({ text, reason: expect.stringContaining("not supported") });
    }
  );

  it("renderer suffix is unsupported", () => {
    expect(parseInstruction("issuedOn{renderer=date(dd/MM/yyyy)}")).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("renderer") });
  });
});

describe("Scope", () => {
  it("resolves built-ins", () => {
    const r = root();
    const c = r.child({ x: 1 }, 2, 5);
    expect(c.lookup("$itemnum")).toBe(2);
    expect(c.lookup("$size")).toBe(5);
    expect(c.lookup("$nl")).toBe("\n");
    expect(c.lookup("$nowUTC")).toBe(NOW);
    expect(c.lookup("$nowUTC.x")).toBeUndefined();
    expect(c.lookup("$root.name")).toBe("root-name");
    expect(c.lookup("$this.x")).toBe(1);
    expect(c.lookup("$parent.name")).toBe("root-name");
    expect(r.lookup("$parent")).toBeUndefined();
  });

  it("$this may be a scalar", () => {
    expect(root().child("A", 1, 1).lookup("$this")).toBe("A");
    expect(root().child("A", 1, 1).lookup("$this.x")).toBeUndefined();
  });

  it("defaults $nowUTC to the current time and keeps the existing constructor", () => {
    const before = Date.now();
    const s = new Scope({ a: 1 });
    expect((s.lookup("$nowUTC") as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(s.lookup("a")).toBe(1);
    expect(s.child({}, 1, 1).lookup("$nowUTC")).toBe(s.now);
  });

  it("walks the item, enclosing items, then root", () => {
    const outer = root().child({ onlyOuter: "o", shared: "outer" }, 1, 1);
    const inner = outer.child({ shared: "inner" }, 1, 1);
    expect(inner.lookup("shared")).toBe("inner");
    expect(inner.lookup("onlyOuter")).toBe("o");
    expect(inner.lookup("issuedOn")).toBe("2026-11-16");
    expect(inner.lookup("$parent.shared")).toBe("outer");
    expect(inner.lookup("missing")).toBeUndefined();
  });

  it("resolves deep paths and indexes", () => {
    const r = root();
    expect(r.lookup("deep.a.b[0].c.d")).toBe(5);
    expect(r.lookup("employerDetails[0].employerName")).toBe("Acme");
    expect(r.lookup("employerDetails[3].employerName")).toBeUndefined();
    expect(r.lookup("deep.zzz.b")).toBeUndefined();
    expect(r.lookup("[0]")).toBeUndefined();
    expect(r.lookup("")).toBeUndefined();
  });

  it("keeps variables on the root so they persist across repeats", () => {
    const r = root();
    r.setVar("rowNum", 0);
    const a = r.child({}, 1, 2);
    a.setVar("$rowNum", 5);
    expect(r.lookup("$rowNum")).toBe(5);
    expect(r.child({}, 2, 2).lookup("$rowNum")).toBe(5);
    a.setVar("obj", { k: [1, 2] });
    expect(r.lookup("$obj.k[1]")).toBe(2);
    expect(r.lookup("$unset")).toBeUndefined();
  });
});

describe("evaluate: survey examples", () => {
  it("cs_{issuedOn!= null}", () => {
    expect(ev("{issuedOn!= null}")).toBe(true);
    expect(ev("{nothing!= null}")).toBe(false);
  });

  it("cs_{base.in_use == 'false'}", () => {
    expect(ev("{base.in_use == 'false'}")).toBe(true);
  });

  it("cr_{applicationType!= ‘SOMETHING_ELSE’}", () => {
    expect(ev("{applicationType!= ‘SOMETHING_ELSE’}")).toBe(true);
    expect(ev("{applicationType!= ‘SOMETHING’}")).toBe(false);
  });

  it("nested boolean logic with parentheses", () => {
    const cond = "{ defendant1.isIndividual && (commonDetails.howToPay == ‘BY_SET_DATE’ || commonDetails.howToPay == ‘BY_INSTALMENTS’)}";
    expect(ev(cond)).toBe(true);
    const other = { ...data, commonDetails: { howToPay: "OTHER" } };
    expect(evaluate(cond, Scope.withNow(other, NOW))).toBe(false);
  });

  it("cs_{$itemnum<$size && $itemnum!=$size-1}", () => {
    const cond = "{$itemnum<$size && $itemnum!=$size-1}";
    const results = [1, 2, 3, 4].map((i) => ev(cond, root().child({}, i, 4)));
    expect(results).toEqual([true, true, false, false]);
  });

  it("$rowNum={round($rowNum+1)} counts across repeats", () => {
    const r = root();
    const init = parseInstruction("$rowNum=0");
    const step = parseInstruction("$rowNum={round($rowNum+1)}");
    if (init.kind !== "assign" || step.kind !== "assign") {
      throw new Error("expected assignments");
    }
    r.setVar(init.name, ev(init.expr, r));
    for (const group of [2, 3]) {
      for (let i = 1; i <= group; i++) {
        const s = r.child({}, i, group);
        s.setVar(step.name, ev(step.expr, s));
      }
    }
    expect(r.lookup("$rowNum")).toBe(5);
  });

  it("ifBlank(dateFormat(...), 'N/A')", () => {
    const expr = "{ifBlank(dateFormat(issueDate, 'dd MMM yyyy', 'yyyy-MM-dd'), ‘N/A’ )}";
    expect(ev(expr)).toBe("16 Nov 2026");
    expect(evaluate(expr, Scope.withNow({}, NOW))).toBe("N/A");
  });

  it("dateFormat with curly quotes and no space", () => {
    expect(ev("{dateFormat(issuedOn,‘d MMMM yyyy’,‘yyyy-MM-dd’)}")).toBe("16 November 2026");
  });

  it("cs_{$root.applicants.size()=1}", () => {
    expect(ev("{$root.applicants.size()=1}")).toBe(true);
  });

  it("cs_{hearing.unavailableDates.size>0}", () => {
    expect(ev("{hearing.unavailableDates.size>0}")).toBe(true);
    expect(evaluate("{hearing.unavailableDates.size>0}", Scope.withNow({ hearing: { unavailableDates: [] } }, NOW))).toBe(false);
    expect(evaluate("{hearing.unavailableDates.size>0}", Scope.withNow({}, NOW))).toBe(false);
  });

  it("cs_{equalsIgnoreCase ($this, ‘A’)}", () => {
    expect(ev("{equalsIgnoreCase ($this, ‘A’)}", root().child("a", 1, 1))).toBe(true);
    expect(ev("{equalsIgnoreCase ($this, ‘A’)}", root().child("b", 1, 1))).toBe(false);
  });

  it("{ numFormat ($documentCount, ‘0’)}", () => {
    const r = root();
    r.setVar("documentCount", 3);
    expect(ev("{ numFormat ($documentCount, ‘0’)}", r)).toBe("3");
    expect(ev("{ numFormat (documentCount, ‘0’)}")).toBe("3");
  });

  it("cs_{!isBlank(primaryAddress.AddressLine2)}", () => {
    expect(ev("{!isBlank(primaryAddress.AddressLine2)}")).toBe(true);
    expect(ev("{!isBlank(primaryAddress.AddressLine3)}")).toBe(false);
  });

  it("cs_{employerDetails[0].employerName!=null}", () => {
    expect(ev("{employerDetails[0].employerName!=null}")).toBe(true);
    expect(ev("{employerDetails[1].employerName!=null}")).toBe(false);
  });

  it("cs_{toLowerCase(D8ReasonForDivorceAdulteryWishToName)=‘yes’}", () => {
    expect(ev("{toLowerCase(D8ReasonForDivorceAdulteryWishToName)=‘yes’}")).toBe(true);
  });

  it("{dateFormat($nowUTC ,‘d MMMM yyyy’)}", () => {
    expect(ev("{dateFormat($nowUTC ,‘d MMMM yyyy’)}")).toBe("16 November 2026");
  });
});

describe("evaluate: lexer", () => {
  it.each([["‘x’"], ["’x’"], ["‘x'"], ["“x”"], ['"x"'], ["'x'"], ["”x“"], ["“x’"]])("string delimiters %s", (lit) => {
    expect(ev(lit)).toBe("x");
  });

  it("keeps quotes inside a format pattern", () => {
    expect(ev("dateFormat('2026-11-16T14:05:00.000', “dd MMMM yyyy 'at' hh:mm aa”, ‘yyyy-MM-dd'T'HH:mm:ss.SSS’)")).toBe("16 November 2026 at 02:05 PM");
  });

  it("closes at the first quote when none is followed by a terminator", () => {
    expect(() => ev("‘abc’def")).toThrow(/Unexpected 'def'/);
  });

  it("lets an apostrophe sit inside a string", () => {
    expect(ev("‘it’s fine’")).toBe("it’s fine");
  });

  it("literals", () => {
    expect(ev("null")).toBeNull();
    expect(ev("true")).toBe(true);
    expect(ev("false")).toBe(false);
    expect(ev("12")).toBe(12);
    expect(ev("1.5")).toBe(1.5);
    expect(ev("")).toBeUndefined();
    expect(ev("{ }")).toBeUndefined();
    expect(ev("‘ ’")).toBe(" ");
  });

  it("works on bare names and braces", () => {
    expect(ev("name")).toBe("root-name");
    expect(ev("{name}")).toBe("root-name");
    expect(ev("  name  ")).toBe("root-name");
  });

  it("reports syntax errors", () => {
    for (const bad of ["‘unterminated", "a #", "a &", "(a", "a b", "a +", ")", "f(a b)", "a ="]) {
      expect(() => ev(bad)).toThrow(ExpressionError);
    }
    expect(() => ev("‘unterminated")).toThrow(/Unterminated string/);
    expect(() => ev("a +")).toThrow(/Unexpected end/);
    expect(() => ev("(a")).toThrow(/Expected '\)'/);
    expect(() => ev("a b")).toThrow(/Unexpected 'b'/);
    expect(() => ev(")")).toThrow(/Unexpected '\)'/);
  });

  it("reports unknown functions", () => {
    expect(() => ev("nope(1)")).toThrow("Unknown function nope()");
    expect(() => ev("a.nope()")).toThrow("Unknown function a.nope()");
    expect(() => ev("$x(1)")).toThrow(/Unknown function/);
    expect(() => ev("toString(1)")).toThrow(/Unknown function/);
  });

  it("evaluates calls with no arguments through arity checking", () => {
    expect(() => ev("isBlank()")).toThrow(/takes 1 argument/);
  });
});

describe("evaluate: operators", () => {
  it("equality compares numerically when both look numeric", () => {
    expect(ev("‘1.0’ = 1")).toBe(true);
    expect(ev("‘01’ == ‘1’")).toBe(true);
    expect(ev("‘a’ = ‘a’")).toBe(true);
    expect(ev("‘2’ != 2")).toBe(false);
  });

  it("equality is case-sensitive on strings", () => {
    expect(ev("‘Yes’ = ‘yes’")).toBe(false);
    expect(ev("‘Yes’ != ‘yes’")).toBe(true);
  });

  it("null equals null or missing only", () => {
    expect(ev("null = missing")).toBe(true);
    expect(ev("missing == null")).toBe(true);
    expect(ev("null = ‘’")).toBe(false);
    expect(ev("‘x’ != null")).toBe(true);
    expect(ev("0 = null")).toBe(false);
  });

  it("booleans compare with their string forms", () => {
    expect(ev("false = ‘false’")).toBe(true);
    expect(ev("true = ‘true’")).toBe(true);
    expect(ev("true = ‘false’")).toBe(false);
    expect(ev("base.in_use = false")).toBe(true);
  });

  it("relational operators are numeric", () => {
    expect(ev("2 < 10")).toBe(true);
    expect(ev("‘2’ < ‘10’")).toBe(true);
    expect(ev("10 > 2")).toBe(true);
    expect(ev("2 <= 2")).toBe(true);
    expect(ev("2 >= 3")).toBe(false);
    expect(ev("‘a’ < 3")).toBe(false);
    expect(ev("missing > 0")).toBe(false);
  });

  it("plus adds numbers and concatenates otherwise", () => {
    expect(ev("1 + 2")).toBe(3);
    expect(ev("‘1’ + ‘2’")).toBe(3);
    expect(ev("‘a’ + ‘b’")).toBe("ab");
    expect(ev("‘a’ + 1")).toBe("a1");
    expect(ev("‘a’ + missing + ‘b’")).toBe("ab");
    expect(ev("true + ‘x’")).toBe("truex");
  });

  it("minus and unary minus", () => {
    expect(ev("5 - 3 - 1")).toBe(1);
    expect(ev("-2 + 5")).toBe(3);
    expect(ev("3 - -1")).toBe(4);
    expect(ev("‘x’ - 1")).toBeNaN();
  });

  it("not, and, or use truthy", () => {
    expect(ev("!false")).toBe(true);
    expect(ev("!‘false’")).toBe(true);
    expect(ev("!!‘x’")).toBe(true);
    expect(ev("!missing")).toBe(true);
    expect(ev("‘x’ && ‘’")).toBe(false);
    expect(ev("‘’ || ‘x’")).toBe(true);
    expect(ev("applicants && hearing.unavailableDates")).toBe(true);
  });

  it("short-circuits", () => {
    expect(ev("false && missing")).toBe(false);
    expect(ev("true || missing")).toBe(true);
  });

  it("precedence: ! > +- > relational > equality > && > ||", () => {
    expect(ev("1 + 2 = 3")).toBe(true);
    expect(ev("1 < 2 = true")).toBe(true);
    expect(ev("false || true && false")).toBe(false);
    expect(ev("true || false && false")).toBe(true);
    expect(ev("1 = 1 && 2 = 2")).toBe(true);
    expect(ev("!false = true")).toBe(true);
    expect(ev("2 + 3 > 4")).toBe(true);
    expect(ev("(true || false) && false")).toBe(false);
  });
});

describe("evaluate: methods and functions", () => {
  it("size, size() and isEmpty()", () => {
    expect(ev("applicants.size()")).toBe(1);
    expect(ev("applicants.size")).toBe(1);
    expect(ev("name.size")).toBe(9);
    expect(ev("name.size()")).toBe(9);
    expect(ev("missing.size()")).toBe(0);
    expect(ev("applicants.isEmpty()")).toBe(false);
    expect(ev("missing.isEmpty()")).toBe(true);
    expect(ev("$this.size()", root().child([1, 2, 3], 1, 1))).toBe(3);
  });

  it("falls back to an ordinary property called size", () => {
    expect(evaluate("box.size", Scope.withNow({ box: { size: "XL" } }, NOW))).toBe("XL");
    expect(ev("box.size")).toBeUndefined();
  });

  it("nests calls", () => {
    expect(ev("toUpperCase(ifBlank(missing, toLowerCase(‘ABC’)))")).toBe("ABC");
    expect(ev("round(round(2.5) + round(-2.5))")).toBe(1);
    expect(ev("titleCase(‘jane DOE’)")).toBe("Jane Doe");
  });

  it("propagates dateFormat errors", () => {
    expect(() => ev("dateFormat(‘garbage’, ‘yyyy’, ‘yyyy-MM-dd’)")).toThrow('dateFormat() Cannot parse date: value="garbage"');
  });

  it("formats with $nl and variables", () => {
    const r = root();
    r.setVar("greeting", "hi");
    expect(ev("$greeting + $nl", r)).toBe("hi\n");
  });

  it("formatValue and truthy are re-exported", () => {
    expect(formatValue([1, 2])).toBe("[1, 2]");
    expect(truthy("false")).toBe(false);
  });
});
