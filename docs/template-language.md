# The Docmosis template language this service supports

The scope comes from a survey of every template in hmcts/docmosis on 2026-11-17: 2,972 readable `.docx` files holding 221,927 instructions. The supported list below covers every instruction in those templates except the long tail under "Not yet supported". Anything outside it fails with `unsupported instruction <<…>>`.

The behaviour described here was verified against a licensed Docmosis Tornado on 2026-11-17, and the fixtures in `test/fixtures/src/` hold Docmosis's own output (see "Checking parity with Docmosis" in the README).

## Supported

**Blocks**
- `cs_`, `cr_`, `rs_` and `rr_`, closed by `es_` or `er_`. An end tag can be bare (`es_`), named (`es_timeline`) or bracketed (`er_[rows]`).
- A named end tag must match its start tag: `<<cs_claim.type>>…<<es_claim>>` is an error (`Mismatched sections`). Use `es_` or the exact name.
- A block that is never closed, and an end tag with no start, are errors.
- `else`, and `else_<cond>` as an else-if. Anything after `else` that does not start with an underscore is ignored: `else{x=1}` and `else {x=1}` are a plain `else`, as in Docmosis, where the condition is never read.
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
- A renderer suffix, `field{renderer=name('parameter',…)}`, formats the value (see "Renderers" below). `op:` can precede it.
- `ref:` and `refLookup:` merge another template in at the tag (see "Including another template" below).
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

## Renderers

`<<field{renderer=name('a','b')}>>` formats the value of a field. Docmosis has three renderers, and a name it does not know leaves the value as it is, with no error (and names are case sensitive: `DATE` is unknown). Parameters are in single quotes, straight or curly, and the spaces around the pieces do not matter. A parameter can hold quotes of its own where a comma, `)` or the end follows its last quote, so `'yyyy-MM-dd'T'HH:mm'` is one parameter. A suffix may name only `renderer`; `{foo=1}`, `{}` and two suffixes are errors, and so is a parameter that is not in quotes.

A value that is null, missing, empty, blank, a map or a list renders as nothing, for `date` and `number`. `boolean` reads it as false.

| Renderer | Behaviour |
|---|---|
| `date('out')` | Parses the value with the default input formats of `dateFormat` (which exclude `yyyy-MM-dd`), then prints it as `out` |
| `date('out','in')` | Parses with `in` only. An empty `out` prints nothing; at most two parameters |
| `number` | Prints the number as written: a numeric string keeps its digits (`12.50`), grouping commas are dropped, leading zeros are dropped, and reading stops at the first character that is not part of a number (`1e3` is `1`, `2024-03-05` is `2024`). Text and booleans are an error |
| `number('pattern')` | A `DecimalFormat` pattern, rounded half-even: `'#,##0.00'`, `'0'`, `'£#,##0.00'`, `'0.0%'` (percent multiplies by 100), `'¤#,##0'` (the dollar sign) |
| `number('')` | The default grouping format: `1,234.5678`, `.5` |
| `boolean` | `true` or `false`. True for boolean `true`, the number `1`, and a string that is `y`, `yes`, `t`, `true` (any case) or `1`/`1.0`; everything else is false, including `on`, `2` and `true ` |
| `boolean('format')` | `yesno` Yes/No, `yesnouc` YES/NO, `yesnolc` yes/no, `yn` Y/N, `ynlc` y/n, `wingdings1` ü/û, `wingdings2` þ/¨, `dingbats1` ✓/✗, `dingbats2` ✔/✘. The name is not case sensitive; one parameter only |

Not supported: the locale and currency parameters of `number` (an error that says so; empty ones are accepted). A pattern with a literal `(` inside a renderer is rejected, as it is by Docmosis.

## Including another template

`<<ref:Name.docx>>` merges the template `Name.docx` in at that point; `<<refLookup:field>>` reads the name from a field of the data (any path: `items[0].name`, `$root.x`, `$parent.x`, `$this`, a `$var`) and includes that template. There is no template store, so the request carries every template a tag may name (see "Send included templates with the request" in the README). Behaviour verified against Docmosis:

- The name is a literal. `ref:{expr}` is a template called `{expr}`, and `ref:$this` is a template called `$this`. Keywords are case sensitive. A space after the colon, or nothing after it, is an error; a space after the name is not. `ref:`/`refLookup:` take no `op:`.
- The include is merged with the data scope the tag is in: inside a repeat it reads the item, and a variable set in the include (`<<$v=…>>`) is visible after it and the reverse. It is read as a template of its own: a block cannot open in one and close in the other, and a fault in the include (an unclosed block) is reported against it.
- A tag alone in its paragraph is replaced by the paragraphs and tables of the include, each in its own properties. A tag with other text runs the first included paragraph on from the text before it, in the host paragraph's properties, and the text after it on from the last included paragraph. A page break alone in a paragraph before a bare end tag is dropped; before an end tag that shares its paragraph with something (as in `<<es_>><<ref:X>>`) it is kept.
- A tag works in a table cell, a repeat, a condition, a header and a footer. An include can include another; the chain stops with `Template Circular Reference` when a template is reached again (Docmosis lets `a` call itself once more first; this does not) and with an error at 16 levels.
- Tags are resolved when reached, so a name that was not supplied is an error only when its paragraph is merged: `Template Not found [name]` (devMode writes `<<ref:name>>Docmosis1`). `refLookup:` says `Can't load sub-template: no lookup name found via lookup:field` for a missing, null, empty or map value, and `Template Not found [name] via data lookup: [name]` for a name that was not supplied. A number is read as its text.

What the include brings with it:

| Part | Result |
|---|---|
| Body | Merged as above |
| Headers, footers, the include's own page setup | Dropped. The host's apply, and a section break inside the include takes the host's page setup (without its header and footer references) |
| Styles | Every style the include uses, and those they are based on, continue with or link to, are copied under a new id (`Name_1`, `Name_2`… by include) and its paragraphs point at the copy. A style the host has with the identical definition is reused. When the include's default paragraph style or document defaults differ from the host's, its unstyled paragraphs get a copy of its default, based on a style that holds its document defaults. Docmosis renames styles the same way |
| Numbering | The lists the include uses are copied as new lists, so they do not continue the host's |
| Images, hyperlinks | Relationships are renumbered in the host part's own relationships; images are copied to `word/media/inc<n>_<name>` and their content type registered |
| Namespaces | Declared on the host's root where the included content uses a prefix the host lacks |
| Limits | An include counts against the same zip entry and size limits as the template, and what it expands to against the output limits |

An include that cannot be copied faithfully fails with a message that says why, and nothing is written: footnotes, endnotes, comments, `altChunk`, a relationship of any type but image and hyperlink (charts, embedded objects, diagrams), a picture bullet list, an image or relationship the include lacks, an image type that is not known, a namespace prefix that means something else in the host, and an include that is not a readable `.docx`.

Not matched: in devMode, a block fault inside an include is marked in the include's own paragraph (`<<analysis>>Docmosis1<<cs_x>>`), where Docmosis puts the marker on a line of its own.

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
| `ref:` of a template that was not sent | `Template Not found` |
| `refLookup:` with no name in the data | `no lookup name found` |
| Templates that include each other | `Circular Reference` |
| A renderer suffix that cannot be read | `Each parameter to a renderer must be in single quotes`, `has a qualifier that is not well formed`, `has an unknown qualifier`, `is missing the close bracket` |
| A value a renderer cannot use | `Cannot render field "x":Renderer:number Can't parse value as a number`, `…Can't parse field into a date`, `…Renderer:boolean unknown format` |

With `devMode` on the render succeeds and each error is written into the document as the instruction followed by `Docmosis<N>`, with `N` counting the errors: `<<{status +}>>Docmosis1`. A structural error (a block fault) writes `<<analysis>>Docmosis<N>` and then the paragraph's own text.

## Not yet supported

The long tail, in order of use:

| Feature | Uses | Templates |
|---|---|---|
| `toSentence` | 39 | 13 |
| `startsWith` / `endsWith` | 24 | 10 |
| `split` | 14 | 5 |
| `replaceStr` | 12 | 8 |
| `map` / `mapi` (Welsh month and value translation) | 28 | 17 |
| `squote` | 10 | 9 |
| `dateFormat` with a variable format or a locale argument | 19 | — |
| `localeinfo` | 1 | 1 |

The corpus also has 185 `.doc` and 3 `.odt` templates, which this service does not merge.
