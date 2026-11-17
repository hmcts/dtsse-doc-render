import { Decimal } from "./decimal.ts";

export { Decimal };

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)$/;

export function isNumeric(value: unknown): boolean {
  if (value instanceof Decimal) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && NUMERIC.test(value);
}

export function toNumber(value: unknown): number {
  if (value instanceof Decimal) {
    return value.toNumber();
  }
  if (typeof value === "number") {
    return value;
  }
  if (isNumeric(value)) {
    return Number(value);
  }
  return Number.NaN;
}

/** The exact decimal of a number, a numeric string or a Decimal; undefined for anything else. */
export function toDecimal(value: unknown): Decimal | undefined {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === "number") {
    return Decimal.fromNumber(value);
  }
  return typeof value === "string" && NUMERIC.test(value) ? Decimal.parse(value.replace(/^\+/, "")) : undefined;
}

/** What Docmosis evaluates `!x` to when x is a string or number: it prints as 1.0 and is rejected as an operand. */
export class OperandError {
  toString(): string {
    return "1.0";
  }
}

export function isCollection(value: unknown): boolean {
  return (
    Array.isArray(value) ||
    (typeof value === "object" && value !== null && !(value instanceof Date) && !(value instanceof OperandError) && !(value instanceof Decimal))
  );
}

/** Maps and lists are null wherever a single value is expected. */
export function scalar(value: unknown): unknown {
  return isCollection(value) ? null : value;
}

/** A bare condition is true only for boolean true or the string "true" (any case, no padding). */
export function conditionTrue(value: unknown): boolean {
  if (value instanceof OperandError) {
    return true;
  }
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

export const truthy = conditionTrue;

/** The items an `rs_`/`rr_` block repeats over: a list, a single map, or nothing. */
export function repeatItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return isCollection(value) ? [value] : [];
}

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    return Object.is(value, -0) ? "0" : BigInt(value).toString();
  }
  return String(value);
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null || isCollection(value)) {
    return "";
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return String(value);
}
