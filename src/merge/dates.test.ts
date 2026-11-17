import { describe, expect, it } from "vitest";
import { dateFormat, formatDate, parseDate } from "./dates.ts";

const ISO = "yyyy-MM-dd'T'HH:mm:ss.SSS";
const wall = (d: Date | undefined) => (d ? formatDate(d, ISO) : undefined);

describe("formatDate", () => {
  const d = new Date(Date.UTC(2026, 10, 16, 14, 5, 7, 9));

  it.each([
    ["dd MMMM yyyy 'at' hh:mm aa", "16 November 2026 at 02:05 PM"],
    ["EEEE, dd MMMM yyyy", "Monday, 16 November 2026"],
    ["DD MMM YYYY", "320 Nov 2026"],
    ["dd/mm/yyyy", "16/05/2026"],
    ["y yy yyy yyyy", "2026 26 2026 2026"],
    ["MMMMM M MM MMM", "November 11 11 Nov"],
    ["S SSS SSSSS EEE E", "9 009 00009 Mon Mon"],
    ["h:mm a H k K", "2:05 PM 14 14 2"],
    ["d MMMM yyyy", "16 November 2026"],
    ["u G", "1 AD"],
    ["z Z", "UTC +0000"],
    ["zzzz X", "Coordinated Universal Time Z"],
    ["'o''clock' ''", "o'clock '"],
    ["yyyy-MM-dd'T'HH", "2026-11-16T14"]
  ])("formats %s", (pattern, expected) => {
    expect(formatDate(d, pattern)).toBe(expected);
  });

  it("handles midnight and noon in 12 and 24 hour clocks", () => {
    const midnight = new Date(Date.UTC(2026, 0, 4, 0, 5, 7));
    expect(formatDate(midnight, "h a hh H k K")).toBe("12 AM 12 0 24 0");
    expect(formatDate(midnight, "E u")).toBe("Sun 7");
    expect(formatDate(new Date(Date.UTC(2026, 0, 4, 12, 0)), "h a")).toBe("12 PM");
  });

  it("treats a BC year as BC", () => {
    const bc = new Date(0);
    bc.setUTCFullYear(-5);
    expect(formatDate(bc, "G")).toBe("BC");
  });

  it("rejects illegal and unterminated patterns", () => {
    expect(() => formatDate(d, "yyyy w")).toThrow(/Illegal pattern character 'w'/);
    expect(() => formatDate(d, "yyyy 'abc")).toThrow(/Unterminated quote/);
  });

  it("computes day of year around a leap day", () => {
    expect(formatDate(new Date(Date.UTC(2028, 2, 1)), "D")).toBe("61");
    expect(formatDate(new Date(Date.UTC(2026, 11, 31)), "DDD")).toBe("365");
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-11-16T10:00:00", "yyyy-MM-dd", "2026-11-16T00:00:00.000"],
    ["2026-11-16", "yyyy-mm-dd", "2026-01-16T00:11:00.000"],
    ["16112026", "ddMMyyyy", "2026-11-16T00:00:00.000"],
    ["20261116", "yyyyMMdd", "2026-11-16T00:00:00.000"],
    ["0930", "HHmm", "1970-01-01T09:30:00.000"],
    ["2026-11-16 02:05PM", "yyyy-MM-dd hh:mmaa", "2026-11-16T14:05:00.000"],
    ["2026-11-16 12:05am", "yyyy-MM-dd hh:mmaa", "2026-11-16T00:05:00.000"],
    ["2026-11-16T14:05:00.000", ISO, "2026-11-16T14:05:00.000"],
    ["2026-11-16T14:05:00.000", "yyyy-MM-dd'T'HH:mm:ss.000", "2026-11-16T14:05:00.000"],
    ["16-11-2026", "dd-MM-yyyy", "2026-11-16T00:00:00.000"],
    ["2026-1-5", "yyyy-MM-dd", "2026-01-05T00:00:00.000"],
    ["2026-13-45", "yyyy-MM-dd", "2027-02-14T00:00:00.000"],
    ["16 nov 2026", "dd MMM yyyy", "2026-11-16T00:00:00.000"],
    ["16 November 2026", "dd MMMM yyyy", "2026-11-16T00:00:00.000"],
    ["Mon 16 Nov 2026", "EEE dd MMM yyyy", "2026-11-16T00:00:00.000"],
    ["2026-11-16T14:05:00.5", ISO, "2026-11-16T14:05:00.005"],
    ["2026-11-16 14:05:00 UTC", "yyyy-MM-dd HH:mm:ss z", "2026-11-16T14:05:00.000"],
    ["2026-11-16 14:05:00 +0100", "yyyy-MM-dd HH:mm:ss Z", "2026-11-16T14:05:00.000"],
    ["AD 2026", "G yyyy", "2026-01-01T00:00:00.000"],
    ["321 2026", "D yyyy", "2026-11-17T00:00:00.000"],
    ["24 2026-11-16", "k yyyy-MM-dd", "2026-11-16T00:00:00.000"],
    ["3 2026-11-16", "K yyyy-MM-dd", "2026-11-16T03:00:00.000"],
    ["7 2026", "u yyyy", "2026-01-01T00:00:00.000"]
  ])("parses %s with %s", (input, pattern, expected) => {
    expect(wall(parseDate(input, pattern))).toBe(expected);
  });

  it("parses a two-digit year into a window around now", () => {
    const year = new Date().getUTCFullYear();
    const parsed = parseDate("5-1-26", "d-M-yy")!;
    expect(Math.abs(parsed.getUTCFullYear() - year)).toBeLessThanOrEqual(80);
    expect(parsed.getUTCFullYear() % 100).toBe(26);
    const wrapped = parseDate(`1-1-${String((year + 25) % 100).padStart(2, "0")}`, "d-M-yy")!;
    expect(wrapped.getUTCFullYear()).toBe(year - 75);
    const past = parseDate(`1-1-${String((year - 90) % 100).padStart(2, "0")}`, "d-M-yy")!;
    expect(past.getUTCFullYear()).toBe(year + 10);
  });

  it.each([
    ["2026-11-16T14:05:00.123", "yyyy-MM-dd'T'HH:mm:ss.000"],
    ["not a date", "yyyy-MM-dd"],
    ["2026/11/16", "yyyy-MM-dd"],
    ["16 Foo 2026", "dd MMM yyyy"],
    ["xx 16", "EEE dd"],
    ["2026-11-16 14:05 XM", "yyyy-MM-dd HH:mm a"],
    ["XX 2026", "G yyyy"],
    ["2026-11-16 14:05 nope", "yyyy-MM-dd HH:mm z"],
    ["", "yyyy"]
  ])("returns undefined for %s with %s", (input, pattern) => {
    expect(parseDate(input, pattern)).toBeUndefined();
  });
});

describe("dateFormat", () => {
  it("formats a Date as wall-clock UTC", () => {
    expect(dateFormat(new Date(Date.UTC(2026, 10, 16, 23, 30)), "d MMMM yyyy HH:mm")).toBe("16 November 2026 23:30");
  });

  it("parses with the input pattern then formats", () => {
    expect(dateFormat("2026-11-16T14:05:00.000", "dd MMMM yyyy 'at' hh:mm aa", ISO)).toBe("16 November 2026 at 02:05 PM");
    expect(dateFormat("2026-11-16", "dd MMM yyyy", "yyyy-MM-dd")).toBe("16 Nov 2026");
  });

  it("accepts an ISO string and an epoch number without an input pattern", () => {
    expect(dateFormat("2026-11-16T14:05:00.000", "HH:mm")).toBe("14:05");
    expect(dateFormat("2026-11-16", "d MMM yyyy")).toBe("16 Nov 2026");
    expect(dateFormat(Date.UTC(2026, 10, 16), "d MMM yyyy")).toBe("16 Nov 2026");
  });

  it("returns an empty string for a blank value", () => {
    expect(dateFormat(undefined, "yyyy")).toBe("");
    expect(dateFormat(null, "yyyy", "yyyy")).toBe("");
    expect(dateFormat("  ", "yyyy", "yyyy")).toBe("");
  });

  it("throws the Docmosis message for an unparseable value", () => {
    expect(() => dateFormat("garbage", "yyyy", "yyyy-MM-dd")).toThrow('dateFormat() Cannot parse date: value="garbage"');
    expect(() => dateFormat("garbage", "yyyy")).toThrow('dateFormat() Cannot parse date: value="garbage"');
    expect(() => dateFormat(new Date(Number.NaN), "yyyy")).toThrow("Cannot parse date");
  });

  it("rejects non-string patterns", () => {
    expect(() => dateFormat("2026", 5)).toThrow(/format pattern/);
    expect(() => dateFormat("2026", "yyyy", 5)).toThrow(/input pattern/);
  });
});
