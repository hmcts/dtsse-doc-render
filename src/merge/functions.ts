import { dateFormat } from "./dates.ts";
import { ExpressionError } from "./errors.ts";
import { formatValue, isNumeric, toNumber } from "./values.ts";

type Fn = (...args: unknown[]) => unknown;

const isNil = (v: unknown) => v === undefined || v === null;

export function isBlank(value: unknown): boolean {
  if (isNil(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return formatValue(value).trim() === "";
}

export function sizeOf(value: unknown): number {
  if (isNil(value)) {
    return 0;
  }
  if (Array.isArray(value) || typeof value === "string") {
    return value.length;
  }
  if (typeof value === "object") {
    return Object.keys(value).length;
  }
  return 1;
}

export function isEmpty(value: unknown): boolean {
  return sizeOf(value) === 0;
}

function numberArg(name: string, value: unknown): number | undefined {
  if (isNil(value) || (typeof value === "string" && value.trim() === "")) {
    return undefined;
  }
  if (!isNumeric(value)) {
    throw new ExpressionError(`${name}() Cannot convert to a number: value="${formatValue(value)}"`);
  }
  return toNumber(value);
}

/** Java Math.round: half-up toward positive infinity. */
export function round(value: unknown): number | undefined {
  const n = numberArg("round", value);
  return n === undefined ? undefined : Math.round(n);
}

export function titleCase(value: unknown): string {
  return formatValue(value)
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_, space: string, ch: string) => space + ch.toUpperCase());
}

export function equalsIgnoreCase(a: unknown, b: unknown): boolean {
  if (isNil(a) || isNil(b)) {
    return isNil(a) && isNil(b);
  }
  return formatValue(a).toUpperCase().toLowerCase() === formatValue(b).toUpperCase().toLowerCase();
}

/** Rounds the non-negative decimal expansion of `abs` to `places` digits using HALF_EVEN on its exact binary value. */
function roundHalfEven(abs: number, places: number): { int: string; frac: string } {
  if (abs >= 1e21) {
    return { int: BigInt(abs).toString(), frac: "".padEnd(places, "0") };
  }
  const digits = abs.toFixed(Math.min(100, places + 30));
  const [intPart, fracPart = ""] = digits.split(".");
  let kept = intPart! + fracPart.slice(0, places).padEnd(places, "0");
  const rest = fracPart.slice(places);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  const lastDigit = Number(kept[kept.length - 1]);
  if (first > 5 || (first === 5 && (tail || lastDigit % 2 === 1))) {
    kept = (BigInt(kept) + 1n).toString().padStart(kept.length, "0");
  }
  return { int: places === 0 ? kept : kept.slice(0, kept.length - places), frac: places === 0 ? "" : kept.slice(kept.length - places) };
}

/** A subset of java.text.DecimalFormat: 0 # , and . with HALF_EVEN rounding. Other pattern characters pass through. */
export function numFormat(value: unknown, pattern: unknown): string | undefined {
  const n = numberArg("numFormat", value);
  if (n === undefined) {
    return undefined;
  }
  if (typeof pattern !== "string") {
    throw new ExpressionError("numFormat() requires a pattern string");
  }
  const m = /^([^#0,.]*)([#0,]*)(?:\.([#0]*))?(.*)$/.exec(pattern);
  const prefix = m![1]!;
  const intPattern = m![2]!;
  const fracPattern = m![3] ?? "";
  const suffix = m![4]!;
  const minInt = (intPattern.match(/0/g) ?? []).length;
  const minFrac = (fracPattern.match(/0/g) ?? []).length;
  const maxFrac = fracPattern.length;
  const comma = intPattern.lastIndexOf(",");
  const group = comma === -1 ? 0 : intPattern.length - comma - 1;

  const negative = n < 0 || Object.is(n, -0);
  const { int, frac: rawFrac } = roundHalfEven(Math.abs(n), maxFrac);
  let frac = rawFrac;
  while (frac.length > minFrac && frac.endsWith("0")) {
    frac = frac.slice(0, -1);
  }
  let intDigits = int.replace(/^0+/, "");
  intDigits = intDigits.padStart(minInt, "0");
  if (intDigits === "" && (frac === "" || intPattern !== "")) {
    intDigits = "0";
  }
  if (group > 0) {
    intDigits = intDigits.replace(new RegExp(`\\B(?=(\\d{${group}})+$)`, "g"), ",");
  }
  return `${negative ? "-" : ""}${prefix}${intDigits}${frac ? `.${frac}` : ""}${suffix}`;
}

function arity(name: string, args: unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : `${min} to ${max}`;
    throw new ExpressionError(`${name}() takes ${expected} argument(s) but was given ${args.length}`);
  }
}

const define =
  (name: string, min: number, max: number, f: Fn): Fn =>
  (...args) => {
    arity(name, args, min, max);
    return f(...args);
  };

const FUNCTIONS: Record<string, Fn> = {
  isBlank: define("isBlank", 1, 1, (v) => isBlank(v)),
  ifBlank: define("ifBlank", 2, 2, (v, alt) => (isBlank(v) ? alt : v)),
  round: define("round", 1, 1, (v) => round(v)),
  toLowerCase: define("toLowerCase", 1, 1, (v) => formatValue(v).toLowerCase()),
  toUpperCase: define("toUpperCase", 1, 1, (v) => formatValue(v).toUpperCase()),
  titleCase: define("titleCase", 1, 1, (v) => titleCase(v)),
  equalsIgnoreCase: define("equalsIgnoreCase", 2, 2, (a, b) => equalsIgnoreCase(a, b)),
  numFormat: define("numFormat", 2, 2, (v, p) => numFormat(v, p)),
  dateFormat: define("dateFormat", 2, 3, (v, out, inPattern) => dateFormat(v, out, inPattern))
};

export function hasFunction(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

export function callFunction(name: string, args: unknown[]): unknown {
  if (!hasFunction(name)) {
    throw new ExpressionError(`Unknown function ${name}()`);
  }
  return FUNCTIONS[name]!(...args);
}
