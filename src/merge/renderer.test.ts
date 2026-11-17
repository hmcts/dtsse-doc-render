import { describe, expect, it } from "vitest";
import { makeDocx, para, paragraphs } from "../../test/helpers/docx.ts";
import { type MergeError, mergeDocx } from "./index.ts";
import { parseQualified } from "./renderer.ts";

const data = {
  d: "2024-03-05",
  dm: "05 Mar 2024",
  dz: "2024-03-05T14:30:00Z",
  dt: "2024-03-05T14:30:00",
  ds: "05/03/2024",
  n: 1234.5678,
  neg: -3.5,
  zero: 0,
  big: 12345678901.5,
  small: 0.000012,
  half: 0.5,
  text: "hello",
  yes: true,
  no: false,
  empty: "",
  blank: " ",
  nothing: null,
  map: { a: 1 },
  list: [1, 2],
  oneString: "1",
  grouped: "1,234.5",
  padded: "007",
  exponent: "1e3",
  trailingZeros: "12.50",
  spaced: " 12 ",
  plus: "+5",
  dates: ["2024-03-05", "2024-04-06"]
};

const render = async (line: string, devMode = false): Promise<string> => {
  const out = await mergeDocx(makeDocx(para(line)), data, { devMode });
  return paragraphs(out).join("|");
};

const failure = async (line: string): Promise<string> => {
  try {
    await render(line);
  } catch (e) {
    return [(e as MergeError).message, ...(e as MergeError).details].join("\n");
  }
  throw new Error(`${line} merged`);
};

describe("Docmosis: field{renderer=date(out, in)}", () => {
  it.each([
    ["<<d{renderer=date('dd MMMM yyyy','yyyy-MM-dd')}>>", "05 March 2024"],
    ["<<d{renderer=date(‘dd MMMM yyyy’, ‘yyyy-MM-dd’)}>>", "05 March 2024"],
    ["<<d{renderer=date( 'dd MMMM yyyy' , 'yyyy-MM-dd' )}>>", "05 March 2024"],
    ["<<d {renderer = date('dd MMMM yyyy','yyyy-MM-dd')}>>", "05 March 2024"],
    ["<<dt{renderer=date('dd MMMM yyyy','yyyy-MM-dd')}>>", "05 March 2024"],
    ["<<ds{renderer=date('yyyy','dd/MM/yyyy')}>>", "2024"],
    ["<<dm{renderer=date('yyyy-MM-dd')}>>", "2024-03-05"],
    ["<<dz{renderer=date('yyyy-MM-dd HH:mm')}>>", "2024-03-05 14:30"],
    ["<<op:d{renderer=date('dd MMMM yyyy','yyyy-MM-dd')}>>", "05 March 2024"],
    ["<<d{renderer=date('dd MMMM yyyy','yyyy-MM-dd')}>>x", "05 March 2024x"]
  ])("%s prints %j", async (line, expected) => {
    expect(await render(line)).toBe(expected);
  });

  it.each([
    ["a null", "nothing"],
    ["a missing field", "missing"],
    ["an empty string", "empty"],
    ["a blank string", "blank"],
    ["a map", "map"],
    ["a list", "list"]
  ])("Docmosis: %s renders as nothing and does not fail", async (_what, field) => {
    expect(await render(`<<${field}{renderer=date('yyyy','yyyy-MM-dd')}>>`)).toBe("");
  });

  it("Docmosis: an empty output pattern prints nothing", async () => {
    expect(await render("<<d{renderer=date('','yyyy-MM-dd')}>>")).toBe("");
  });

  it("Docmosis: a blank value takes its paragraph away under op:", async () => {
    expect(
      await mergeDocx(makeDocx(para("a") + para("<<op:empty{renderer=date('yyyy','yyyy-MM-dd')}>>") + para("b")), data, { devMode: false }).then(paragraphs)
    ).toEqual(["a", "b"]);
  });

  it("Docmosis: the renderer works on $this in a repeat and on a variable", async () => {
    expect(await render("<<rs_dates>><<$this{renderer=date('dd/MM/yy','yyyy-MM-dd')}>>;<<es_>>")).toBe("05/03/24;06/04/24;");
    expect(await render("<<$v=d>><<$v{renderer=date('dd/MM/yy','yyyy-MM-dd')}>>")).toBe("05/03/24");
  });

  it("Docmosis: one parameter parses the value with the default input formats, which exclude yyyy-MM-dd", async () => {
    const message = await failure("<<d{renderer=date('yyyy')}>>");
    expect(message).toContain(
      `Cannot render field "d":Can't parse field into a date (field="d" Cannot parse date:value="2024-03-05" formats applied=["EEE MMM dd HH:mm:ss zzz yyyy"`
    );
    expect(await failure("<<d{renderer=date}>>")).toContain("Can't parse field into a date");
  });

  it.each([
    ["a number", "n", `value="1234.5678"`],
    ["a boolean", "yes", `value="true"`],
    ["text", "text", `value="hello"`]
  ])("Docmosis: %s is not a date", async (_what, field, value) => {
    const message = await failure(`<<${field}{renderer=date('yyyy','yyyy-MM-dd')}>>`);
    expect(message).toContain("Can't parse field into a date");
    expect(message).toContain(value);
    expect(message).toContain(`formats applied=["yyyy-MM-dd"]`);
  });

  it("Docmosis: a pattern that is not a date format names the pattern", async () => {
    expect(await failure("<<d{renderer=date('yyyy','xx')}>>")).toContain(`The date format "xx" can not be applied as a format pattern`);
    expect(await failure("<<d{renderer=date('qqq','yyyy-MM-dd')}>>")).toContain(`The date format "qqq" can not be applied as a format pattern`);
  });

  it("Docmosis: a third parameter is refused when the field renders", async () => {
    expect(await failure("<<d{renderer=date('a','b','c')}>>")).toContain("Renderer:date can have at most two parameters");
  });
});

describe("Docmosis: field{renderer=number(pattern)}", () => {
  it.each([
    ["<<n{renderer=number}>>", "1234.5678"],
    ["<<big{renderer=number}>>", "12345678901.5"],
    ["<<small{renderer=number}>>", "0.000012"],
    ["<<n{renderer=number('#,##0.00')}>>", "1,234.57"],
    ["<<n{renderer=number(‘#,##0.00’)}>>", "1,234.57"],
    ["<<n{renderer=number('0.0')}>>", "1234.6"],
    ["<<n{renderer=number('0')}>>", "1235"],
    ["<<n{renderer=number('#.##')}>>", "1234.57"],
    ["<<n{renderer=number('000000.000')}>>", "001234.568"],
    ["<<neg{renderer=number('#,##0.00')}>>", "-3.50"],
    ["<<zero{renderer=number('#,##0.00')}>>", "0.00"],
    ["<<zero{renderer=number('#.##')}>>", "0"],
    ["<<big{renderer=number('#,##0.00')}>>", "12,345,678,901.50"],
    ["<<n{renderer=number('£#,##0.00')}>>", "£1,234.57"],
    ["<<n{renderer=number('0.0%')}>>", "123456.8%"],
    ["<<n{renderer=number('abc')}>>", "abc1235"],
    ["<<n{renderer=number('¤#,##0.00')}>>", "$1,234.57"],
    ["<<n{renderer=number('')}>>", "1,234.5678"],
    ["<<half{renderer=number('')}>>", ".5"],
    ["<<big{renderer=number('')}>>", "12,345,678,901.5"]
  ])("%s prints %j", async (line, expected) => {
    expect(await render(line)).toBe(expected);
  });

  it.each([
    ["a numeric string keeps its digits", "<<trailingZeros{renderer=number}>>", "12.50"],
    ["a numeric string is read with its grouping commas", "<<grouped{renderer=number('#,##0.00')}>>", "1,234.50"],
    ["grouping commas are dropped when no pattern is given", "<<grouped{renderer=number}>>", "1234.5"],
    ["leading zeros are dropped", "<<padded{renderer=number}>>", "7"],
    ["reading stops at the first character that is not part of a number", "<<exponent{renderer=number}>>", "1"],
    ["a date reads as its leading digits", "<<d{renderer=number('0')}>>", "2024"],
    ["a trailing zero is dropped under an empty pattern", "<<trailingZeros{renderer=number('')}>>", "12.5"]
  ])("Docmosis: %s", async (_what, line, expected) => {
    expect(await render(line)).toBe(expected);
  });

  it.each(["nothing", "missing", "empty", "blank", "map", "list"])("Docmosis: %s renders as nothing", async (field) => {
    expect(await render(`<<${field}{renderer=number('0.0')}>>`)).toBe("");
  });

  it.each([
    ["text", "text", "hello"],
    ["a boolean", "yes", "true"],
    ["a value with spaces round it", "spaced", " 12 "],
    ["a value with a leading plus", "plus", "+5"]
  ])("Docmosis: %s is not a number", async (_what, field, value) => {
    expect(await failure(`<<${field}{renderer=number('0.0')}>>`)).toContain(
      `Cannot render field "${field}":Renderer:number Can't parse value as a number: "${value}".`
    );
  });

  it("Docmosis: a pattern with two decimal points is an unknown format", async () => {
    expect(await failure("<<n{renderer=number('0.0.0')}>>")).toContain(`Renderer:number unknown format: "0.0.0".`);
  });

  it("refuses a fourth parameter as Docmosis does, and locale or currency parameters it cannot honour", async () => {
    expect(await failure("<<n{renderer=number('0','en','GBP','x')}>>")).toContain("Renderer:number can have at most three parameters");
    expect(await failure("<<n{renderer=number('0','de')}>>")).toContain("not supported by dtsse-doc-render");
    expect(await render("<<n{renderer=number('0','','')}>>")).toBe("1235");
  });
});

describe("Docmosis: field{renderer=boolean(format)}", () => {
  it.each([
    ["yesno", "Yes", "No"],
    ["yesnouc", "YES", "NO"],
    ["yesnolc", "yes", "no"],
    ["yn", "Y", "N"],
    ["ynlc", "y", "n"],
    ["wingdings1", "ü", "û"],
    ["wingdings2", "þ", "¨"],
    ["dingbats1", "✓", "✗"],
    ["dingbats2", "✔", "✘"]
  ])("the %s format prints %s and %s", async (format, on, off) => {
    expect(await render(`<<yes{renderer=boolean('${format}')}>>`)).toBe(on);
    expect(await render(`<<no{renderer=boolean('${format}')}>>`)).toBe(off);
  });

  it("Docmosis: format names are not case sensitive and may use curly quotes", async () => {
    expect(await render("<<yes{renderer=boolean('YESNO')}>>")).toBe("Yes");
    expect(await render("<<yes{renderer=boolean(‘yn’)}>>")).toBe("Y");
  });

  it("Docmosis: with no format the value prints as true or false", async () => {
    expect(await render("<<yes{renderer=boolean}>>")).toBe("true");
    expect(await render("<<no{renderer=boolean()}>>")).toBe("false");
    expect(await render("<<text{renderer=boolean}>>")).toBe("false");
  });

  it.each([
    ["y", "Y"],
    ["Yes", "Y"],
    ["t", "Y"],
    ["TRUE", "Y"],
    ["1", "Y"],
    ["1.0", "Y"],
    ["on", "N"],
    ["2", "N"],
    ["0", "N"],
    ["no", "N"],
    ["true ", "N"],
    ["1e0", "N"]
  ])("Docmosis: the string %j is %s", async (value, expected) => {
    const out = await mergeDocx(makeDocx(para("<<v{renderer=boolean('yn')}>>")), { v: value }, { devMode: false });
    expect(paragraphs(out)).toEqual([expected]);
  });

  it("Docmosis: only 1 is true among numbers; null, missing, maps and lists are false", async () => {
    const out = await mergeDocx(
      makeDocx(
        para(
          "<<one{renderer=boolean('yn')}>><<two{renderer=boolean('yn')}>><<nothing{renderer=boolean('yn')}>><<missing{renderer=boolean('yn')}>><<map{renderer=boolean('yn')}>><<list{renderer=boolean('yn')}>>"
        )
      ),
      { one: 1, two: 2, nothing: null, map: {}, list: [] },
      { devMode: false }
    );
    expect(paragraphs(out)).toEqual(["YNNNNN"]);
  });

  it("Docmosis: an unknown format lists the valid ones", async () => {
    expect(await failure("<<yes{renderer=boolean('Y')}>>")).toContain(
      `Renderer:boolean unknown format: "Y".  Valid formats are: "yesno", "wingdings2", "ynlc", "yn", "yesnouc", "yesnolc", "dingbats2", "wingdings1", "dingbats1"`
    );
    expect(await failure("<<yes{renderer=boolean('')}>>")).toContain(`unknown format: ""`);
  });

  it("Docmosis: a second parameter is refused", async () => {
    expect(await failure("<<yes{renderer=boolean('yn','x')}>>")).toContain("Renderer:boolean can have at most one parameter");
  });
});

describe("Docmosis: other renderer names", () => {
  it.each(["zzz", "DATE", "string", "currency('GBP')", "markdown", "html", "upper('a','b','c','d','e','f')"])(
    "%s leaves the value as it is",
    async (renderer) => {
      expect(await render(`<<text{renderer=${renderer}}>>`)).toBe("hello");
    }
  );

  it("prints nothing for a map under an unknown renderer", async () => {
    expect(await render("<<map{renderer=zzz}>>")).toBe("");
  });
});

describe("Docmosis: a suffix it cannot read rejects the template before merging", () => {
  it.each([
    ["{}", "has a qualifier that is not well formed"],
    ["{renderer=}", "has a qualifier that is not well formed"],
    ["{renderer}", "has a qualifier that is not well formed"],
    ["{renderer=date('a','b')}{renderer=boolean}", "has a qualifier that is not well formed"],
    ["{foo=1}", `has an unknown qualifier "foo"`],
    ["{renderer=date('yyyy','yyyy-MM-dd'),other=1}", `has an unknown qualifier "other"`],
    ["{renderer=date('yyyy','yyyy-MM-dd'}", "is missing the close bracket"],
    ["{renderer=date(1)}", "Each parameter to a renderer must be in single quotes"],
    ["{renderer=boolean(yn)}", "Each parameter to a renderer must be in single quotes"],
    ["{renderer=zzz(1,2,3)}", "Each parameter to a renderer must be in single quotes"],
    ["{renderer=zzz('a)}", "There is an unclosed literal"],
    ["{renderer=date('yyyy','yyyy-MM-dd'))}", "a close bracket ')' was found with no open bracket"],
    ["{renderer=number('#,##0.00;(#,##0.00)')}", "an open bracket '(' was found inside brackets"]
  ])("d%s", async (suffix, phrase) => {
    expect(await failure(`<<d${suffix}>>`)).toContain(phrase);
  });

  it("writes <<analysis>> and leaves the paragraph in devMode", async () => {
    expect(await render("<<d{renderer=date(1)}>>x", true)).toBe("<<analysis>>Docmosis1<<d{renderer=date(1)}>>x");
  });

  it("writes the field and a number in devMode when a render fails", async () => {
    expect(await render("<<d{renderer=boolean('xx')}>>x", true)).toBe("<<d{renderer=boolean('xx')}>>Docmosis1x");
  });

  it("does not take a renderer in a condition", async () => {
    expect(await failure("<<cs_d{renderer=date('yyyy','yyyy-MM-dd')}>>x<<es_>>")).toMatch(/\{/);
  });
});

describe("parseQualified", () => {
  it("leaves text that is not a name and a suffix to the caller", () => {
    expect(parseQualified("plain")).toBeNull();
    expect(parseQualified("{expr}")).toBeNull();
    expect(parseQualified("a b{renderer=date('x')}")).toBeNull();
  });

  it("reads a renderer with parameters, quoted either way", () => {
    expect(parseQualified("a.b{renderer=date('x','y')}")).toEqual({ name: "a.b", renderer: { name: "date", args: ["x", "y"] } });
    expect(parseQualified("a{renderer=date(‘x’, ‘y’)}")).toEqual({ name: "a", renderer: { name: "date", args: ["x", "y"] } });
    expect(parseQualified("a{renderer=boolean}")).toEqual({ name: "a", renderer: { name: "boolean", args: [] } });
  });

  it("lets a parameter hold quotes of its own", () => {
    expect(parseQualified("a{renderer=date('yyyy-MM-dd'T'HH:mm:ss','z')}")?.renderer?.args).toEqual(["yyyy-MM-dd'T'HH:mm:ss", "z"]);
  });
});

describe("Docmosis: else with anything after it but an underscore is a plain else", () => {
  it.each([
    ["<<cs_no>>1<<else{no}>>2<<else>>3<<es_>>", "2"],
    ["<<cs_no>>1<<else {no}>>2<<es_>>", "2"],
    ["<<cs_no>>1<<else{ x=‘unterminated}>>2<<else>>3<<es_>>", "2"],
    ["<<cs_no>>1<<else_no>>2<<else>>3<<es_>>", "3"],
    ["<<cs_no>>1<<else_{yes}>>2<<else>>3<<es_>>", "2"]
  ])("%s prints %s", async (line, expected) => {
    expect(await render(line)).toBe(expected);
  });
});
