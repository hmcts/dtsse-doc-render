const DIVISION_DIGITS = 64;

const POW10 = (n: number): bigint => 10n ** BigInt(n);
const digitCount = (n: bigint): number => (n < 0n ? -n : n).toString().length;

/** An arbitrary-precision decimal, the type Docmosis computes numbers with: unscaled * 10^-scale, scale >= 0. */
export class Decimal {
  private constructor(
    readonly unscaled: bigint,
    readonly scale: number
  ) {}

  static of(unscaled: bigint, scale: number): Decimal {
    let u = unscaled;
    let s = scale;
    while (s > 0 && u % 10n === 0n) {
      u /= 10n;
      s--;
    }
    if (s < 0) {
      u *= POW10(-s);
      s = 0;
    }
    return new Decimal(u, s);
  }

  /** Parses a plain decimal such as `-12.50`, or an exponent form such as `1e21` that String(number) can produce. */
  static parse(text: string): Decimal | undefined {
    const m = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(text);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
      return undefined;
    }
    const frac = m[3] ?? "";
    const unscaled = BigInt(`${m[2] || "0"}${frac}`) * (m[1] === "-" ? -1n : 1n);
    return Decimal.of(unscaled, frac.length - Number(m[4] ?? 0));
  }

  static fromNumber(n: number): Decimal | undefined {
    return Number.isFinite(n) ? Decimal.parse(String(n)) : undefined;
  }

  add(o: Decimal): Decimal {
    const s = Math.max(this.scale, o.scale);
    return Decimal.of(this.unscaled * POW10(s - this.scale) + o.unscaled * POW10(s - o.scale), s);
  }

  sub(o: Decimal): Decimal {
    return this.add(o.negate());
  }

  mul(o: Decimal): Decimal {
    return Decimal.of(this.unscaled * o.unscaled, this.scale + o.scale);
  }

  /** Division to 64 significant digits, rounded half up. Dividing by zero is the caller's concern. */
  div(o: Decimal): Decimal {
    const shift = Math.max(0, DIVISION_DIGITS + 6 + digitCount(o.unscaled) - digitCount(this.unscaled));
    let q = (this.unscaled * POW10(shift)) / o.unscaled;
    let scale = this.scale - o.scale + shift;
    const excess = digitCount(q) - DIVISION_DIGITS;
    if (excess > 0) {
      const unit = POW10(excess);
      const half = unit / 2n;
      const sign = q < 0n ? -1n : 1n;
      q = sign * ((sign * q + half) / unit);
      scale -= excess;
    }
    return Decimal.of(q, scale);
  }

  /** The remainder takes the sign of the dividend, as BigDecimal.remainder does. */
  rem(o: Decimal): Decimal {
    const s = Math.max(this.scale, o.scale);
    return Decimal.of((this.unscaled * POW10(s - this.scale)) % (o.unscaled * POW10(s - o.scale)), s);
  }

  negate(): Decimal {
    return new Decimal(-this.unscaled, this.scale);
  }

  abs(): Decimal {
    return this.unscaled < 0n ? this.negate() : this;
  }

  compare(o: Decimal): number {
    const s = Math.max(this.scale, o.scale);
    const a = this.unscaled * POW10(s - this.scale);
    const b = o.unscaled * POW10(s - o.scale);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  toNumber(): number {
    return Number(this.toString());
  }

  /** Plain notation with at least one fractional digit: 2.0, 0.25, -3.0. */
  toString(): string {
    const negative = this.unscaled < 0n;
    const digits = (negative ? -this.unscaled : this.unscaled).toString().padStart(this.scale + 1, "0");
    const int = digits.slice(0, digits.length - this.scale);
    const frac = this.scale === 0 ? "0" : digits.slice(digits.length - this.scale);
    return `${negative ? "-" : ""}${int}.${frac}`;
  }
}
