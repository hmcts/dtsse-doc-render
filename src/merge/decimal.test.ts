import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal.ts";

const d = (text: string) => Decimal.parse(text)!;

describe("Decimal", () => {
  it("Docmosis: prints plain notation with at least one fractional digit and no trailing zeros", () => {
    expect(String(d("1"))).toBe("1.0");
    expect(String(d("1.50"))).toBe("1.5");
    expect(String(d("-0"))).toBe("0.0");
    expect(String(d("0.0001"))).toBe("0.0001");
    expect(String(d("1e21"))).toBe("1000000000000000000000.0");
    expect(String(d("1.5e-3"))).toBe("0.0015");
    expect(String(d(".5"))).toBe("0.5");
    expect(String(d("-12345678.25"))).toBe("-12345678.25");
  });

  it("rejects text that is not a number", () => {
    expect(Decimal.parse("")).toBeUndefined();
    expect(Decimal.parse(".")).toBeUndefined();
    expect(Decimal.parse("abc")).toBeUndefined();
    expect(Decimal.fromNumber(Number.NaN)).toBeUndefined();
    expect(String(Decimal.fromNumber(2.5))).toBe("2.5");
  });

  it("Docmosis: adds, subtracts and multiplies exactly", () => {
    expect(String(d("0.10").add(d("0.20")))).toBe("0.3");
    expect(String(d("1").sub(d("0.9")))).toBe("0.1");
    expect(String(d("1000000").mul(d("1000000")))).toBe("1000000000000.0");
    expect(String(d("123456789012345678").add(d("0")))).toBe("123456789012345678.0");
  });

  it("Docmosis: divides to 64 significant digits, rounding half up", () => {
    expect(String(d("10").div(d("4")))).toBe("2.5");
    expect(String(d("10").div(d("2")))).toBe("5.0");
    expect(String(d("1").div(d("3")))).toBe(`0.${"3".repeat(64)}`);
    expect(String(d("2").div(d("3")))).toBe(`0.${"6".repeat(63)}7`);
    expect(String(d("100").div(d("3")))).toBe(`33.${"3".repeat(62)}`);
    expect(String(d("-2").div(d("3")))).toBe(`-0.${"6".repeat(63)}7`);
    expect(String(d("1").div(d("7")))).toBe("0.1428571428571428571428571428571428571428571428571428571428571429");
  });

  it("Docmosis: the remainder takes the sign of the dividend", () => {
    expect(String(d("7").rem(d("3")))).toBe("1.0");
    expect(String(d("-7").rem(d("3")))).toBe("-1.0");
    expect(String(d("7.5").rem(d("2")))).toBe("1.5");
  });

  it("compares, negates and converts", () => {
    expect(d("1.0").compare(d("1"))).toBe(0);
    expect(d("1").compare(d("2"))).toBe(-1);
    expect(d("3").compare(d("2.5"))).toBe(1);
    expect(d("2").negate().abs().toNumber()).toBe(2);
    expect(d("-2").abs().toNumber()).toBe(2);
    expect(d("0").isZero()).toBe(true);
    expect(d("0.1").isZero()).toBe(false);
    expect(Decimal.of(5n, -2).toNumber()).toBe(500);
  });
});
