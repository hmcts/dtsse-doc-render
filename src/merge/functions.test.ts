import { describe, expect, it } from "vitest";
import { ExpressionError } from "./errors.ts";
import { callFunction, equalsIgnoreCase, hasFunction, isBlank, isEmpty, numFormat, round, sizeOf, titleCase } from "./functions.ts";
import { conditionTrue, formatValue, isNumeric, OperandError, repeatItems, scalar, toNumber, truthy } from "./values.ts";

describe("isBlank", () => {
  it.each([[null], [undefined], [""], ["   "], ["\t\n"], [[]], [[1]], [{ a: 1 }]])("is true for %j", (v) => {
    expect(isBlank(v)).toBe(true);
  });
  it.each([["a"], [0], [false], [" x "]])("is false for %j", (v) => {
    expect(isBlank(v)).toBe(false);
  });
});

describe("ifBlank", () => {
  it("falls back only when blank", () => {
    expect(callFunction("ifBlank", ["", "N/A"])).toBe("N/A");
    expect(callFunction("ifBlank", [undefined, "N/A"])).toBe("N/A");
    expect(callFunction("ifBlank", ["x", "N/A"])).toBe("x");
  });
});

describe("round", () => {
  it("Docmosis: round(-2.5) is -3, half away from zero", () => {
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-3);
    expect(round(-2.6)).toBe(-3);
    expect(round(0.49999999999999994)).toBe(0);
    expect(round("7")).toBe(7);
  });
  it("is blank for blank input and an error for text", () => {
    expect(round(null)).toBeUndefined();
    expect(round("")).toBeUndefined();
    expect(() => round("abc")).toThrow(/Cannot convert/);
  });
});

describe("case functions", () => {
  it("lower and upper case", () => {
    expect(callFunction("toLowerCase", ["AbC"])).toBe("abc");
    expect(callFunction("toUpperCase", ["AbC"])).toBe("ABC");
    expect(callFunction("toLowerCase", [null])).toBe("");
  });
  it("titleCase", () => {
    expect(titleCase("jOHN o'NEIL  smith")).toBe("John O'neil  Smith");
    expect(titleCase(null)).toBe("");
  });
  it("equalsIgnoreCase", () => {
    expect(equalsIgnoreCase("a", "A")).toBe(true);
    expect(equalsIgnoreCase("a", "b")).toBe(false);
    expect(equalsIgnoreCase(null, undefined)).toBe(true);
    expect(equalsIgnoreCase(null, "a")).toBe(false);
  });
});

describe("numFormat", () => {
  it.each([
    [2.5, "0", "2"],
    [3.5, "0", "4"],
    [-2.5, "0", "-2"],
    [-0.4, "0", "-0"],
    [0.5, "#", "0"],
    [0, "#", "0"],
    [12, "####", "12"],
    [7, "000", "007"],
    [1234567.891, "#,##0.00", "1,234,567.89"],
    [0.5, "#.##", "0.5"],
    [0.5, ".##", ".5"],
    [1.005, "0.00", "1.00"],
    [0.125, "0.00", "0.12"],
    [0.135, "0.00", "0.14"],
    [1.5, "0.0#", "1.5"],
    [1.999, "0.0#", "2.0"],
    [99.5, "0", "100"],
    [1e22, "0", "10000000000000000000000"],
    ["42", "0", "42"],
    [5, "0 units", "5 units"]
  ])("numFormat(%j, %s) = %s", (value, pattern, expected) => {
    expect(numFormat(value, pattern)).toBe(expected);
  });
  it("is blank for blank input and rejects bad arguments", () => {
    expect(numFormat(null, "0")).toBeUndefined();
    expect(() => numFormat("x", "0")).toThrow(/Cannot convert/);
    expect(() => numFormat(1, 2)).toThrow(/pattern string/);
  });
});

describe("size and isEmpty", () => {
  it("measures arrays, strings, objects and nothing", () => {
    expect(sizeOf([1, 2])).toBe(2);
    expect(sizeOf("abc")).toBe(0);
    expect(sizeOf(null)).toBe(0);
    expect(sizeOf({ a: 1 })).toBe(1);
    expect(sizeOf({})).toBe(1);
    expect(sizeOf(5)).toBe(0);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty("x")).toBe(true);
    expect(isEmpty({})).toBe(false);
  });
});

describe("registry", () => {
  it("Docmosis: an unknown function is null", () => {
    expect(hasFunction("round")).toBe(true);
    expect(hasFunction("toString")).toBe(false);
    expect(callFunction("nope", [])).toBeNull();
  });
  it("Docmosis: too few arguments is an error and extra arguments are ignored", () => {
    expect(() => callFunction("isBlank", [])).toThrow(/takes at least 1 argument/);
    expect(() => callFunction("dateFormat", [])).toThrow(/takes at least 1 argument/);
    expect(callFunction("toUpperCase", ["a", "b", "c"])).toBe("A");
  });
  it("dateFormat is registered", () => {
    expect(callFunction("dateFormat", ["2026-11-16", "d MMM yyyy", "yyyy-MM-dd"])).toBe("16 Nov 2026");
  });
});

describe("values", () => {
  it("formatValue follows Java toString", () => {
    expect(formatValue(null)).toBe("");
    expect(formatValue(undefined)).toBe("");
    expect(formatValue(3)).toBe("3");
    expect(formatValue(3.0)).toBe("3");
    expect(formatValue(-0)).toBe("0");
    expect(formatValue(2.5)).toBe("2.5");
    expect(formatValue(1e21)).toBe("1e+21");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(false)).toBe("false");
    expect(formatValue(["a", 1, null])).toBe("");
    expect(formatValue({ a: 1, b: [2] })).toBe("");
    expect(formatValue(new OperandError())).toBe("1.0");
    expect(formatValue(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01T00:00:00.000Z");
    expect(formatValue(new Date(Number.NaN))).toBe("");
  });
  it("Docmosis: padded numbers are not numeric", () => {
    expect(isNumeric(" 12 ")).toBe(false);
    expect(isNumeric("1.5")).toBe(true);
    expect(isNumeric("")).toBe(false);
    expect(isNumeric("a1")).toBe(false);
    expect(isNumeric(Number.NaN)).toBe(false);
    expect(isNumeric(true)).toBe(false);
    expect(toNumber("4")).toBe(4);
    expect(toNumber("x")).toBeNaN();
  });
  it("truthy", () => {
    expect([false, null, undefined, "", "false", [], "x", "yes", 1, 0, [1], {}].map(truthy)).toEqual(Array(12).fill(false));
    expect([true, "true", "TRUE"].map(truthy)).toEqual([true, true, true]);
    expect(conditionTrue(new OperandError())).toBe(true);
  });
  it("scalar nulls maps and lists", () => {
    expect(scalar([1])).toBeNull();
    expect(scalar({})).toBeNull();
    expect(scalar("x")).toBe("x");
    expect(scalar(new Date(0))).toEqual(new Date(0));
  });
  it("repeatItems", () => {
    expect(repeatItems([1])).toEqual([1]);
    expect(repeatItems({ a: 1 })).toEqual([{ a: 1 }]);
    expect(repeatItems("x")).toEqual([]);
  });
});

describe("string functions", () => {
  const call = (name: string, ...args: unknown[]) => callFunction(name, args);

  it("Docmosis: trim removes padding and leaves null and numbers alone", () => {
    expect(call("trim", "  pad  ")).toBe("pad");
    expect(call("trim", null)).toBeNull();
    expect(call("trim", 5)).toBe("5");
  });

  it("Docmosis: substring clamps the end, errors on a bad start and is empty for equal indices", () => {
    expect(call("substring", "hello World", 0, 5)).toBe("hello");
    expect(call("substring", "hello World", 6, 50)).toBe("World");
    expect(call("substring", "hello World", 2, 2)).toBe("");
    expect(call("substring", null, 0, 2)).toBeNull();
    expect(call("substring", 5, 0, 1)).toBe("5");
    expect(() => call("substring", "hello World", 3, 1)).toThrow(ExpressionError);
    expect(() => call("substring", "hello World", -1, 3)).toThrow(ExpressionError);
    expect(() => call("substring", "hello World", 6)).toThrow(/takes at least 3/);
    expect(() => call("substring", "hello World", "x", 3)).toThrow(/Cannot convert to a number/);
    expect(() => call("substring", "hello World", "", 3)).toThrow(/requires a number/);
  });

  it("Docmosis: length counts characters, is 0 for null, list and map and errors for a boolean", () => {
    expect(String(call("length", "hello World"))).toBe("11.0");
    expect(String(call("length", null))).toBe("0.0");
    expect(String(call("length", ["a"]))).toBe("0.0");
    expect(String(call("length", { a: 1 }))).toBe("0.0");
    expect(String(call("length", ""))).toBe("0.0");
    expect(String(call("length", 5))).toBe("1.0");
    expect(() => call("length", true)).toThrow(ExpressionError);
  });

  it("Docmosis: toSentence capitalises each sentence without lowercasing the rest", () => {
    expect(call("toSentence", "hello World")).toBe("Hello World");
    expect(call("toSentence", "hELLO wORLD. foo bar")).toBe("HELLO wORLD. Foo bar");
    expect(call("toSentence", "abc.def")).toBe("Abc.def");
    expect(call("toSentence", "a!b? c")).toBe("A!b? C");
    expect(call("toSentence", null)).toBeNull();
    expect(call("toSentence", 3)).toBe("3");
  });

  it("Docmosis: startsWith and endsWith are false for null and error for a null affix", () => {
    expect(call("startsWith", "hello World", "hello")).toBe(true);
    expect(call("startsWith", "hello World", "World")).toBe(false);
    expect(call("startsWith", "hello World", "")).toBe(true);
    expect(call("startsWith", null, "a")).toBe(false);
    expect(call("startsWith", 3, "3")).toBe(true);
    expect(call("endsWith", "hello World", "World")).toBe(true);
    expect(call("endsWith", "hello World", "x")).toBe(false);
    expect(call("endsWith", null, "x")).toBe(false);
    expect(() => call("startsWith", "hello World", null)).toThrow(ExpressionError);
    expect(() => call("endsWith", "hello World", null)).toThrow(ExpressionError);
  });

  it("Docmosis: split(s, sep, index) is empty out of range or for null and needs three arguments", () => {
    expect(call("split", "a,b,c", ",", 1)).toBe("b");
    expect(call("split", "a,b,c", ",", "0")).toBe("a");
    expect(call("split", "a,b,c", ",", 5)).toBeNull();
    expect(call("split", "a,b,c", ",", -1)).toBeNull();
    expect(call("split", null, ",", 0)).toBeNull();
    expect(() => call("split", "a,b,c", ",")).toThrow(/takes at least 3/);
    expect(() => call("split", "a,b,c", null, 0)).toThrow(ExpressionError);
  });

  it("Docmosis: replaceStr replaces every literal occurrence whatever the fourth argument", () => {
    expect(call("replaceStr", "hello World", "l", "L")).toBe("heLLo WorLd");
    expect(call("replaceStr", "hello World", "l", "L", false)).toBe("heLLo WorLd");
    expect(call("replaceStr", "hello World", ".", "x", true)).toBe("hello World");
    expect(call("replaceStr", "hello World", "o", "")).toBe("hell Wrld");
    expect(call("replaceStr", "hello World", "l", null)).toBe("heo Word");
    expect(call("replaceStr", null, "l", "L")).toBeNull();
  });

  it("Docmosis: map is case-sensitive, returns the default or nothing, and needs three arguments", () => {
    expect(call("map", "B", "A", "1", "B", "2", "z")).toBe("2");
    expect(call("map", "b", "A", "1", "B", "2", "z")).toBe("z");
    expect(call("map", "B", "A", "1", "B", "2")).toBe("2");
    expect(call("map", "Q", "A", "1", "B", "2", "z")).toBe("z");
    expect(call("map", "Q", "A", "1", "B", "2")).toBeNull();
    expect(call("map", null, "A", "1", "z")).toBe("z");
    expect(call("map", null, "A", "1")).toBeNull();
    expect(call("map", 2, "1", "one", "2", "two", "z")).toBe("two");
    expect(call("map", true, "true", "yes", "no")).toBe("yes");
    expect(() => call("map", "B", "B")).toThrow(/takes at least 3/);
  });

  it("Docmosis: mapi ignores case", () => {
    expect(call("mapi", "b", "A", "1", "B", "2", "z")).toBe("2");
    expect(call("mapi", "Q", "A", "1", "z")).toBe("z");
  });

  it("Docmosis: squote turns double quotes into single quotes and leaves apostrophes", () => {
    expect(call("squote", 'O’Brien ‘x’ "d" “q”')).toBe("O’Brien ‘x’ 'd' 'q'");
    expect(call("squote", "O'Brien")).toBe("O'Brien");
    expect(call("squote", null)).toBeNull();
    expect(call("squote", 3)).toBe("3");
  });

  it("Docmosis: function arguments that are maps or lists are null", () => {
    expect(call("toUpperCase", ["x"])).toBe("");
    expect(call("ifBlank", { a: 1 }, "d")).toBe("d");
  });
});
