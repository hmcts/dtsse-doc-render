import { ExpressionError } from "./errors.ts";

export type Token = { t: "num"; v: string } | { t: "str"; v: string } | { t: "path"; v: string } | { t: "op"; v: string; at: number };

const QUOTES = "‘’'";
const NOT_DELIMITERS = '"“”';
const OPERATORS = ["==", "!=", "<=", ">=", "&&", "||", "=", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", ","];
const AFTER_STRING = ",)}&|=!<>+*/%";
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

/**
 * A string closes at a quote that is followed by the end of the expression or by an operator, a comma or a bracket.
 * That lets format patterns carry their own quotes: dateFormat(x, 'dd MMMM yyyy 'at' hh:mm')
 */
function findClose(src: string, from: number): number {
  let firstQuote = -1;
  for (let j = from; j < src.length; j++) {
    if (!QUOTES.includes(src[j]!)) {
      continue;
    }
    if (firstQuote === -1) {
      firstQuote = j;
    }
    let k = j + 1;
    while (k < src.length && /\s/.test(src[k]!)) {
      k++;
    }
    if (k >= src.length || AFTER_STRING.includes(src[k]!)) {
      return j;
    }
  }
  return firstQuote;
}

function rejectedQuote(src: string, at: number): ExpressionError {
  if (src[at] === '"') {
    return new ExpressionError("Expression is invalid.");
  }
  const term = /^[^\s,()=<>!&|+]+/.exec(src.slice(at))![0];
  return new ExpressionError(`Field term "${term}" must start with an Alphabetic letter or $`);
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (NOT_DELIMITERS.includes(c)) {
      throw rejectedQuote(src, i);
    } else if (QUOTES.includes(c)) {
      const close = findClose(src, i + 1);
      if (close === -1) {
        throw new ExpressionError(`Unterminated string in expression: ${src}`);
      }
      tokens.push({ t: "str", v: src.slice(i + 1, close) });
      i = close + 1;
    } else if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      for (;;) {
        while (j < src.length && IDENT_PART.test(src[j]!)) {
          j++;
        }
        const index = /^\[\d+\]/.exec(src.slice(j));
        if (index) {
          j += index[0].length;
        } else if (src[j] === "." && j + 1 < src.length && IDENT_START.test(src[j + 1]!)) {
          j++;
        } else {
          break;
        }
      }
      tokens.push({ t: "path", v: src.slice(i, j) });
      i = j;
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) {
        throw new ExpressionError(`Unexpected character '${c}' in expression: ${src}`);
      }
      tokens.push({ t: "op", v: op, at: i });
      i += op.length;
    }
  }
  return tokens;
}
