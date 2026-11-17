# The Docmosis template language this service supports

The scope comes from a survey of every template in hmcts/docmosis on 2026-11-17: 2,972 readable `.docx` files holding 221,927 instructions. The supported list below covers about 99.9% of those instructions. Anything outside it fails with `unsupported instruction <<…>>`.

The behaviour described here was verified against a licensed Docmosis Tornado on 2026-11-17, and the fixtures in `test/fixtures/src/` hold Docmosis's own output (see "Checking parity with Docmosis" in the README).

## Supported

**Blocks**
- `cs_`, `cr_`, `rs_` and `rr_`, closed by `es_` or `er_`. An end tag can be bare (`es_`), named (`es_timeline`) or bracketed (`er_[rows]`).
- A named end tag must match its start tag: `<<cs_claim.type>>…<<es_claim>>` is an error (`Mismatched sections`). Use `es_` or the exact name.
- A block that is never closed, and an end tag with no start, are errors.
- `else`, and `else_<cond>` as an else-if.
- A space after the prefix is tolerated: `cs_ {…}`, `rs_ list`.
- Blocks nest up to at least 11 levels.
- `rr_`/`cr_` and `er_` cannot share a table row, and `rr_`/`cr_`/`er_` outside a table are errors. Put the start tag in one row and the end tag in a later row; both marker rows are removed from the output and the rows between are repeated or kept.

**Conditions**
- `cs_`, `cr_` and `else_` take either `{expression}` or a bare name.
- A bare name, or an expression that is just a name, is true only for boolean `true` or the string `"true"`. Everything else is false: `"yes"`, `1`, `0`, `"false"`, `""`, `null`, a missing value, a map and a list. Compare explicitly (`{n = 1}`, `{s != ''}`) to test other values.

**Repeats**
- `rs_` and `rr_` take a dotted path, `$this.x`, `$parent.x` or `$root.x`.
- Inside a repeat, `$this` is the current item, which may be a scalar.
- `$itemnum` is the 1-based position and `$size` is the list length.
- A bare name inside a repeat is read from the current item only. It does not fall back to the enclosing item or the root: use `$parent.x` (the enclosing scope) or `$root.x`. Inside a repeat over scalars, a bare name is empty.

**Fields**
- Dotted paths of any depth, and literal `[n]` indexes.
- A map or a list used as a value prints nothing and is treated as null: `isBlank` is true, `ifBlank` takes the fallback, and `op:` removes the paragraph. Print its fields (`address.town`) instead.
- `op:field` removes the paragraph when the value is empty.
- `{expression}` fields.
- `link:field` and `link:{expression}` write the value as a hyperlink whose text is the URL, and write nothing for a missing value. `html:field` writes the value as formatted HTML (`<b>bold</b>` is bold text).
- `/* … */` comments are removed, and **a paragraph that contains a comment is removed entirely**, text around the comment included.
- `pageBreak` is a built-in field that writes a page break.
- Whitespace: a zero-output tag (an empty field, a false `cs_` block, a variable assignment) between two single spaces collapses them to one, so `a <<cs_f>>x<<es_>> b` is `a b`. A run of two or more spaces next to the tag is left alone.

**Variables**
- `$var={expr}` assigns the result of an expression. Only numbers (`$n=0`) and `{'quoted'}` strings are literals.
- `$var=word` is a **field reference**: it assigns the value of the data field `word`, which is empty if there is none.
- Built-in names cannot be assigned: `$num` is one.
- Built-ins:
  - `$this`, `$root` and `$parent`
  - `$nowUTC`, the current time
  - `$itemnum` and `$size`
  - `$nl`, which ends the paragraph. The text after it starts a new paragraph, and a table cell gets one paragraph per part. It is not a soft line break.

**Operators**
- `=` and `==` (both mean equality), `!=`, `<`, `>`, `&&`, `||`, unary `!`, `+` (numbers, or string concatenation), binary `-`, and parentheses.
- Literals: `null`, `true`, `false`, numbers, and strings.
- Strings are delimited by `'…'` or `‘…’`, the curly pair Word produces from a straight single quote, and the two kinds can be mixed. **Double quotes (`"` and `“ ”`) do not delimit strings**: `{status = "A"}` is an error.

**Functions** (they nest, and whitespace is allowed before the parenthesis)
- A call needs braces: `<<{toUpperCase(x)}>>`. Without braces the text is read as a field name, so `<<toUpperCase(x)>>` prints nothing (and a decimal point in it, as in `round(1.5)`, is an error).
- `isBlank`, `ifBlank`, `round`, `toLowerCase`, `toUpperCase`, `titleCase`, `equalsIgnoreCase`.
- `trim(s)`, `substring(s, from, to)` (zero-based, three arguments) and `length(s)`. `length` returns a decimal, so it prints as `8.0`; wrap it in `numFormat(…, '0')` for `8`.
- `.size()`, `.size` without parentheses, and `.isEmpty()`.
- `numFormat(x, '0' | '#' | '####')`.
- `dateFormat(value, out)`, used only with `$nowUTC`, and `dateFormat(value, out, in)`.
  - Patterns follow Java's `SimpleDateFormat`: `y`, `Y`, `M` (up to 5), `d`, `D`, `E`, `H`, `h`, `m`, `s`, `S`, `a`, and quoted literals.
  - A pattern written with curly quotes can contain a quoted literal with curly or straight quotes: `‘yyyy-MM-dd’T’HH:mm:ss’` and `‘d MMM yyyy ’at’ HH:mm’` both work.
  - `mm` is minutes, as in Java, so a template's `dd/mm/yyyy` prints minutes in the month position, just as Docmosis does.
- An unknown function name evaluates to an empty string.

## Errors

With `devMode` off, a template Docmosis rejects answers 400 with `{"succeeded":false,"shortMsg":"Task failed:Field <<…>> …"}`. The messages these fixtures pin, and so the phrases a rejection from this service must contain:

| Fault | Phrase |
|---|---|
| End tag names a different block | `Mismatched sections` |
| Block never closed | `Section not ended` |
| End tag with no start | `Unmatched ending tag` |
| `"…"` string | `Expression is invalid` |
| `“…”` string | `must start with an Alphabetic letter` |
| Malformed expression | `Unable to evaluate field expression` |
| Unclosed function | `Function is not closed` |
| `rs_`/`rr_` end tag outside a table | `not inside a table` |
| Two row tags in one row | `same table row` |

With `devMode` on the render succeeds and each error is written into the document as the instruction followed by `Docmosis<N>`, with `N` counting the errors: `<<{status +}>>Docmosis1`. A structural error (a block fault) writes `<<analysis>>Docmosis<N>` and then the paragraph's own text.

## Not yet supported

The long tail, in order of use:

| Feature | Uses | Templates |
|---|---|---|
| `ref:` (include another template) | 94 | 50 |
| the `field{renderer=date(…)}` suffix | 51 | 32 |
| `toSentence` | 39 | 13 |
| `startsWith` / `endsWith` | 24 | 10 |
| `split` | 14 | 5 |
| `replaceStr` | 12 | 8 |
| `map` / `mapi` (Welsh month and value translation) | 28 | 17 |
| `squote` | 10 | 9 |
| `dateFormat` with a variable format or a locale argument | 19 | — |
| `refLookup:` | 6 | 6 |
| `localeinfo` | 1 | 1 |

The corpus also has 185 `.doc` and 3 `.odt` templates, which this service does not merge.
