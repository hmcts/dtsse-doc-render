import { dateFormat } from "./dates.ts";
import { ExpressionError } from "./errors.ts";
import { Decimal, formatValue, isCollection, isNumeric, scalar, toDecimal, toNumber } from "./values.ts";

type Fn = (...args: unknown[]) => unknown;

const isNil = (v: unknown) => v === undefined || v === null;

export function isBlank(value: unknown): boolean {
  return isNil(value) || isCollection(value) || formatValue(value).trim() === "";
}

export function sizeOf(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  return isCollection(value) ? 1 : 0;
}

export function isEmpty(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : !isCollection(value);
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

/** Rounds half away from zero, as Docmosis does: round(-2.5) is -3. */
export function round(value: unknown): number | undefined {
  const n = numberArg("round", value);
  return n === undefined ? undefined : Math.sign(n) * Math.round(Math.abs(n));
}

const decimal = (n: number): Decimal => Decimal.fromNumber(n)!;

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

const text = (v: unknown): string | null => (isNil(v) ? null : formatValue(v));

function required(name: string, v: unknown): string {
  if (isNil(v)) {
    throw new ExpressionError(`${name}() requires a value`);
  }
  return formatValue(v);
}

function integer(name: string, v: unknown): number {
  const n = numberArg(name, v);
  if (n === undefined) {
    throw new ExpressionError(`${name}() requires a number`);
  }
  return Math.trunc(n);
}

export function toSentence(value: unknown): string | null {
  const t = text(value);
  return t === null ? null : t.replace(/(^|[.!?]\s+)(\S)/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

export function substring(value: unknown, start: unknown, end: unknown): string | null {
  const t = text(value);
  if (t === null) {
    return null;
  }
  const from = integer("substring", start);
  const to = Math.min(integer("substring", end), t.length);
  if (from < 0 || from > to) {
    throw new ExpressionError(`substring() invalid range ${from} to ${to} for a value of length ${t.length}`);
  }
  return t.slice(from, to);
}

export function splitAt(value: unknown, separator: unknown, index: unknown): string | null {
  const t = text(value);
  if (t === null) {
    return null;
  }
  return t.split(required("split", separator))[integer("split", index)] ?? null;
}

export function mapValue(ignoreCase: boolean, value: unknown, rest: unknown[]): unknown {
  const fold = (v: unknown) => (ignoreCase ? formatValue(v).toLowerCase() : formatValue(v));
  const same = (a: unknown, b: unknown) => (isNumeric(a) && isNumeric(b) ? toDecimal(a)!.compare(toDecimal(b)!) === 0 : fold(a) === fold(b));
  const fallback = rest.length % 2 === 1 ? rest[rest.length - 1] : null;
  if (isNil(value)) {
    return fallback;
  }
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (same(rest[i], value)) {
      return rest[i + 1];
    }
  }
  return fallback;
}

export function indexOf(name: string, value: unknown, sub: unknown, from: unknown, last: boolean): Decimal {
  if (isNil(sub)) {
    throw new ExpressionError(`${name}() Second argument cannot be null`);
  }
  const t = text(value);
  if (t === null) {
    return decimal(-1);
  }
  const needle = formatValue(sub);
  const start = from === undefined ? undefined : integer(name, from);
  return decimal(last ? t.lastIndexOf(needle, start) : t.indexOf(needle, start));
}

export function absolute(value: unknown): Decimal {
  const d = isNil(value) ? undefined : toDecimal(value);
  if (!d) {
    throw new ExpressionError("abs() Invalid argument.");
  }
  return d.abs();
}

export function concat(args: unknown[]): string {
  if (args.length !== 2 || isNil(args[0]) || isNil(args[1])) {
    throw new ExpressionError("concat() Two string arguments are required.");
  }
  return formatValue(args[0]) + formatValue(args[1]);
}

function arity(name: string, args: unknown[], min: number): void {
  if (args.length < min) {
    throw new ExpressionError(`${name}() takes at least ${min} argument(s) but was given ${args.length}`);
  }
}

const define =
  (name: string, min: number, f: Fn): Fn =>
  (...args) => {
    arity(name, args, min);
    return f(...args);
  };

const FUNCTIONS: Record<string, Fn> = {
  isBlank: define("isBlank", 1, (v) => isBlank(v)),
  ifBlank: define("ifBlank", 2, (v, alt) => (isBlank(v) ? alt : v)),
  round: define("round", 1, (v) => round(v)),
  toLowerCase: define("toLowerCase", 1, (v) => formatValue(v).toLowerCase()),
  toUpperCase: define("toUpperCase", 1, (v) => formatValue(v).toUpperCase()),
  titleCase: define("titleCase", 1, (v) => titleCase(v)),
  equalsIgnoreCase: define("equalsIgnoreCase", 2, (a, b) => equalsIgnoreCase(a, b)),
  numFormat: define("numFormat", 2, (v, p) => numFormat(v, p)),
  dateFormat: define("dateFormat", 1, (...args) => {
    if (args.length > 7) {
      throw new ExpressionError("dateFormat() requires 1 to 7 parameters");
    }
    return dateFormat(...(args as Parameters<typeof dateFormat>));
  }),
  trim: define("trim", 1, (v) => text(v)?.trim() ?? null),
  substring: define("substring", 3, (v, a, b) => substring(v, a, b)),
  length: define("length", 1, (v) => (typeof v === "boolean" ? fail("length() cannot measure a boolean") : decimal(text(v)?.length ?? 0))),
  indexOf: define("indexOf", 2, (v, sub, from) => indexOf("indexOf", v, sub, from, false)),
  lastIndexOf: define("lastIndexOf", 2, (v, sub, from) => indexOf("lastIndexOf", v, sub, from, true)),
  abs: define("abs", 1, (v) => absolute(v)),
  concat: (...args) => concat(args),
  numberLiteral: define("numberLiteral", 1, (v) => Number(v)),
  toSentence: define("toSentence", 1, (v) => toSentence(v)),
  startsWith: define("startsWith", 2, (v, p) => (isNil(v) ? false : formatValue(v).startsWith(required("startsWith", p)))),
  endsWith: define("endsWith", 2, (v, p) => (isNil(v) ? false : formatValue(v).endsWith(required("endsWith", p)))),
  split: define("split", 3, (v, sep, i) => splitAt(v, sep, i)),
  replaceStr: define(
    "replaceStr",
    3,
    (v, from, to) =>
      text(v)
        ?.split(required("replaceStr", from))
        .join(text(to) ?? "") ?? null
  ),
  map: define("map", 3, (v, ...rest) => mapValue(false, v, rest)),
  mapi: define("mapi", 3, (v, ...rest) => mapValue(true, v, rest)),
  squote: define("squote", 1, (v) => text(v)?.replace(/["“”]/g, "'") ?? null)
};

function fail(message: string): never {
  throw new ExpressionError(message);
}

export function hasFunction(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

/** Unknown functions yield null, and arguments beyond a function's own are ignored. */
export function callFunction(name: string, args: unknown[]): unknown {
  if (!hasFunction(name)) {
    return null;
  }
  return FUNCTIONS[name]!(...args.map(scalar));
}
