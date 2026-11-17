import { dateFormat } from "./dates.ts";
import { numFormat } from "./functions.ts";
import { Decimal, formatValue, isCollection, toDecimal } from "./values.ts";

/** A `field{renderer=name('a','b')}` suffix: the renderer's name and its quoted parameters. */
export interface Renderer {
  name: string;
  args: string[];
}

export interface QualifiedField {
  name: string;
  renderer?: Renderer;
  /** What Docmosis says about a suffix it cannot read. It rejects the template before merging anything. */
  error?: string;
}

/** A renderer failed on a value; reported the way Docmosis words it. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

const FIELD_NAME = /^[\w$.[\]]+$/;
const QUOTES = "'‘’";

const notWellFormed = (field: string): string =>
  `Field "${field}" has a qualifier that is not well formed.  Suggestion 1:Make sure your field has no spaces.    Suggestion 2:Make sure the qualifier format is "{key=value[,key=value[,...]]}" `;

const badParameters = (field: string): string =>
  `Field "${field}" is not of an acceptable format.  Each parameter to a renderer must be in single quotes (').  Suggestion 1:Check all the quote (') characters are matched.   Suggestion 2:Make sure your field contains no spaces. `;

const unclosedLiteral = (field: string): string =>
  `Field "${field}" is not of an acceptable format.  There is an unclosed literal.  Suggestion 1:Check all the quote (') characters are matched.   Suggestion 2:Make sure your field contains no spaces. `;

/** Splits on commas outside quotes and brackets. Quotes close where a comma or the end follows, so a pattern may hold quotes of its own. */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!quote && QUOTES.includes(ch)) {
      quote = true;
    } else if (quote && QUOTES.includes(ch) && /^\s*(?:[,)]|$)/.test(text.slice(i + 1))) {
      quote = false;
    } else if (!quote && ch === "(") {
      depth++;
    } else if (!quote && ch === ")") {
      depth--;
    } else if (!quote && ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) {
    return null;
  }
  parts.push(text.slice(start));
  return parts;
}

const MISSING_CLOSE = "missing";

function bracketFault(text: string): string | null {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") {
      if (depth > 0) {
        return "an open bracket '(' was found inside brackets.  Suggestion 1:Make sure brackets are not nested. ";
      }
      depth++;
    } else if (ch === ")") {
      if (depth === 0) {
        return "a close bracket ')' was found with no open bracket.  Suggestion 1:Make sure brackets are correct. ";
      }
      depth--;
    }
  }
  return depth > 0 ? MISSING_CLOSE : null;
}

const missingClose = (field: string): string => `Field "${field}" is missing the close bracket.  Suggestion 1:Make sure your field contains no spaces. `;

function parseRenderer(field: string, value: string): { renderer?: Renderer; error?: string } {
  const bracket = bracketFault(value);
  if (bracket) {
    return { error: bracket === MISSING_CLOSE ? missingClose(field) : `Field "${field}" is not valid - ${bracket}` };
  }
  const m = /^([A-Za-z_]\w*)(?:\(([\s\S]*)\))?$/.exec(value.trim());
  if (!m) {
    return { error: badParameters(field) };
  }
  const args: string[] = [];
  const inner = (m[2] ?? "").trim();
  if (inner !== "") {
    const parts = splitTopLevel(inner);
    if (!parts) {
      return { error: unclosedLiteral(field) };
    }
    for (const part of parts) {
      const arg = part.trim();
      if (arg.length < 2 || !QUOTES.includes(arg[0]!) || !QUOTES.includes(arg.at(-1)!)) {
        return { error: badParameters(field) };
      }
      args.push(arg.slice(1, -1));
    }
  }
  return { renderer: { name: m[1]!, args } };
}

/**
 * Reads `name{renderer=date('out','in')}`. Returns null for text that is not a name followed by a suffix, so the caller
 * treats it as an ordinary field. Spaces around the pieces are tolerated, as in Docmosis.
 */
export function parseQualified(text: string): QualifiedField | null {
  const open = text.indexOf("{");
  if (open <= 0) {
    return null;
  }
  const name = text.slice(0, open).trim();
  if (!FIELD_NAME.test(name)) {
    return null;
  }
  if (!text.trimEnd().endsWith("}")) {
    return { name, error: missingClose(text.trim()) };
  }
  const field = text.trim();
  const body = text.trimEnd().slice(open + 1, -1);
  if (body === "" || /[{}]/.test(body)) {
    return { name, error: notWellFormed(field) };
  }
  const items = splitTopLevel(body);
  if (!items) {
    return { name, error: unclosedLiteral(field) };
  }
  let renderer: Renderer | undefined;
  for (const item of items) {
    const eq = item.indexOf("=");
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (eq < 0 || key === "" || value === "") {
      return { name, error: notWellFormed(field) };
    }
    if (key !== "renderer") {
      return {
        name,
        error: `Field "${field}" has an unknown qualifier "${key}".  Suggestion 1:Make sure your field has no spaces.    Suggestion 2:Make sure the qualifier format is "{key=value[,key=value[,...]]}" `
      };
    }
    const parsed = parseRenderer(field, value);
    if (parsed.error) {
      return { name, error: parsed.error };
    }
    renderer = parsed.renderer;
  }
  return { name, renderer };
}

const BOOLEAN_FORMATS: Record<string, [string, string]> = {
  yesno: ["Yes", "No"],
  yesnouc: ["YES", "NO"],
  yesnolc: ["yes", "no"],
  yn: ["Y", "N"],
  ynlc: ["y", "n"],
  wingdings1: ["ü", "û"],
  wingdings2: ["þ", "¨"],
  dingbats1: ["✓", "✗"],
  dingbats2: ["✔", "✘"]
};
const BOOLEAN_FORMAT_NAMES = ["yesno", "wingdings2", "ynlc", "yn", "yesnouc", "yesnolc", "dingbats2", "wingdings1", "dingbats1"];

const isBlank = (value: unknown): boolean => value === undefined || value === null || isCollection(value) || formatValue(value).trim() === "";

function truthyBoolean(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value !== "string") {
    return false;
  }
  const s = value.toLowerCase();
  return s === "y" || s === "yes" || s === "t" || s === "true" || /^1(?:\.0+)?$/.test(s);
}

function renderBoolean(args: string[], value: unknown): string {
  if (args.length > 1) {
    throw new RenderError("Renderer:boolean can have at most one parameter");
  }
  const on = truthyBoolean(value);
  if (args.length === 0) {
    return on ? "true" : "false";
  }
  const pair = BOOLEAN_FORMATS[args[0]!.toLowerCase()];
  if (!pair) {
    const valid = BOOLEAN_FORMAT_NAMES.map((n) => `"${n}"`).join(", ");
    throw new RenderError(`Renderer:boolean unknown format: "${args[0]}".  Valid formats are: ${valid}`);
  }
  return on ? pair[0] : pair[1];
}

function renderDate(args: string[], value: unknown, field: string): string {
  if (args.length > 2) {
    throw new RenderError("Renderer:date can have at most two parameters");
  }
  if (isBlank(value)) {
    return "";
  }
  const out = args[0] ?? "dd MMM yyyy";
  if (out === "" && args.length > 0) {
    return "";
  }
  try {
    return dateFormat(formatValue(value), out, args[1]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const parse = /^dateFormat\(\) (Cannot parse date:.*)$/s.exec(message);
    if (parse) {
      throw new RenderError(`Can't parse field into a date (field="${field}" ${parse[1]})`);
    }
    const pattern = /requires a (?:format|input) pattern|pattern/i.test(message) ? /"([^"]*)"/.exec(message)?.[1] : undefined;
    throw new RenderError(`The date format "${pattern ?? args[1] ?? out}" can not be applied as a format pattern`);
  }
}

/** Java's NumberFormat.parse: an optional minus, digits with grouping commas, an optional fraction, and the rest ignored. */
function parseNumber(value: unknown): { decimal: Decimal; text: string } | undefined {
  if (typeof value === "number" || value instanceof Decimal) {
    const decimal = toDecimal(value);
    return decimal && { decimal, text: formatValue(value) };
  }
  const m = /^(-?)((?:\d|,)*)(?:\.(\d*))?/.exec(String(value));
  const int = (m?.[2] ?? "").replaceAll(",", "").replace(/^0+(?=\d)/, "");
  const frac = m?.[3] ?? "";
  if (!m || (int === "" && frac === "")) {
    return undefined;
  }
  const fraction = frac ? `.${frac}` : "";
  const text = `${m[1]}${int || "0"}${fraction}`;
  const decimal = Decimal.parse(text);
  return decimal && { decimal, text };
}

/** Puts a comma between each group of three digits, counting from the right. */
export function groupThousands(digits: string): string {
  const lead = digits.length % 3 || 3;
  const groups = [digits.slice(0, lead)];
  for (let i = lead; i < digits.length; i += 3) {
    groups.push(digits.slice(i, i + 3));
  }
  return groups.join(",");
}

export function trimTrailingZeros(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "0") {
    end--;
  }
  return s.slice(0, end);
}

function groupedDefault(d: Decimal): string {
  const [int = "0", frac = ""] = d.abs().toString().split(".");
  const grouped = groupThousands(int);
  const fraction = trimTrailingZeros(frac);
  const head = int === "0" && fraction !== "" ? "" : grouped;
  const tail = fraction ? `.${fraction}` : "";
  return `${d.unscaled < 0n ? "-" : ""}${head}${tail}`;
}

function renderNumber(args: string[], value: unknown): string {
  if (args.length > 3) {
    throw new RenderError("Renderer:number can have at most three parameters");
  }
  if (isBlank(value)) {
    return "";
  }
  const parsed = typeof value === "boolean" ? undefined : parseNumber(value);
  if (!parsed) {
    throw new RenderError(`Renderer:number Can't parse value as a number: "${formatValue(value)}".`);
  }
  if (args.slice(1).some((a) => a !== "")) {
    throw new RenderError("Renderer:number locale and currency parameters are not supported by dtsse-doc-render");
  }
  if (args.length === 0) {
    return parsed.text;
  }
  const pattern = args[0]!;
  if (pattern === "") {
    return groupedDefault(parsed.decimal);
  }
  if (/\..*\./.test(pattern)) {
    throw new RenderError(`Renderer:number unknown format: "${pattern}".`);
  }
  const percent = pattern.includes("%");
  const n = Number(parsed.decimal.toString());
  return numFormat(percent ? n * 100 : n, pattern.replaceAll("¤", "$")) ?? "";
}

/** Applies a renderer to a field's value. A name Docmosis does not know leaves the value as it is. */
export function applyRenderer(renderer: Renderer, value: unknown, field: string): string {
  switch (renderer.name) {
    case "date":
      return renderDate(renderer.args, value, field);
    case "number":
      return renderNumber(renderer.args, value);
    case "boolean":
      return renderBoolean(renderer.args, value);
    default:
      return formatValue(value);
  }
}
