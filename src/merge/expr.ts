import { ExpressionError } from "./errors.ts";
import { callFunction, isEmpty, sizeOf } from "./functions.ts";
import { type Token, tokenize } from "./lexer.ts";
import { parseQualified, type Renderer } from "./renderer.ts";
import { conditionTrue, Decimal, formatValue, isNumeric, OperandError, repeatItems, scalar, toDecimal, toNumber, truthy } from "./values.ts";

export { conditionTrue, ExpressionError, formatValue, repeatItems, truthy };

export type Instruction =
  | { kind: "field"; expr: string; optionalParagraph: boolean; html?: boolean; renderer?: Renderer; qualifierError?: string }
  | { kind: "ref"; name: string }
  | { kind: "refLookup"; path: string }
  | { kind: "cs" | "cr"; cond: string }
  | { kind: "rs" | "rr"; expr: string }
  | { kind: "es" | "er" }
  | { kind: "else"; cond?: string }
  | { kind: "assign"; name: string; expr: string }
  | { kind: "comment" }
  | { kind: "unsupported"; text: string; reason: string };

type Segment = string | number;

/** Parsed paths and compiled expressions, keyed by caller-supplied text, so they live and die with one render. */
class Caches {
  readonly segments = new Map<string, Segment[]>();
  readonly compiled = new Map<string, Node>();
}

function segments(caches: Caches, path: string): Segment[] {
  let cached = caches.segments.get(path);
  if (!cached) {
    cached = [];
    for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
      cached.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
    }
    caches.segments.set(path, cached);
  }
  return cached;
}

/** Follows own properties only, so `constructor`, `__proto__` and the like are not reachable from data. */
function descend(value: unknown, rest: Segment[]): unknown {
  let current = value;
  for (const seg of rest) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, seg)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[seg];
  }
  return current;
}

const READ_ONLY = new Set(["num", "itemnum", "this", "size", "root", "parent"]);

export class Scope {
  readonly vars = new Map<string, unknown>();
  readonly caches: Caches;

  constructor(
    readonly root: unknown,
    readonly item: unknown = root,
    readonly parent?: Scope,
    readonly index = 0,
    readonly size = 0,
    readonly now: Date = parent?.now ?? new Date()
  ) {
    this.caches = parent?.caches ?? new Caches();
  }

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
    const bare = name.startsWith("$") ? name.slice(1) : name;
    if (READ_ONLY.has(bare)) {
      throw new ExpressionError(`Cannot set built in variable $${bare}`);
    }
    this.top.vars.set(bare, value);
  }

  lookup(path: string): unknown {
    const segs = segments(this.caches, path);
    const first = segs[0];
    if (typeof first === "number" || first === undefined) {
      return undefined;
    }
    const rest = segs.slice(1);
    if (first.startsWith("$")) {
      return this.builtin(first.slice(1), rest);
    }
    return descend(this.item, segs);
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
        if (!this.top.vars.has(name)) {
          throw new ExpressionError(`Variable not found "$${name}"`);
        }
        return descend(this.top.vars.get(name), rest);
    }
  }
}

const UNSUPPORTED_PREFIX = /^(image|img|md|bookmark):/;
const BARE_CALL = /^[A-Za-z_]\w*\(/;
const ASSIGN = /^\$([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/;

function stripBraces(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseInstruction(text: string): Instruction {
  const t = text.trim();
  const block = /^(cs|cr|rs|rr)_\s*(.*)$/s.exec(t);
  if (block) {
    const kind = block[1] as "cs" | "cr" | "rs" | "rr";
    if (kind === "cs" || kind === "cr") {
      return { kind, cond: block[2]! };
    }
    const expr = block[2]!.trim();
    if (expr.startsWith("{")) {
      throw new ExpressionError(`Field term "${expr.split(/\s/)[0]}" must start with an Alphabetic letter or $`);
    }
    return { kind, expr: block[2]! };
  }
  if (/^(es|er)_/.test(t)) {
    return { kind: t.startsWith("es") ? "es" : "er" };
  }
  const otherwise = /^else(?:_\s*([\s\S]*))?/.exec(t);
  if (otherwise) {
    const cond = (otherwise[1] ?? "").trim();
    return cond === "" ? { kind: "else" } : { kind: "else", cond };
  }
  if (t.startsWith("/*")) {
    return { kind: "comment" };
  }
  const assign = ASSIGN.exec(t);
  if (assign) {
    const value = assign[2]!.trim();
    const plainNumber = /^-?\d+(\.\d+)?$/.test(value);
    return { kind: "assign", name: assign[1]!, expr: plainNumber ? `numberLiteral('${value}')` : stripBraces(value) };
  }
  const rendered = /^(link|html):\s*([\s\S]*)$/.exec(t);
  if (rendered) {
    const expr = stripBraces(rendered[2]!);
    return rendered[1] === "html" ? { kind: "field", expr, optionalParagraph: false, html: true } : { kind: "field", expr, optionalParagraph: false };
  }
  const include = /^(refLookup|ref):([\s\S]*)$/.exec(t);
  if (include) {
    const argument = include[2]!;
    if (argument.trim() === "") {
      throw new ExpressionError(`Field "${t}" is not complete.  Suggestion 1:Make sure your field does not contain spaces `);
    }
    if (/^\s/.test(argument)) {
      throw new ExpressionError(
        `Field "${t}" contains leading or trailing whitespace.  Suggestion 1:Remove the leading and trailing spaces from the field reference `
      );
    }
    return include[1] === "ref" ? { kind: "ref", name: argument.trim() } : { kind: "refLookup", path: argument.trim() };
  }
  const prefix = UNSUPPORTED_PREFIX.exec(t);
  if (prefix) {
    return { kind: "unsupported", text: t, reason: `${prefix[1]}: is not supported` };
  }
  const optional = t.startsWith("op:");
  const fieldText = optional ? t.slice(3).trim() : t;
  const qualified = fieldText.startsWith("{") ? null : parseQualified(fieldText);
  if (qualified) {
    return { kind: "field", expr: qualified.name, optionalParagraph: optional, renderer: qualified.renderer, qualifierError: qualified.error };
  }
  if (optional) {
    return { kind: "field", expr: fieldText, optionalParagraph: true };
  }
  if (!t.startsWith("{") && BARE_CALL.test(t)) {
    const nested = /^([A-Za-z_]\w*\([^\s.,)]*)\./.exec(t);
    if (nested) {
      throw new ExpressionError(`Field term "${nested[1]}" is missing closing bracket: ')'.`);
    }
    return { kind: "field", expr: "null", optionalParagraph: false };
  }
  return { kind: "field", expr: stripBraces(t), optionalParagraph: false };
}

type Node = (scope: Scope) => unknown;

function looseEquals(left: unknown, right: unknown): boolean {
  const a = scalar(left);
  const b = scalar(right);
  const aNil = a === undefined || a === null;
  const bNil = b === undefined || b === null;
  if (aNil || bNil) {
    return aNil && bNil;
  }
  if (isNumeric(a) && isNumeric(b)) {
    return toDecimal(a)!.compare(toDecimal(b)!) === 0;
  }
  return formatValue(a) === formatValue(b);
}

const concatText = (v: unknown): string => (v === undefined || v === null ? "null" : formatValue(v));

function plus(left: unknown, right: unknown): unknown {
  const a = scalar(left);
  const b = scalar(right);
  return isNumeric(a) && isNumeric(b) ? toDecimal(a)!.add(toDecimal(b)!) : concatText(a) + concatText(b);
}

function operand(value: unknown): Decimal {
  const d = toDecimal(checked(value));
  if (!d) {
    throw new ExpressionError("Invalid operation for a string.");
  }
  return d;
}

/** Non-zero division and remainder are exact decimals; a zero divisor falls back to doubles like Java's. */
function arithmetic(op: string, left: unknown, right: unknown): Decimal | number {
  const a = operand(left);
  const b = operand(right);
  switch (op) {
    case "-":
      return a.sub(b);
    case "*":
      return a.mul(b);
    case "/":
      return b.isZero() ? a.toNumber() / 0 : a.div(b);
    default:
      return b.isZero() ? Number.NaN : a.rem(b);
  }
}

const isDecimal = (value: unknown, n: number): boolean => value instanceof Decimal && value.compare(Decimal.of(BigInt(n), 0)) === 0;

function checked(value: unknown): unknown {
  if (value instanceof OperandError) {
    throw new ExpressionError("Invalid operand for unary operator");
  }
  return value;
}

function negate(value: unknown, literal: boolean): boolean | OperandError {
  const v = scalar(checked(value));
  if (v === undefined || v === null) {
    return true;
  }
  if (typeof v === "boolean") {
    return !v;
  }
  if (typeof v === "string" && /^(true|false)$/i.test(v)) {
    return v.toLowerCase() === "false";
  }
  if (literal && (isDecimal(v, 0) || isDecimal(v, 1))) {
    return isDecimal(v, 0);
  }
  return new OperandError();
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
  private readonly literals = new WeakSet<Node>();

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

  private condition(node: Node): (scope: Scope) => boolean {
    if (this.literals.has(node)) {
      return (s) => isDecimal(node(s), 1);
    }
    return (s) => {
      const value = scalar(node(s));
      if (value instanceof OperandError) {
        checked(value);
      }
      return conditionTrue(value);
    };
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

  private closeCall(): void {
    if (!this.peekOp(")")) {
      this.fail("Function is not closed");
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
      (_, a, b) => {
        const left = this.condition(a);
        const right = this.condition(b);
        return (s) => left(s) || right(s);
      }
    );
  }

  private and(): Node {
    return this.binary(
      () => this.equality(),
      ["&&"],
      (_, a, b) => {
        const left = this.condition(a);
        const right = this.condition(b);
        return (s) => left(s) && right(s);
      }
    );
  }

  private equality(): Node {
    return this.binary(
      () => this.relational(),
      ["=", "==", "!="],
      (op, a, b) => (s) => looseEquals(checked(a(s)), checked(b(s))) === (op !== "!=")
    );
  }

  private relational(): Node {
    return this.binary(
      () => this.additive(),
      ["<", ">", "<=", ">="],
      (op, a, b) => (s) => COMPARE[op]!(toNumber(scalar(checked(a(s)))), toNumber(scalar(checked(b(s)))))
    );
  }

  private additive(): Node {
    return this.binary(
      () => this.multiplicative(),
      ["+", "-"],
      (op, a, b) => (s) => (op === "+" ? plus(checked(a(s)), checked(b(s))) : arithmetic(op, a(s), b(s)))
    );
  }

  private multiplicative(): Node {
    return this.binary(
      () => this.unary(),
      ["*", "/", "%"],
      (op, a, b) => (s) => arithmetic(op, a(s), b(s))
    );
  }

  private unary(): Node {
    const op = this.peekOp("!", "-");
    if (!op) {
      return this.primary();
    }
    this.pos++;
    const next = this.tokens[this.pos];
    if (next?.t === "op" && (next.v === "!" || next.v === "-")) {
      throw new ExpressionError(`Consecutive unary operators are not allowed (index=${next.at + 1})`);
    }
    const target = this.unary();
    if (op === "!") {
      const literal = this.literals.has(target);
      return (s) => negate(target(s), literal);
    }
    return (s) => {
      const value = checked(target(s));
      if (!(value instanceof Decimal)) {
        throw new ExpressionError("Invalid operation for a string.");
      }
      return value.negate();
    };
  }

  private primary(): Node {
    const token = this.tokens[this.pos++];
    if (!token) {
      return this.fail("Unexpected end");
    }
    if (token.t === "num" || token.t === "str") {
      const value = token.t === "num" ? Decimal.parse(token.v)! : token.v;
      const node: Node = () => value;
      if (token.t === "num") {
        this.literals.add(node);
      }
      return node;
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
      this.closeCall();
      const target = path.slice(0, dot);
      return (s) => METHODS[method]!(s.lookup(target));
    }
    if (dot !== -1 || path.startsWith("$")) {
      return this.fail(`Unknown function ${path}()`);
    }
    const args: Node[] = [];
    if (!this.peekOp(")")) {
      do {
        args.push(this.or());
      } while (this.peekOp(",") && ++this.pos);
    }
    this.closeCall();
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
    if (method !== undefined && (method === "length" || Object.hasOwn(METHODS, method))) {
      const target = path.slice(0, dot);
      return (s) => {
        const value = s.lookup(target);
        if (Array.isArray(value) || typeof value === "string") {
          return (METHODS[method] ?? sizeOf)(value);
        }
        return s.lookup(path);
      };
    }
    return (s) => s.lookup(path);
  }
}

export function evaluate(expr: string, scope: Scope): unknown {
  const src = stripBraces(expr);
  const compiled = scope.caches.compiled;
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
