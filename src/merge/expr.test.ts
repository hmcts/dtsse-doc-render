import { describe, expect, it } from "vitest";
import { conditionTrue, ExpressionError, evaluate, formatValue, type Instruction, parseInstruction, repeatItems, Scope, truthy } from "./expr.ts";

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
    ["else{a=1}", { kind: "else" }],
    ["else {a=1}", { kind: "else" }],
    ["else{ a=‘unterminated}", { kind: "else" }],
    ["/* note */", { kind: "comment" }],
    ["/* unterminated", { kind: "comment" }]
  ] as [string, Instruction][])("%s", (text, expected) => {
    expect(parseInstruction(text)).toEqual(expected);
  });

  it("Docmosis: anything after else that does not start with an underscore is ignored, even a field name", () => {
    expect(parseInstruction("elsewhere")).toEqual({ kind: "else" });
  });
});

describe("parseInstruction assignments and fields", () => {
  it.each([
    ["$rowNum={round($rowNum+1)}", { kind: "assign", name: "rowNum", expr: "round($rowNum+1)" }],
    ["$x={a = b}", { kind: "assign", name: "x", expr: "a = b" }],
    ["$x = {a}", { kind: "assign", name: "x", expr: "a" }],
    ["$n=0", { kind: "assign", name: "n", expr: "numberLiteral('0')" }],
    ["$n=-5.50", { kind: "assign", name: "n", expr: "numberLiteral('-5.50')" }],
    ["$n={5}", { kind: "assign", name: "n", expr: "5" }],
    ["$f=true", { kind: "assign", name: "f", expr: "true" }],
    ["$s=word", { kind: "assign", name: "s", expr: "word" }],
    ["$s={'quoted'}", { kind: "assign", name: "s", expr: "'quoted'" }],
    ["$s=‘quoted’", { kind: "assign", name: "s", expr: "‘quoted’" }]
  ] as [string, Instruction][])("%s", (text, expected) => {
    expect(parseInstruction(text)).toEqual(expected);
  });

  it("does not treat == as an assignment", () => {
    expect(parseInstruction("$a == 1")).toEqual({ kind: "field", expr: "$a == 1", optionalParagraph: false });
  });

  it("Docmosis: $x=word assigns the value of the field word, and numbers and true/false are literals", () => {
    const r = Scope.withNow({ word: "from data" }, NOW);
    for (const [text, expected] of [
      ["$s=word", "from data"],
      ["$s={'word'}", "word"],
      ["$s=5", 5],
      ["$s=true", true],
      ["$s=false", false],
      ["$s=hello", undefined],
      ["$s=TRUE", undefined]
    ] as const) {
      const inst = parseInstruction(text);
      expect(inst.kind === "assign" && ev(inst.expr, r)).toBe(expected);
    }
  });

  it("parses fields", () => {
    expect(parseInstruction("a.b")).toEqual({ kind: "field", expr: "a.b", optionalParagraph: false });
    expect(parseInstruction(" {x + 1} ")).toEqual({ kind: "field", expr: "x + 1", optionalParagraph: false });
    expect(parseInstruction("op:a.b")).toEqual({ kind: "field", expr: "a.b", optionalParagraph: true });
    expect(parseInstruction("op:{a}")).toEqual({ kind: "field", expr: "{a}", optionalParagraph: true });
  });

  it("Docmosis: link:x renders the value of x", () => {
    expect(parseInstruction("link:url")).toEqual({ kind: "field", expr: "url", optionalParagraph: false });
    expect(parseInstruction("link:{url}")).toEqual({ kind: "field", expr: "url", optionalParagraph: false });
  });

  it("Docmosis: html:x renders the value of x for the renderer to strip", () => {
    expect(parseInstruction("html:markup")).toEqual({ kind: "field", expr: "markup", optionalParagraph: false, html: true });
    expect(parseInstruction("html:{markup}")).toEqual({ kind: "field", expr: "markup", optionalParagraph: false, html: true });
  });

  it.each([["image:a.png"], ["img:a"], ["md:text"], ["bookmark:b"]])("%s is unsupported", (text) => {
    const inst = parseInstruction(text);
    expect(inst.kind).toBe("unsupported");
    expect(inst).toMatchObject({ text, reason: expect.stringContaining("not supported") });
  });

  it("Docmosis: a renderer suffix is read with the field it follows", () => {
    expect(parseInstruction("issuedOn{renderer=date('dd/MM/yyyy')}")).toEqual({
      kind: "field",
      expr: "issuedOn",
      optionalParagraph: false,
      renderer: { name: "date", args: ["dd/MM/yyyy"] },
      qualifierError: undefined
    });
    expect(parseInstruction("op:issuedOn{renderer=boolean}")).toMatchObject({ optionalParagraph: true, renderer: { name: "boolean", args: [] } });
    expect(parseInstruction("issuedOn{renderer=date(dd/MM/yyyy)}")).toMatchObject({ kind: "field", qualifierError: expect.stringContaining("single quotes") });
  });

  it("Docmosis: ref:name and refLookup:path name a template to include", () => {
    expect(parseInstruction("ref:other.docx")).toEqual({ kind: "ref", name: "other.docx" });
    expect(parseInstruction("ref:other.docx ")).toEqual({ kind: "ref", name: "other.docx" });
    expect(parseInstruction("refLookup:value")).toEqual({ kind: "refLookup", path: "value" });
    expect(() => parseInstruction("ref:")).toThrow("is not complete");
    expect(() => parseInstruction("ref: x")).toThrow("leading or trailing whitespace");
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

  it("Docmosis: a bare name inside a repeat resolves on the current item only", () => {
    const outer = root().child({ onlyOuter: "o", shared: "outer" }, 1, 1);
    const inner = outer.child({ shared: "inner" }, 1, 1);
    expect(inner.lookup("shared")).toBe("inner");
    expect(inner.lookup("onlyOuter")).toBeUndefined();
    expect(inner.lookup("issuedOn")).toBeUndefined();
    expect(inner.lookup("$parent.shared")).toBe("outer");
    expect(inner.lookup("$root.issuedOn")).toBe("2026-11-16");
    expect(inner.lookup("$this.shared")).toBe("inner");
    expect(root().lookup("issuedOn")).toBe("2026-11-16");
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
  });

  it("Docmosis: reading a never-assigned variable is a Variable not found error", () => {
    expect(() => root().lookup("$undef")).toThrow('Variable not found "$undef"');
    expect(() => ev("$undef = 1")).toThrow(/Variable not found/);
    const r = root();
    r.setVar("known", undefined);
    expect(r.lookup("$known")).toBeUndefined();
  });

  it.each(["num", "itemnum", "this", "size", "root", "parent"])("Docmosis: $%s=5 is Cannot set built in variable", (name) => {
    expect(() => root().setVar(name, 5)).toThrow(`Cannot set built in variable $${name}`);
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
  it.each([["‘x’"], ["’x’"], ["‘x'"], ["'x'"], ["’x‘"]])("Docmosis: %s delimits a string", (lit) => {
    expect(ev(lit)).toBe("x");
  });

  it("Docmosis: a curly double-quoted string is Field term must start with an Alphabetic letter", () => {
    expect(() => ev("s = “pending”")).toThrow('Field term "“pending”" must start with an Alphabetic letter or $');
    expect(() => ev("ifBlank(e, ”d”)")).toThrow('Field term "”d”" must start with an Alphabetic letter or $');
  });

  it("Docmosis: a straight double-quoted string is Expression is invalid", () => {
    expect(() => ev('s = "pending"')).toThrow("Expression is invalid");
  });

  it("keeps quotes inside a format pattern", () => {
    expect(ev("dateFormat('2026-11-16T14:05:00.000', 'dd MMMM yyyy ‘at’ hh:mm aa', ‘yyyy-MM-dd'T'HH:mm:ss.SSS’)")).toBe("16 November 2026 at 02:05 PM");
  });

  it("Docmosis: dateFormat(dt,’yyyy-MM-dd’T’HH:mm:ss.000’,'yyyy-MM-dd') keeps the inner ’T’", () => {
    expect(ev("dateFormat('2024-03-05',’yyyy-MM-dd’T’HH:mm:ss.000’,'yyyy-MM-dd')")).toBe("2024-03-05T00:00:00.000");
    expect(ev("dateFormat(issuedOn,’yyyy-MM-dd’T’HH:mm:ss.000’,‘yyyy-MM-dd’)")).toBe("2026-11-16T00:00:00.000");
  });

  it("Docmosis: a pattern with doubled quotes is rejected as a format pattern", () => {
    expect(() => ev("dateFormat(issuedOn,'yyyy-MM-dd''T''HH','yyyy-MM-dd')")).toThrow(
      "The date format \"yyyy-MM-dd''T''HH\" can not be applied as a format pattern"
    );
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
    expect(formatValue(ev("12"))).toBe("12.0");
    expect(formatValue(ev("1.5"))).toBe("1.5");
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

  it("Docmosis: an unknown function is empty in field and condition position", () => {
    expect(ev("nope(1)")).toBeNull();
    expect(ev("nope(1) + 'a'")).toBe("nulla");
    expect(conditionTrue(ev("nope(1)"))).toBe(false);
    expect(conditionTrue(ev("nope(1) = 'a'"))).toBe(false);
  });

  it("rejects a method on a path that is not size or isEmpty", () => {
    expect(() => ev("a.nope()")).toThrow("Unknown function a.nope()");
    expect(() => ev("$x(1)")).toThrow(/Unknown function/);
  });

  it("Docmosis: an unclosed function is Function is not closed", () => {
    expect(() => ev("toUpperCase(name")).toThrow("Function is not closed");
    expect(() => ev("applicants.size(")).toThrow("Function is not closed");
  });

  it("Docmosis: toUpperCase() with too few arguments is an error and extra arguments are ignored", () => {
    expect(() => ev("isBlank()")).toThrow(/takes at least 1 argument/);
    expect(ev("toUpperCase(name, name)")).toBe("ROOT-NAME");
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
    expect(formatValue(ev("1 + 2"))).toBe("3.0");
    expect(formatValue(ev("‘1’ + ‘2’"))).toBe("3.0");
    expect(ev("‘a’ + ‘b’")).toBe("ab");
    expect(ev("‘a’ + 1")).toBe("a1.0");
    expect(ev("‘a’ + missing + ‘b’")).toBe("anullb");
    expect(ev("true + ‘x’")).toBe("truex");
  });

  it("minus and unary minus", () => {
    expect(formatValue(ev("5 - 3 - 1"))).toBe("1.0");
    expect(formatValue(ev("-2 + 5"))).toBe("3.0");
    expect(formatValue(ev("3 - -1"))).toBe("4.0");
    expect(() => ev("‘x’ - 1")).toThrow("Invalid operation for a string.");
  });

  it("Docmosis: ! on a boolean, 'true'/'false', null or a map or list is a boolean", () => {
    expect(ev("!false")).toBe(true);
    expect(ev("!‘false’")).toBe(true);
    expect(ev("!‘TRUE’")).toBe(false);
    expect(ev("!missing")).toBe(true);
    expect(ev("!applicants")).toBe(true);
    expect(ev("!1")).toBe(false);
    expect(ev("!0")).toBe(true);
  });

  it("Docmosis: {!a} for a string or number a prints 1.0, is true as a condition and is an invalid operand elsewhere", () => {
    const flagged = ev("!name");
    expect(formatValue(flagged)).toBe("1.0");
    expect(conditionTrue(flagged)).toBe(true);
    expect(formatValue(ev("!documentCount"))).toBe("1.0");
    expect(formatValue(ev("!‘’"))).toBe("1.0");
    for (const expr of ["!name && true", "!name || false", "!name = 1", "!name + 'z'", "!(!name)", "!name < 1", "-(!name)"]) {
      expect(() => ev(expr), expr).toThrow("Invalid operand for unary operator");
    }
  });

  it("Docmosis: && and || treat a bare operand as true only for true or 'true'", () => {
    expect(ev("‘x’ && true")).toBe(false);
    expect(ev("true && ‘TRUE’")).toBe(true);
    expect(ev("false || ‘x’")).toBe(false);
    expect(ev("false || ‘true’")).toBe(true);
    expect(ev("documentCount && true")).toBe(false);
    expect(ev("applicants && true")).toBe(false);
    expect(ev("1 && true")).toBe(true);
    expect(ev("2 && true")).toBe(false);
    expect(ev("0 || false")).toBe(false);
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
  it("Docmosis: size() is the list length, 0 for a string and 1 for a map; isEmpty() is true for a string", () => {
    expect(ev("applicants.size()")).toBe(1);
    expect(ev("applicants.size")).toBe(1);
    expect(ev("name.size()")).toBe(0);
    expect(ev("name.isEmpty()")).toBe(true);
    expect(ev("primaryAddress.size()")).toBe(1);
    expect(ev("primaryAddress.isEmpty()")).toBe(false);
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
    expect(ev("round(round(2.5) + round(-2.4))")).toBe(1);
    expect(ev("titleCase(‘jane DOE’)")).toBe("Jane Doe");
  });

  it("propagates dateFormat errors", () => {
    expect(() => ev("dateFormat(‘garbage’, ‘yyyy’, ‘yyyy-MM-dd’)")).toThrow('dateFormat() Cannot parse date:value="garbage"');
  });

  it("formats with $nl and variables", () => {
    const r = root();
    r.setVar("greeting", "hi");
    expect(ev("$greeting + $nl", r)).toBe("hi\n");
  });

  it("formatValue, truthy and conditionTrue are re-exported", () => {
    expect(formatValue([1, 2])).toBe("");
    expect(truthy("false")).toBe(false);
    expect(truthy("true")).toBe(true);
    expect(conditionTrue(true)).toBe(true);
  });

  it("Docmosis: 2-arg dateFormat of a value that is not a default format errors, but $nowUTC works", () => {
    expect(() => ev("dateFormat(issuedOn,'yyyy')")).toThrow(
      'dateFormat() Cannot parse date:value="2026-11-16" formats applied=["EEE MMM dd HH:mm:ss zzz yyyy"'
    );
    expect(ev("dateFormat('05 Mar 2024','yyyy')")).toBe("2024");
    expect(ev("dateFormat($nowUTC,'yyyy')")).toBe("2026");
    expect(ev("dateFormat($nowUTC)")).toBe("16 Nov 2026");
  });

  it("Docmosis: a map or list is null where a value is expected", () => {
    expect(formatValue(ev("primaryAddress"))).toBe("");
    expect(formatValue(ev("applicants"))).toBe("");
    expect(ev("primaryAddress != null")).toBe(false);
    expect(ev("primaryAddress = null")).toBe(true);
    expect(ev("applicants != null")).toBe(false);
    expect(ev("isBlank(primaryAddress)")).toBe(true);
    expect(ev("isBlank(applicants)")).toBe(true);
    expect(ev("ifBlank(primaryAddress, 'none')")).toBe("none");
    expect(ev("toUpperCase(applicants)")).toBe("");
    expect(ev("applicants = primaryAddress")).toBe(true);
    expect(ev("primaryAddress + 'x'")).toBe("nullx");
    expect(ev("primaryAddress.AddressLine2")).toBe("Flat 2");
  });

  it("Docmosis: bare conditions are true only for true and 'true'", () => {
    for (const v of [true, "true", "TRUE", "True"]) {
      expect(conditionTrue(v), String(v)).toBe(true);
    }
    for (const v of ["x", "yes", " true ", 1, 0, [1], { a: 1 }, "", null, undefined, false, "false"]) {
      expect(conditionTrue(v), String(v)).toBe(false);
    }
  });

  it("Docmosis: rs_ repeats a list, treats a map as one item and skips scalars", () => {
    expect(repeatItems([1, 2])).toEqual([1, 2]);
    expect(repeatItems({ k: "v" })).toEqual([{ k: "v" }]);
    for (const v of ["p", "true", 5, true, "", null, undefined]) {
      expect(repeatItems(v), String(v)).toEqual([]);
    }
  });

  it("Docmosis: braceless function calls are empty, or Field term is missing closing bracket when an argument has a dot", () => {
    expect(parseInstruction("titleCase(word)")).toEqual({ kind: "field", expr: "null", optionalParagraph: false });
    expect(parseInstruction("dateFormat(d,'dd MMM yyyy','yyyy-MM-dd')")).toEqual({ kind: "field", expr: "null", optionalParagraph: false });
    expect(() => parseInstruction("titleCase(party.name, x)")).toThrow(`Field term "titleCase(party" is missing closing bracket: ')'.`);
    expect(parseInstruction("word.size()")).toEqual({ kind: "field", expr: "word.size()", optionalParagraph: false });
    expect(parseInstruction("{titleCase(word)}")).toEqual({ kind: "field", expr: "titleCase(word)", optionalParagraph: false });
  });
});

describe("Docmosis numbers", () => {
  const show = (expr: string, scope = Scope.withNow({ n: 5, neg: -2.5, f: 1.5, str: "7", big: 12345678, s: "hello World", l: [1, 2] }, NOW)) =>
    formatValue(evaluate(expr, scope));

  it.each([
    ["1", "1.0"],
    ["-1", "-1.0"],
    ["n", "5"],
    ["neg", "-2.5"],
    ["1 + 1", "2.0"],
    ["n + n", "10.0"],
    ["n + 1", "6.0"],
    ["10000000", "10000000.0"],
    ["big + 0", "12345678.0"],
    ["big * 10", "123456780.0"],
    ["0.0001 + 0", "0.0001"],
    ["0.1 + 0.2", "0.3"],
    ["0.10 + 0.20", "0.3"],
    ["1.5 * 2", "3.0"],
    ["str + 1", "8.0"],
    ["str", "7"],
    ["1 - 0.9", "0.1"],
    ["100000000000 + 0", "100000000000.0"],
    ["0 - 0", "0.0"],
    ["-0", "0.0"],
    ["-(n + 0)", "-5.0"],
    ["n * f", "7.5"],
    ["'3' * 2", "6.0"],
    ["length(s)", "11.0"],
    ["length(s) + 0", "11.0"],
    ["l.size()", "2"],
    ["l.size() + 1", "3.0"],
    ["round(2.5)", "3"],
    ["round(-2.5)", "-3"],
    ["round(neg)", "-3"],
    ["round(1/3)", "0"],
    ["round(2.5) + 1", "4.0"],
    ["numFormat(1/3, '0.00')", "0.33"],
    ["numFormat(5 + 1, '0.00')", "6.00"],
    ["'a' + (n + 1)", "a6.0"],
    ["(n + 1) + 'a'", "6.0a"],
    ["'a' + n", "a5"],
    ["ifBlank(missing, 5)", "5.0"],
    ["ifBlank(missing, 5.5)", "5.5"],
    ["toUpperCase(1 + 1)", "2.0"]
  ])("Docmosis: {%s} prints %s", (expr, expected) => {
    expect(show(expr)).toBe(expected);
  });

  it.each([
    ["2 + 3 * 4", "14.0"],
    ["10 - 4 / 2", "8.0"],
    ["2 * 3 + 4", "10.0"],
    ["(2 + 3) * 4", "20.0"],
    ["10 - 2 - 3", "5.0"],
    ["100 / 10 / 5", "2.0"],
    ["2 * 3 % 4", "2.0"],
    ["7 % 4 * 2", "6.0"],
    ["7 % 3", "1.0"],
    ["-7 % 3", "-1.0"],
    ["7.5 % 2", "1.5"],
    ["1 / 2", "0.5"],
    ["10 / 2", "5.0"],
    ["2 - -1", "3.0"],
    ["- 1 + 2", "1.0"]
  ])("Docmosis: {%s} follows the usual precedence and gives %s", (expr, expected) => {
    expect(show(expr)).toBe(expected);
  });

  it("Docmosis: 1/3 has 64 significant digits and dividing or taking a remainder by zero uses doubles", () => {
    expect(show("1/3")).toBe(`0.${"3".repeat(64)}`);
    expect(show("1/0")).toBe("Infinity");
    expect(show("-1/0")).toBe("-Infinity");
    expect(show("n / 0")).toBe("Infinity");
    expect(show("0 / 0")).toBe("NaN");
    expect(show("n % 0")).toBe("NaN");
    expect(show("0 / 1")).toBe("0.0");
  });

  it("Docmosis: numbers compare by value whatever their scale", () => {
    expect(show("1 = 1.0")).toBe("true");
    expect(show("n = 5.0")).toBe("true");
    expect(show("f = 1.50")).toBe("true");
    expect(show("1 + 1 = 2.0")).toBe("true");
    expect(show("(1 + 1) = '2.0'")).toBe("true");
    expect(show("6 / 3 = 2")).toBe("true");
    expect(show("n > 4.5")).toBe("true");
    expect(show("length(s) = 11")).toBe("true");
  });

  it("Docmosis: arithmetic on a non-number is Invalid operation for a string.", () => {
    for (const expr of ["missing * 2", "missing - 1", "s * 2", "'x' * 1", "'' * 2", "' 3 ' * 2", "l * 2", "true * 2", "nn / 2", "missing % 2"]) {
      expect(() => show(expr), expr).toThrow("Invalid operation for a string.");
    }
    expect(show("missing + 1")).toBe("null1.0");
  });

  it("Docmosis: unary minus accepts only literals and computed numbers", () => {
    for (const expr of ["-n", "-f", "-str", "-s"]) {
      expect(() => show(expr), expr).toThrow("Invalid operation for a string.");
    }
    const inRepeat = Scope.withNow({}, NOW).child({}, 1, 2);
    expect(() => evaluate("-$itemnum", inRepeat)).toThrow("Invalid operation for a string.");
  });

  it("Docmosis: $itemnum and $size print as plain integers and add as decimals", () => {
    const scope = Scope.withNow({}, NOW).child({}, 2, 3);
    expect(formatValue(evaluate("$itemnum", scope))).toBe("2");
    expect(formatValue(evaluate("$size", scope))).toBe("3");
    expect(formatValue(evaluate("$itemnum + 0", scope))).toBe("2.0");
  });

  it("Docmosis: $v=5 holds a plain number and $v={5} a computed one", () => {
    const scope = Scope.withNow({ n: 5 }, NOW);
    for (const [text, expected, plus] of [
      ["$v=5", "5", "6.0"],
      ["$v=5.50", "5.5", "6.5"],
      ["$v=-5", "-5", "-4.0"],
      ["$v={5}", "5.0", "6.0"],
      ["$v={n+1}", "6.0", "7.0"],
      ["$v=n", "5", "6.0"]
    ] as const) {
      const inst = parseInstruction(text);
      if (inst.kind !== "assign") {
        throw new Error("expected an assignment");
      }
      scope.setVar(inst.name, evaluate(inst.expr, scope));
      expect(formatValue(evaluate("$v", scope)), text).toBe(expected);
      expect(formatValue(evaluate("$v + 1", scope)), text).toBe(plus);
    }
  });

  it("Docmosis: consecutive unary operators report the index of the second", () => {
    expect(() => ev("!!x")).toThrow("Consecutive unary operators are not allowed (index=2)");
    expect(() => ev("! !x")).toThrow("Consecutive unary operators are not allowed (index=3)");
    expect(() => ev("!!!x")).toThrow("Consecutive unary operators are not allowed (index=2)");
    expect(() => ev("!-1")).toThrow("Consecutive unary operators are not allowed (index=2)");
    expect(ev("!(!true)")).toBe(true);
  });

  it("Docmosis: rs_ and rr_ with braces are Field term must start with an Alphabetic letter", () => {
    expect(() => parseInstruction("rs_{l}")).toThrow('Field term "{l}" must start with an Alphabetic letter or $');
    expect(() => parseInstruction("rs_ {l} x")).toThrow('Field term "{l}" must start with an Alphabetic letter or $');
    expect(() => parseInstruction("rr_{l}")).toThrow("must start with an Alphabetic letter");
    expect(parseInstruction("rs_l")).toEqual({ kind: "rs", expr: "l" });
  });

  it("Docmosis: indexOf, abs and concat", () => {
    const data = Scope.withNow({ s: "hello World", neg: -2.5, n: 5, x: true, o: { k: 1 } }, NOW);
    const run = (expr: string) => formatValue(evaluate(expr, data));
    expect(run("indexOf(s, 'o')")).toBe("4.0");
    expect(run("indexOf(s, 'o', 5)")).toBe("7.0");
    expect(run("indexOf(s, 'zz')")).toBe("-1.0");
    expect(run("indexOf(missing, 'o')")).toBe("-1.0");
    expect(run("indexOf(s, '')")).toBe("0.0");
    expect(run("lastIndexOf(s, 'o')")).toBe("7.0");
    expect(() => run("indexOf(s, missing)")).toThrow("indexOf() Second argument cannot be null");
    expect(run("abs(neg)")).toBe("2.5");
    expect(run("abs(-3)")).toBe("3.0");
    expect(run("abs(n)")).toBe("5.0");
    for (const bad of ["abs('x')", "abs(missing)", "abs('')"]) {
      expect(() => run(bad), bad).toThrow("abs() Invalid argument.");
    }
    expect(run("concat(s, '!')")).toBe("hello World!");
    expect(run("concat(n, x)")).toBe("5true");
    for (const bad of ["concat(s, missing)", "concat(missing, missing)", "concat(s)", "concat(s, 'a', 'b')", "concat()", "concat(o, s)"]) {
      expect(() => run(bad), bad).toThrow("concat() Two string arguments are required.");
    }
  });

  it("Docmosis: map compares numbers by value", () => {
    expect(formatValue(ev("map(2, 2, 3)"))).toBe("3.0");
    expect(formatValue(ev("map(1 + 1, 2, 3)"))).toBe("3.0");
    expect(formatValue(ev("map(1 + 1, '2', 3)"))).toBe("3.0");
  });

  it("Docmosis: dateFormat validates its locale arguments", () => {
    for (const bad of ["'x'", "''", "'xx'", "'cy-GB'", "'cy_'", "'en_GB_x'", "'en_ZZ'", "5", "true"]) {
      expect(() => ev(`dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', ${bad})`), bad).toThrow(/The given locale ".*" is invalid/);
    }
    expect(() => ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'cy', 'x')")).toThrow('The given locale "x" is invalid');
    expect(() => ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'cy', 1, 2, 3, 4)")).toThrow("dateFormat() requires 1 to 7 parameters");
    expect(ev("dateFormat(missing, 'dd', 'yyyy', 'x')")).toBe("");
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', missing)")).toBe("March");
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'en_GB')")).toBe("March");
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'EN_gb')")).toBe("March");
  });

  it("Docmosis: dateFormat with cy_GB formats Welsh names", () => {
    expect(ev("dateFormat('2024-03-05', 'dd MMMM yyyy', 'yyyy-MM-dd', 'cy_GB')")).toBe("05 Mawrth 2024");
    expect(ev("dateFormat('2024-01-07', 'MMMM|MMM|EEEE|EEE', 'yyyy-MM-dd', 'cy_GB')")).toBe("Ionawr|Ion|Dydd Sul|Sul");
    expect(ev("dateFormat('2024-07-05', 'MMMM|MMM|EEEE|EEE', 'yyyy-MM-dd', 'cy_GB')")).toBe("Gorffennaf|Gorff|Dydd Gwener|Gwen");
    expect(ev("dateFormat('2024-03-05T15:00:00', 'a h', 'yyyy-MM-dd’T’HH:mm:ss', 'cy_GB')")).toBe("yh 3");
    expect(ev("dateFormat('2024-03-05T09:00:00', 'a', 'yyyy-MM-dd’T’HH:mm:ss', 'cy_GB')")).toBe("yb");
  });

  it("Docmosis: dateFormat with plain 'cy' or 'CY' gives Greek names, as the local container did", () => {
    expect(ev("dateFormat('2024-03-05', 'dd MMMM yyyy EEEE', 'yyyy-MM-dd', 'cy')")).toBe("05 Μαρτίου 2024 Τρίτη");
    expect(ev("dateFormat('2024-03-05', 'dd MMM yyyy EEE', 'yyyy-MM-dd', 'cy')")).toBe("05 Μαρ 2024 Τρί");
    expect(ev("dateFormat('2024-03-05', 'dd MMMM yyyy', 'yyyy-MM-dd', 'CY')")).toBe("05 Μαρτίου 2024");
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'CY')")).toBe("Μάρτιος");
    expect(ev("dateFormat('2024-03-05', 'MMM', 'yyyy-MM-dd', 'CY')")).toBe("Μάρ");
    expect(ev("dateFormat('2024-03-05', 'MMMM yyyy', 'yyyy-MM-dd', 'CY')")).toBe("Μαρτίου 2024");
    expect(ev("dateFormat('2024-03-05', 'LLLL', 'yyyy-MM-dd', 'CY')")).toBe("Μάρτιος");
    expect(ev("dateFormat('2024-03-05', 'MMMM MMM EEEE EEE a', 'yyyy-MM-dd', 'cy')")).toBe("Μαρτίου Μαρ Τρίτη Τρί π.μ.");
    expect(ev("dateFormat('2024-12-05', 'MMMM MMM EEEE EEE', 'yyyy-MM-dd', 'cy')")).toBe("Δεκεμβρίου Δεκ Πέμπτη Πέμ");
    expect(ev("dateFormat('2024-03-05T15:00:00', 'a', 'yyyy-MM-dd’T’HH:mm:ss', 'cy')")).toBe("μ.μ.");
    expect(() => ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'cy_CY')")).toThrow('The given locale "cy_CY" is invalid');
  });

  it("dateFormat takes the names of any other language the platform knows", () => {
    expect(ev("dateFormat('2024-03-05', 'dd MMMM yyyy EEEE', 'yyyy-MM-dd', 'fr')")).toBe("05 mars 2024 mardi");
    expect(ev("dateFormat('2024-03-05', 'dd MMMM yyyy', 'yyyy-MM-dd', 'de')")).toBe("05 März 2024");
    expect(ev("dateFormat('2024-03-05', 'MMM EEE', 'yyyy-MM-dd', 'fr')")).toMatch(/^mars mar/);
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'fr')")).toBe("mars");
    expect(ev("dateFormat('2024-03-05', 'MMMM', 'yyyy-MM-dd', 'fr_FR')")).toBe("mars");
  });
});
