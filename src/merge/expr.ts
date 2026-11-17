export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

export type Instruction =
  | { kind: "field"; expr: string; optionalParagraph: boolean }
  | { kind: "cs" | "cr"; cond: string }
  | { kind: "rs" | "rr"; expr: string }
  | { kind: "es" | "er" }
  | { kind: "else"; cond?: string }
  | { kind: "assign"; name: string; expr: string }
  | { kind: "comment" }
  | { kind: "unsupported"; text: string; reason: string };

export class Scope {
  readonly vars = new Map<string, unknown>();

  constructor(
    readonly root: unknown,
    readonly item: unknown = root,
    readonly parent?: Scope,
    readonly index = 0,
    readonly size = 0
  ) {}

  child(item: unknown, index: number, size: number): Scope {
    return new Scope(this.root, item, this, index, size);
  }

  setVar(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  lookup(path: string): unknown {
    let value: unknown = this.item;
    for (const key of path.split(".")) {
      if (value === null || typeof value !== "object") {
        return undefined;
      }
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
}

export function parseInstruction(text: string): Instruction {
  const t = text.trim();
  const block = /^(cs|cr|rs|rr)_\s*(.*)$/s.exec(t);
  if (block) {
    const kind = block[1] as "cs" | "cr" | "rs" | "rr";
    return kind === "cs" || kind === "cr" ? { kind, cond: block[2]! } : { kind, expr: block[2]! };
  }
  if (/^(es|er)_/.test(t)) {
    return { kind: t.startsWith("es") ? "es" : "er" };
  }
  if (t === "else") {
    return { kind: "else" };
  }
  if (t.startsWith("op:")) {
    return { kind: "field", expr: t.slice(3), optionalParagraph: true };
  }
  return { kind: "field", expr: t, optionalParagraph: false };
}

export function evaluate(expr: string, scope: Scope): unknown {
  return scope.lookup(expr.trim());
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null && value !== false && value !== "" && value !== "false";
}

export function formatValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
