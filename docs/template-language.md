# The Docmosis template language this service supports

The scope comes from a survey of every template in hmcts/docmosis on 2026-11-17: 2,972 readable `.docx` files holding 221,927 instructions. The v1 list below covers about 99.9% of those instructions. Anything outside it fails with `unsupported instruction <<…>>`, and in `devMode` that message is written into the document in place of the instruction.

## v1

**Blocks**
- `cs_`, `cr_`, `rs_` and `rr_`, closed by `es_` or `er_`. An end tag can be bare (`es_`), named (`es_timeline`) or bracketed (`er_[rows]`). Names are not checked against the opening tag.
- `else`, and `else_<cond>` as an else-if.
- A space after the prefix is tolerated: `cs_ {…}`, `rs_ list`.
- Blocks nest up to at least 11 levels.

**Conditions**
- `cs_`, `cr_` and `else_` take either `{expression}` or a bare name. A bare name is tested for truthiness.
- These are false: `false`, `null`, missing, `""`, `"false"`, and an empty list.

**Repeats**
- `rs_` and `rr_` take a dotted path, `$this.x` or `$parent.x`.
- Inside a repeat, `$this` is the current item, which may be a scalar.
- `$itemnum` is the 1-based position and `$size` is the list length.
- A name is looked up on the item first, then in the enclosing scopes.

**Fields**
- Dotted paths of any depth, and literal `[n]` indexes.
- `op:field` removes the paragraph when the value is empty.
- `{expression}` fields.
- `/* … */` comments are removed.

**Variables**
- `$var={expr}` assigns the result of an expression, and `$var=value` assigns a literal.
- Built-ins:
  - `$this`, `$root` and `$parent`
  - `$nowUTC`, the current time
  - `$itemnum` and `$size`
  - `$nl`, a line break

**Operators**
- `=` and `==` (both mean equality), `!=`, `<`, `>`, `&&`, `||`, unary `!`, `+` (numbers, or string concatenation), binary `-`, and parentheses.
- Literals: `null`, `true`, `false`, numbers, and strings.
- String literals accept any of `‘ ’ “ ” ' "` as delimiters, mixed freely, because Word converts straight quotes to curly ones.

**Functions** (they nest, and whitespace is allowed before the parenthesis)
- `isBlank`, `ifBlank`, `round`, `toLowerCase`, `toUpperCase`, `titleCase`, `equalsIgnoreCase`.
- `.size()`, `.size` without parentheses, and `.isEmpty()`.
- `numFormat(x, '0' | '#' | '####')`.
- `dateFormat(value, out)`, used only with `$nowUTC`, and `dateFormat(value, out, in)`.
  - Patterns follow Java's `SimpleDateFormat`: `y`, `Y`, `M` (up to 5), `d`, `D`, `E`, `H`, `h`, `m`, `s`, `S`, `a`, and quoted literals including `'T'`.
  - `mm` is minutes, as in Java, so a template's `dd/mm/yyyy` prints minutes in the month position, just as Docmosis does.

## Not yet supported

The long tail, in order of use:

| Feature | Uses | Templates |
|---|---|---|
| `link:` | 98 | 88 |
| `ref:` (include another template) | 94 | 50 |
| `html:` | 70 | 23 |
| the `field{renderer=date(…)}` suffix | 51 | 32 |
| `toSentence` | 39 | 13 |
| `trim` | 19 | 10 |
| `startsWith` / `endsWith` | 24 | 10 |
| `length` | 16 | 4 |
| `substring` | 16 | 4 |
| `split` | 14 | 5 |
| `replaceStr` | 12 | 8 |
| `map` / `mapi` (Welsh month and value translation) | 28 | 17 |
| `squote` | 10 | 9 |
| `dateFormat` with a variable format or a locale argument | 19 | — |
| `refLookup:` | 6 | 6 |
| `localeinfo` | 1 | 1 |

The corpus also has 185 `.doc` and 3 `.odt` templates, which this service does not merge.
