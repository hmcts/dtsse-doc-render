import { ExpressionError } from "./errors.ts";
import { callFunction, hasFunction, isEmpty, sizeOf } from "./functions.ts";
import { type Token, tokenize } from "./lexer.ts";
import { formatValue, isNumeric, toNumber, truthy } from "./values.ts";

export { ExpressionError, formatValue, truthy };

export type Instruction =
  | { kind: "field"; expr: string; optionalParagraph: boolean }
  | { kind: "cs" | "cr"; cond: string }
  | { kind: "rs" | "rr"; expr: string }
  | { kind: "es" | "er" }
  | { kind: "else"; cond?: string }
  | { kind: "assign"; name: string; expr: string }
  | { kind: "comment" }
  | { kind: "unsupported"; text: string; reason: string };

type Segment = string | number;

const segmentCache = new Map<string, Segment[]>();

function segments(path: string): Segment[] {
  let cached = segmentCache.get(path);
  if (!cached) {
    cached = [];
    for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
      cached.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
    }
    segmentCache.set(path, cached);
  }
  return cached;
}

function descend(value: unknown, rest: Segment[]): unknown {
  let current = value;
  for (const seg of rest) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[seg];
  }
  return current;
}

export class Scope {
  readonly vars = new Map<string, unknown>();

  constructor(
    readonly root: unknown,
    readonly item: unknown = root,
    readonly parent?: Scope,
    readonly index = 0,
    readonly size = 0,
    readonly now: Date = parent?.now ?? new Date()
  ) {}

  /** A root scope carrying a fixed `$nowUTC`. */
  static withNow(data: unknown, now: Date): Scope {
    return new Scope(data, data, undefined, 0, 0, now);
  }

  child(item: unknown, index: number, size: number): Scope {
    return new Scope(this.root, item, this, index, size, this.now);
  }

  private get top(): Scope {
    let s: Scope = this;
    while (s.parent) {
      s = s.parent;
    }
    return s;
  }

  /** Variables are document-global, so they live on the root scope. */
  setVar(name: string, value: unknown): void {
    this.top.vars.set(name.startsWith("$") ? name.slice(1) : name, value);
  }

  lookup(path: string): unknown {
    const segs = segments(path);
    const first = segs[0];
    if (typeof first === "number" || first === undefined) {
      return undefined;
    }
    const rest = segs.slice(1);
    if (first.startsWith("$")) {
      return this.builtin(first.slice(1), rest);
    }
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const found = descend(s.item, segs);
      if (found !== undefined) {
        return found;
      }
    }
    return descend(this.root, segs);
  }

  private builtin(name: string, rest: Segment[]): unknown {
    switch (name) {
      case "this":
        return descend(this.item, rest);
      case "root":
        return descend(this.root, rest);
      case "parent":
        return descend(this.parent?.item, rest);
      case "itemnum":
        return this.index;
      case "size":
        return this.size;
      case "nl":
        return "\n";
      case "nowUTC":
        return rest.length === 0 ? this.now : undefined;
      default:
        return descend(this.top.vars.get(name), rest);
    }
  }
}

const UNSUPPORTED_PREFIX = /^(link|ref|html|refLookup|image|img|md|bookmark):/;
const ASSIGN = /^\$([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/;

function stripBraces(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    return t.slice(1, -1);
  }
  return t;
}

function literalExpression(literal: string): string {
  if (/^(null|true|false|\d+(\.\d+)?)$/.test(literal) || /^[‘’“”'"].*[‘’“”'"]$/s.test(literal)) {
    return literal;
  }
  const quote = ["'", '"', "‘", "“"].find((q) => !literal.includes(q)) ?? "'";
  return `${quote}${literal}${quote === "‘" ? "’" : quote === "“" ? "”" : quote}`;
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
  const otherwise = /^else(?:_\s*|\s*(?=\{)|$)(.*)$/s.exec(t);
  if (otherwise) {
    const cond = otherwise[1]!.trim();
    return cond === "" ? { kind: "else" } : { kind: "else", cond };
  }
  if (t.startsWith("/*")) {
    return { kind: "comment" };
  }
  const assign = ASSIGN.exec(t);
  if (assign) {
    const value = assign[2]!.trim();
    const braced = value.startsWith("{") && value.endsWith("}");
    return { kind: "assign", name: assign[1]!, expr: braced ? value.slice(1, -1) : literalExpression(value) };
  }
  const prefix = UNSUPPORTED_PREFIX.exec(t);
  if (prefix) {
    return { kind: "unsupported", text: t, reason: `${prefix[1]}: is not supported` };
  }
  if (!t.startsWith("{") && /\{\s*renderer\s*=/.test(t)) {
    return { kind: "unsupported", text: t, reason: "field renderers are not supported" };
  }
  if (t.startsWith("op:")) {
    return { kind: "field", expr: t.slice(3).trim(), optionalParagraph: true };
  }
  return { kind: "field", expr: stripBraces(t), optionalParagraph: false };
}

type Node = (scope: Scope) => unknown;

function looseEquals(a: unknown, b: unknown): boolean {
  const aNil = a === undefined || a === null;
  const bNil = b === undefined || b === null;
  if (aNil || bNil) {
    return aNil && bNil;
  }
  if (isNumeric(a) && isNumeric(b)) {
    return toNumber(a) === toNumber(b);
  }
  return formatValue(a) === formatValue(b);
}

function plus(a: unknown, b: unknown): unknown {
  return isNumeric(a) && isNumeric(b) ? toNumber(a) + toNumber(b) : formatValue(a) + formatValue(b);
}

function minus(a: unknown, b: unknown): number {
  return toNumber(a) - toNumber(b);
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b
};

const METHODS: Record<string, (v: unknown) => unknown> = { size: sizeOf, isEmpty };

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string
  ) {}

  parse(): Node {
    const node = this.or();
    if (this.pos < this.tokens.length) {
      this.fail(`Unexpected ${this.describe(this.tokens[this.pos]!)}`);
    }
    return node;
  }

  private fail(message: string): never {
    throw new ExpressionError(`${message} in expression: ${this.src}`);
  }

  private describe(token: Token): string {
    return `'${token.v}'`;
  }

  private peekOp(...ops: string[]): string | undefined {
    const token = this.tokens[this.pos];
    return token?.t === "op" && ops.includes(token.v) ? token.v : undefined;
  }

  private eat(op: string): void {
    if (!this.peekOp(op)) {
      const token = this.tokens[this.pos];
      this.fail(token ? `Expected '${op}' but found ${this.describe(token)}` : `Expected '${op}' but the expression ended`);
    }
    this.pos++;
  }

  private binary(next: () => Node, ops: string[], apply: (op: string, a: Node, b: Node) => Node): Node {
    let left = next();
    for (let op = this.peekOp(...ops); op; op = this.peekOp(...ops)) {
      this.pos++;
      left = apply(op, left, next());
    }
    return left;
  }

  private or(): Node {
    return this.binary(
      () => this.and(),
      ["||"],
      (_, a, b) => (s) => truthy(a(s)) || truthy(b(s))
    );
  }

  private and(): Node {
    return this.binary(
      () => this.equality(),
      ["&&"],
      (_, a, b) => (s) => truthy(a(s)) && truthy(b(s))
    );
  }

  private equality(): Node {
    return this.binary(
      () => this.relational(),
      ["=", "==", "!="],
      (op, a, b) => (s) => looseEquals(a(s), b(s)) === (op !== "!=")
    );
  }

  private relational(): Node {
    return this.binary(
      () => this.additive(),
      ["<", ">", "<=", ">="],
      (op, a, b) => (s) => COMPARE[op]!(toNumber(a(s)), toNumber(b(s)))
    );
  }

  private additive(): Node {
    return this.binary(
      () => this.unary(),
      ["+", "-"],
      (op, a, b) => (s) => (op === "+" ? plus(a(s), b(s)) : minus(a(s), b(s)))
    );
  }

  private unary(): Node {
    if (this.peekOp("!")) {
      this.pos++;
      const operand = this.unary();
      return (s) => !truthy(operand(s));
    }
    if (this.peekOp("-")) {
      this.pos++;
      const operand = this.unary();
      return (s) => -toNumber(operand(s));
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.tokens[this.pos++];
    if (!token) {
      return this.fail("Unexpected end");
    }
    if (token.t === "num" || token.t === "str") {
      const value = token.v;
      return () => value;
    }
    if (token.t === "op") {
      if (token.v !== "(") {
        this.pos--;
        return this.fail(`Unexpected ${this.describe(token)}`);
      }
      const inner = this.or();
      this.eat(")");
      return inner;
    }
    return this.pathOrCall(token.v);
  }

  private pathOrCall(path: string): Node {
    if (!this.peekOp("(")) {
      return this.pathNode(path);
    }
    this.pos++;
    const dot = path.lastIndexOf(".");
    const method = dot === -1 ? undefined : path.slice(dot + 1);
    if (method !== undefined && Object.hasOwn(METHODS, method)) {
      this.eat(")");
      const target = path.slice(0, dot);
      return (s) => METHODS[method]!(s.lookup(target));
    }
    if (dot !== -1 || path.startsWith("$") || !hasFunction(path)) {
      return this.fail(`Unknown function ${path}()`);
    }
    const args: Node[] = [];
    if (!this.peekOp(")")) {
      do {
        args.push(this.or());
      } while (this.peekOp(",") && ++this.pos);
    }
    this.eat(")");
    return (s) =>
      callFunction(
        path,
        args.map((a) => a(s))
      );
  }

  private pathNode(path: string): Node {
    switch (path) {
      case "null":
        return () => null;
      case "true":
        return () => true;
      case "false":
        return () => false;
      default:
    }
    const dot = path.lastIndexOf(".");
    const method = dot === -1 ? undefined : path.slice(dot + 1);
    if (method !== undefined && Object.hasOwn(METHODS, method)) {
      const target = path.slice(0, dot);
      return (s) => {
        const value = s.lookup(target);
        if (Array.isArray(value) || typeof value === "string") {
          return METHODS[method]!(value);
        }
        return s.lookup(path);
      };
    }
    return (s) => s.lookup(path);
  }
}

const compiled = new Map<string, Node>();

export function evaluate(expr: string, scope: Scope): unknown {
  const src = stripBraces(expr);
  let node = compiled.get(src);
  if (!node) {
    const tokens = tokenize(src);
    if (tokens.length === 0) {
      return undefined;
    }
    node = new Parser(tokens, src).parse();
    compiled.set(src, node);
  }
  return node(scope);
}
