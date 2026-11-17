const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/;

export function isNumeric(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && NUMERIC.test(value);
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (isNumeric(value)) {
    return Number(value);
  }
  return Number.NaN;
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null && value !== false && value !== "" && value !== "false";
}

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    return Object.is(value, -0) ? "0" : BigInt(value).toString();
  }
  return String(value);
}

/** Java toString semantics: lists print as [a, b], maps as {k=v}. */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatNested).join(", ")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}=${formatNested(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

function formatNested(value: unknown): string {
  return value === undefined || value === null ? "null" : formatValue(value);
}
