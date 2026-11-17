import { describe, expect, it } from "vitest";
import { callFunction, equalsIgnoreCase, hasFunction, isBlank, isEmpty, numFormat, round, sizeOf, titleCase } from "./functions.ts";
import { formatValue, isNumeric, toNumber, truthy } from "./values.ts";

describe("isBlank", () => {
  it.each([[null], [undefined], [""], ["   "], ["\t\n"], [[]]])("is true for %j", (v) => {
    expect(isBlank(v)).toBe(true);
  });
  it.each([["a"], [0], [false], [[1]], [" x "]])("is false for %j", (v) => {
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
  it("uses Java Math.round semantics", () => {
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-2);
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
    expect(sizeOf("abc")).toBe(3);
    expect(sizeOf(null)).toBe(0);
    expect(sizeOf({ a: 1 })).toBe(1);
    expect(sizeOf(5)).toBe(1);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty("x")).toBe(false);
  });
});

describe("registry", () => {
  it("knows its functions and rejects the rest", () => {
    expect(hasFunction("round")).toBe(true);
    expect(hasFunction("toString")).toBe(false);
    expect(() => callFunction("nope", [])).toThrow("Unknown function nope()");
  });
  it("checks arity", () => {
    expect(() => callFunction("isBlank", [])).toThrow(/takes 1 argument/);
    expect(() => callFunction("dateFormat", [1])).toThrow(/takes 2 to 3 argument/);
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
    expect(formatValue(["a", 1, null])).toBe("[a, 1, null]");
    expect(formatValue({ a: 1, b: [2] })).toBe("{a=1, b=[2]}");
    expect(formatValue(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01T00:00:00.000Z");
    expect(formatValue(new Date(Number.NaN))).toBe("");
  });
  it("numeric helpers", () => {
    expect(isNumeric(" 12 ")).toBe(true);
    expect(isNumeric("1.5")).toBe(true);
    expect(isNumeric("")).toBe(false);
    expect(isNumeric("a1")).toBe(false);
    expect(isNumeric(Number.NaN)).toBe(false);
    expect(isNumeric(true)).toBe(false);
    expect(toNumber("4")).toBe(4);
    expect(toNumber("x")).toBeNaN();
  });
  it("truthy", () => {
    expect([false, null, undefined, "", "false", []].map(truthy)).toEqual([false, false, false, false, false, false]);
    expect([true, "x", 0, [1], {}].map(truthy)).toEqual([true, true, true, true, true]);
  });
});
