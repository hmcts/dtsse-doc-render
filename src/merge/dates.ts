import { ExpressionError } from "./errors.ts";
import { formatValue } from "./values.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PATTERN_LETTERS = "GyYMLDdEuaHkKhmsSzZX";

interface Names {
  months: string[];
  monthsShort: string[];
  days: string[];
  daysShort: string[];
  am: string;
  pm: string;
  standaloneMonths?: string[];
  standaloneMonthsShort?: string[];
}

const ENGLISH: Names = {
  months: MONTHS,
  monthsShort: MONTHS.map((m) => m.slice(0, 3)),
  days: DAYS,
  daysShort: DAYS.map((d) => d.slice(0, 3)),
  am: "AM",
  pm: "PM"
};

const WELSH: Names = {
  months: ["Ionawr", "Chwefror", "Mawrth", "Ebrill", "Mai", "Mehefin", "Gorffennaf", "Awst", "Medi", "Hydref", "Tachwedd", "Rhagfyr"],
  monthsShort: ["Ion", "Chwef", "Maw", "Ebrill", "Mai", "Meh", "Gorff", "Awst", "Medi", "Hyd", "Tach", "Rhag"],
  days: ["Dydd Sul", "Dydd Llun", "Dydd Mawrth", "Dydd Mercher", "Dydd Iau", "Dydd Gwener", "Dydd Sadwrn"],
  daysShort: ["Sul", "Llun", "Maw", "Mer", "Iau", "Gwen", "Sad"],
  am: "yb",
  pm: "yh"
};

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

function intlNames(tag: string): Names {
  const at = (options: Intl.DateTimeFormatOptions, date: Date, type: string) =>
    new Intl.DateTimeFormat(tag, { ...options, timeZone: "UTC" }).formatToParts(date).find((p) => p.type === type)?.value ?? "";
  const month = (m: number, style: "long" | "short") => at({ day: "numeric", month: style }, new Date(Date.UTC(2024, m, 1)), "month");
  const day = (d: number, style: "long" | "short") => at({ weekday: style }, new Date(Date.UTC(2024, 0, 7 + d)), "weekday");
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const standalone = (m: number, style: "long" | "short") => at({ month: style, year: "numeric" }, new Date(Date.UTC(2024, m, 1)), "month");
  return {
    months: range(12).map((m) => month(m, "long")),
    monthsShort: range(12).map((m) => month(m, "short")),
    standaloneMonths: range(12).map((m) => standalone(m, "long")),
    standaloneMonthsShort: range(12).map((m) => standalone(m, "short")),
    days: range(7).map((d) => day(d, "long")),
    daysShort: range(7).map((d) => day(d, "short")),
    am: ENGLISH.am,
    pm: ENGLISH.pm
  };
}

const GREEK_STANDALONE_SHORT = ["Ιαν", "Φεβ", "Μάρ", "Απρ", "Μάι", "Ιούν", "Ιούλ", "Αύγ", "Σεπ", "Οκτ", "Νοέ", "Δεκ"];

const GREEK_NAMES = (): Names => ({ ...intlNames("el"), standaloneMonthsShort: GREEK_STANDALONE_SHORT, am: "π.μ.", pm: "μ.μ." });

const namesCache = new Map<string, Names>();

/**
 * The Docmosis locale argument: a language (en, fr) with an optional _REGION. Docmosis reads a bare "cy" as the region
 * Cyprus, so it gets Greek names, while cy_GB gets Welsh. English and any other language the platform knows about use
 * their own names. Anything else is rejected.
 */
export function localeNames(locale: unknown): Names {
  if (locale === undefined || locale === null) {
    return ENGLISH;
  }
  const text = formatValue(locale);
  const m = /^([A-Za-z]{2,3})(?:_([A-Za-z]{2}))?$/.exec(text);
  const language = m?.[1]?.toLowerCase();
  const region = m?.[2]?.toUpperCase();
  if (
    !language ||
    (language === "cy" && region !== undefined && region !== "GB") ||
    languageNames.of(language) === undefined ||
    (region !== undefined && (regionNames.of(region) ?? "Unknown Region") === "Unknown Region")
  ) {
    throw new ExpressionError(`dateFormat() The given locale "${formatValue(locale)}" is invalid`);
  }
  if (language === "en") {
    return ENGLISH;
  }
  if (language === "cy" && region !== undefined) {
    return WELSH;
  }
  if (language === "cy") {
    let greek = namesCache.get("cy");
    if (!greek) {
      greek = GREEK_NAMES();
      namesCache.set("cy", greek);
    }
    return greek;
  }
  let names = namesCache.get(language);
  if (!names) {
    names = intlNames(language);
    namesCache.set(language, names);
  }
  return names;
}

type Part = { lit: string } | { ch: string; n: number };

/** Splits a SimpleDateFormat pattern into literals and letter runs. Only ASCII letters are pattern letters, as in Java. */
function compile(pattern: string): Part[] {
  const parts: Part[] = [];
  let i = 0;
  const addLit = (text: string) => {
    const last = parts[parts.length - 1];
    if (last && "lit" in last) {
      last.lit += text;
    } else {
      parts.push({ lit: text });
    }
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "'") {
      if (pattern[i + 1] === "'") {
        addLit("'");
        i += 2;
        continue;
      }
      i++;
      let text = "";
      while (i < pattern.length) {
        if (pattern[i] === "'") {
          if (pattern[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          break;
        }
        text += pattern[i++];
      }
      if (i >= pattern.length) {
        throw new ExpressionError(`dateFormat() Unterminated quote in pattern "${pattern}"`);
      }
      i++;
      addLit(text);
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      if (!PATTERN_LETTERS.includes(c)) {
        throw new ExpressionError(`dateFormat() The date format "${pattern}" can not be applied as a format pattern`);
      }
      let n = 1;
      while (pattern[i + n] === c) {
        n++;
      }
      parts.push({ ch: c, n });
      i += n;
      continue;
    }
    addLit(c);
    i++;
  }
  return parts;
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");

function dayOfYear(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

/** Formats the wall-clock fields of `d`, read as UTC, with a Java SimpleDateFormat pattern in the English locale. */
export function formatDate(d: Date, pattern: string, names: Names = ENGLISH): string {
  let out = "";
  const parts = compile(pattern);
  const monthOnly = parts.every((p) => "lit" in p || p.ch === "M" || p.ch === "L");
  for (const part of parts) {
    if ("lit" in part) {
      out += part.lit;
      continue;
    }
    const { ch, n } = part;
    const hour = d.getUTCHours();
    switch (ch) {
      case "G":
        out += d.getUTCFullYear() > 0 ? "AD" : "BC";
        break;
      case "y":
      case "Y":
        out += n === 2 ? pad(d.getUTCFullYear() % 100, 2) : pad(d.getUTCFullYear(), n);
        break;
      case "M":
      case "L":
        if (n < 3) {
          out += pad(d.getUTCMonth() + 1, n);
        } else {
          const alone = ch === "L" || monthOnly;
          const list = n >= 4 ? (alone && names.standaloneMonths) || names.months : (alone && names.standaloneMonthsShort) || names.monthsShort;
          out += list[d.getUTCMonth()];
        }
        break;
      case "D":
        out += pad(dayOfYear(d), n);
        break;
      case "d":
        out += pad(d.getUTCDate(), n);
        break;
      case "E":
        out += n >= 4 ? names.days[d.getUTCDay()] : names.daysShort[d.getUTCDay()];
        break;
      case "u":
        out += pad(d.getUTCDay() === 0 ? 7 : d.getUTCDay(), n);
        break;
      case "a":
        out += hour < 12 ? names.am : names.pm;
        break;
      case "H":
        out += pad(hour, n);
        break;
      case "k":
        out += pad(hour === 0 ? 24 : hour, n);
        break;
      case "K":
        out += pad(hour % 12, n);
        break;
      case "h":
        out += pad(hour % 12 === 0 ? 12 : hour % 12, n);
        break;
      case "m":
        out += pad(d.getUTCMinutes(), n);
        break;
      case "s":
        out += pad(d.getUTCSeconds(), n);
        break;
      case "S":
        out += pad(d.getUTCMilliseconds(), n);
        break;
      case "z":
        out += n >= 4 ? "Coordinated Universal Time" : "UTC";
        break;
      case "Z":
        out += "+0000";
        break;
      default:
        out += "Z";
    }
  }
  return out;
}

const NUMERIC_FIELDS = "yYDdHkKhmsSu";

function isNumericPart(part: Part | undefined): boolean {
  if (!part || "lit" in part) {
    return false;
  }
  return NUMERIC_FIELDS.includes(part.ch) || ((part.ch === "M" || part.ch === "L") && part.n <= 2);
}

interface Fields {
  year: number;
  month: number;
  day: number;
  dayOfYear?: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  pm?: boolean;
  twelveHour: boolean;
}

function matchName(input: string, pos: number, names: string[]): { index: number; length: number } | undefined {
  const rest = input.slice(pos).toLowerCase();
  let best: { index: number; length: number } | undefined;
  names.forEach((name, index) => {
    for (const candidate of [name, name.slice(0, 3)]) {
      if (rest.startsWith(candidate.toLowerCase()) && (!best || candidate.length > best.length)) {
        best = { index, length: candidate.length };
      }
    }
  });
  return best;
}

function twoDigitYear(value: number): number {
  const current = new Date().getUTCFullYear();
  let year = current - (current % 100) + value;
  if (year < current - 80) {
    year += 100;
  } else if (year >= current + 20) {
    year -= 100;
  }
  return year;
}

/**
 * Parses like SimpleDateFormat.parse(String): lenient field ranges, trailing input ignored, no time zone.
 * Returns undefined when the input does not match.
 */
export function parseDate(input: string, pattern: string): Date | undefined {
  const parts = compile(pattern);
  const f: Fields = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0, twelveHour: false };
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if ("lit" in part) {
      if (!input.startsWith(part.lit, pos)) {
        return undefined;
      }
      pos += part.lit.length;
      continue;
    }
    const { ch, n } = part;
    const textual = ch === "E" || ch === "a" || ch === "G" || ((ch === "M" || ch === "L") && n >= 3);
    if (textual) {
      if (ch === "M" || ch === "L") {
        const m = matchName(input, pos, MONTHS);
        if (!m) {
          return undefined;
        }
        f.month = m.index + 1;
        pos += m.length;
      } else if (ch === "E") {
        const m = matchName(input, pos, DAYS);
        if (!m) {
          return undefined;
        }
        pos += m.length;
      } else if (ch === "a") {
        const word = input.slice(pos, pos + 2).toUpperCase();
        if (word !== "AM" && word !== "PM") {
          return undefined;
        }
        f.pm = word === "PM";
        pos += 2;
      } else {
        const word = input.slice(pos, pos + 2).toUpperCase();
        if (word !== "AD" && word !== "BC") {
          return undefined;
        }
        pos += 2;
      }
      continue;
    }
    if (ch === "z" || ch === "Z" || ch === "X") {
      const tz = /^(?:UTC|GMT|Z|[-+]\d{2}:?\d{2})/.exec(input.slice(pos));
      if (!tz) {
        return undefined;
      }
      pos += tz[0].length;
      continue;
    }
    const obey = isNumericPart(parts[i + 1]);
    const digits = new RegExp(`^\\d{1,${obey ? n : 1000}}`).exec(input.slice(pos));
    if (!digits) {
      return undefined;
    }
    const value = Number(digits[0]);
    pos += digits[0].length;
    switch (ch) {
      case "y":
      case "Y":
        f.year = n <= 2 && digits[0].length === 2 ? twoDigitYear(value) : value;
        break;
      case "M":
      case "L":
        f.month = value;
        break;
      case "D":
        f.dayOfYear = value;
        break;
      case "d":
        f.day = value;
        break;
      case "H":
        f.hour = value;
        break;
      case "k":
        f.hour = value === 24 ? 0 : value;
        break;
      case "K":
        f.hour = value;
        f.twelveHour = true;
        break;
      case "h":
        f.hour = value % 12;
        f.twelveHour = true;
        break;
      case "m":
        f.minute = value;
        break;
      case "s":
        f.second = value;
        break;
      case "S":
        f.ms = value;
        break;
      default:
        break;
    }
  }
  const hour = f.twelveHour && f.pm ? f.hour + 12 : f.hour;
  const date = new Date(0);
  date.setUTCFullYear(f.year, f.dayOfYear !== undefined ? 0 : f.month - 1, f.dayOfYear ?? f.day);
  date.setUTCHours(hour, f.minute, f.second, f.ms);
  return date;
}

const DEFAULT_INPUT_FORMATS = [
  "EEE MMM dd HH:mm:ss zzz yyyy",
  "yyyy-MM-dd'T'HH:mm:ss'Z'",
  "dd MMM yyyy",
  "dd-MMM-yyyy",
  "dd/MMM/yyyy",
  "dd MMM yy",
  "dd-MMM-yy",
  "dd/MMM/yy",
  "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
];

const curlyToStraight = (pattern: string) => pattern.replace(/[‘’]/g, "'");

function parseWithDefaults(text: string): Date | undefined {
  for (const pattern of DEFAULT_INPUT_FORMATS) {
    const date = parseDate(text, pattern);
    if (date) {
      return date;
    }
  }
  return undefined;
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Docmosis dateFormat(value, out[, in]). Dates are wall-clock values: nothing is converted between time zones, and
 * `$nowUTC` is a Date formatted as UTC. A blank value formats to an empty string.
 */
export function dateFormat(value: unknown, outArg: unknown = "dd MMM yyyy", inArg?: unknown, locale?: unknown, inLocale?: unknown): string {
  if (blank(value)) {
    return "";
  }
  const names = localeNames(locale);
  localeNames(inLocale);
  if (typeof outArg !== "string") {
    throw new ExpressionError("dateFormat() requires a format pattern string");
  }
  const out = curlyToStraight(outArg);
  const inPattern = typeof inArg === "string" ? curlyToStraight(inArg) : (inArg ?? undefined);
  let date: Date | undefined;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value);
  } else {
    const text = String(value);
    if (inPattern === undefined) {
      date = parseWithDefaults(text);
    } else if (typeof inPattern === "string") {
      date = inPattern === "" ? undefined : parseDate(text, inPattern);
    } else {
      throw new ExpressionError("dateFormat() requires an input pattern string");
    }
    if (!date) {
      const applied = typeof inPattern === "string" ? [inPattern] : DEFAULT_INPUT_FORMATS;
      throw new ExpressionError(`dateFormat() Cannot parse date:value="${text}" formats applied=[${applied.map((f) => `"${f}"`).join(",")}]`);
    }
  }
  if (Number.isNaN(date.getTime())) {
    throw new ExpressionError(`dateFormat() Cannot parse date: value="${String(value)}"`);
  }
  return formatDate(date, out, names);
}
