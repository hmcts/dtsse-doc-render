import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(os.tmpdir(), "convert-pool-"));
const broken = path.join(dir, "broken");
const fake = path.join(dir, "fake-soffice");

// The fake takes its instruction from the document content because soffice runs with a minimal environment.
const FAKE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
for a; do last=$a; done
while [ $# -gt 0 ]; do
  case $1 in
    --outdir) out=$2;;
    --convert-to) conv=$2;;
    --infilter=*) infilter=\${1#--infilter=};;
    -env:UserInstallation=*) profile=\${1#-env:UserInstallation=file://};;
  esac
  shift
done
if [ -f "${broken}" ]; then echo "broken" >&2; exit 3; fi
cmd=$(cat "$last")
ext=\${conv%%:*}
case $cmd in
  sleep*) sleep \${cmd#sleep };;
  crash) kill -SEGV $$;;
  fail) echo "no output" >&2; exit 1;;
  env) env | grep -E '^(PATH|HOME|LANG|TMPDIR|SECRET_TOKEN)=' > "$out/input.$ext"; exit 0;;
  args) printf '%s|%s|%s|%s' "$conv" "$infilter" "$(cat "$profile/user/registrymodifications.xcu" | tr -d '\\n')" "$last" > "$out/input.$ext"; exit 0;;
esac
printf '%%PDF-fake' > "$out/input.$ext"
`;

type Convert = typeof import("./convert.ts");
let mod: Convert;

const load = async (): Promise<Convert> => {
  vi.resetModules();
  mod = await import("./convert.ts");
  return mod;
};

beforeAll(() => {
  writeFileSync(fake, FAKE, { mode: 0o755 });
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  process.env.SOFFICE_BIN = fake;
  process.env.SOFFICE_PROFILE_DIR = path.join(dir, "profiles");
  process.env.SOFFICE_POOL_SIZE = "1";
  delete process.env.SOFFICE_QUEUE_LIMIT;
  delete process.env.SOFFICE_QUEUE_TIMEOUT_MS;
  delete process.env.SOFFICE_TIMEOUT_MS;
  rmSync(broken, { force: true });
});

afterEach(() => {
  for (const key of [
    "SOFFICE_BIN",
    "SOFFICE_PROFILE_DIR",
    "SOFFICE_POOL_SIZE",
    "SOFFICE_QUEUE_LIMIT",
    "SOFFICE_QUEUE_TIMEOUT_MS",
    "SOFFICE_TIMEOUT_MS",
    "SECRET_TOKEN"
  ]) {
    delete process.env[key];
  }
});

const doc = (text: string): Buffer => Buffer.from(text);

describe("source document allowlist", () => {
  it.each(["fodt", "fods", "fodp", "xml", "html", "htm", "csv", "svg", "sh", "odg"])("rejects .%s", async (extension) => {
    const { convertToPdf, ConversionError } = await load();
    const rejection = convertToPdf(doc("<office:document/>"), extension);
    await expect(rejection).rejects.toBeInstanceOf(ConversionError);
    await expect(rejection).rejects.toThrow(/unsupported source document type/i);
  });

  it("rejects content that is not the type its extension claims", async () => {
    const { convertToPdf } = await load();
    await expect(convertToPdf(doc('<?xml version="1.0"?><office:document/>'), "docx")).rejects.toThrow(/does not match/);
    await expect(convertToPdf(doc("{\\rtf1 hi}"), "xlsx")).rejects.toThrow(/does not match/);
  });

  it("accepts each allowed type with matching content", async () => {
    const { convertToPdf } = await load();
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    for (const [extension, content] of [
      ["docx", zip],
      ["odt", zip],
      ["xlsx", zip],
      ["ods", zip],
      ["pptx", zip],
      ["odp", zip],
      ["doc", ole],
      ["xls", ole],
      ["ppt", ole],
      ["rtf", doc("{\\rtf1 hi}")],
      ["txt", doc("anything")]
    ] as const) {
      expect((await convertToPdf(content, extension)).toString()).toBe("%PDF-fake");
    }
  });
});

describe("conversion environment", () => {
  it("runs soffice with only PATH, HOME, LANG and TMPDIR", async () => {
    process.env.SECRET_TOKEN = "hunter2";
    const { convertTo } = await load();
    const seen = (await convertTo(doc("env"), "txt", "txt")).toString().trim().split("\n");
    expect(seen.map((line) => line.split("=")[0]).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    expect(seen.join("\n")).not.toContain("hunter2");
  });

  it("writes the security settings into the profile before first use", async () => {
    const { convertTo } = await load();
    const settings = (await convertTo(doc("args"), "txt", "txt")).toString();
    for (const expected of [
      "BlockUntrustedRefererLinks",
      "DisableMacrosExecution",
      "MacroSecurityLevel",
      "/org.openoffice.Office.Writer/Content/Update",
      "/org.openoffice.Office.Calc/Content/Update"
    ]) {
      expect(settings).toContain(expected);
    }
  });

  it("selects the LibreOffice filter for each target and forces the text import filter", async () => {
    const { convertTo } = await load();
    const filters: Record<string, string> = {
      pdf: "pdf",
      doc: "doc:MS Word 97",
      odt: "odt:writer8",
      html: "html:HTML (StarWriter)",
      txt: "txt:Text (encoded):UTF8"
    };
    for (const [target, filter] of Object.entries(filters)) {
      const seen = (await convertTo(doc("args"), "txt", target as "pdf")).toString();
      expect(seen.split("|")[0]).toBe(filter);
      expect(seen.split("|")[1]).toBe("Text (encoded):UTF8");
    }
  });

  it("converts through convertTo with the pdf target the same as convertToPdf", async () => {
    const { convertTo, convertToPdf } = await load();
    expect((await convertTo(doc("x"), "txt", "pdf")).equals(await convertToPdf(doc("x"), "txt"))).toBe(true);
  });
});

describe("bounded queue", () => {
  it("rejects with ConversionBusyError when the queue is full", async () => {
    process.env.SOFFICE_QUEUE_LIMIT = "1";
    const { convertToPdf, ConversionBusyError } = await load();
    const running = convertToPdf(doc("sleep 1"), "txt");
    const queued = convertToPdf(doc("x"), "txt");
    const overflow = convertToPdf(doc("y"), "txt");
    await expect(overflow).rejects.toBeInstanceOf(ConversionBusyError);
    await expect(overflow).rejects.toMatchObject({ name: "ConversionBusyError" });
    await expect(running).resolves.toBeInstanceOf(Buffer);
    await expect(queued).resolves.toBeInstanceOf(Buffer);
  });

  it("defaults the queue limit to four times the pool size", async () => {
    process.env.SOFFICE_POOL_SIZE = "2";
    const { convertToPdf, ConversionBusyError } = await load();
    const accepted = Array.from({ length: 2 + 8 }, () => convertToPdf(doc("sleep 0.5"), "txt"));
    await expect(convertToPdf(doc("x"), "txt")).rejects.toBeInstanceOf(ConversionBusyError);
    await expect(Promise.all(accepted)).resolves.toHaveLength(10);
  }, 20_000);

  it("rejects a waiter that exceeds the queue timeout and keeps serving the rest", async () => {
    process.env.SOFFICE_QUEUE_TIMEOUT_MS = "200";
    const { convertToPdf, ConversionBusyError } = await load();
    const running = convertToPdf(doc("sleep 1"), "txt");
    const waiter = convertToPdf(doc("x"), "txt");
    await expect(waiter).rejects.toBeInstanceOf(ConversionBusyError);
    await expect(waiter).rejects.toThrow(/waiting for a conversion slot/);
    await running;
    await expect(convertToPdf(doc("x"), "txt")).resolves.toBeInstanceOf(Buffer);
  });
});

describe("readiness", () => {
  it("is ready when soffice runs", async () => {
    const { converterReady } = await load();
    expect(await converterReady()).toBe(true);
  });

  it("reprobes after a crash by signal and recovers when a real conversion works", async () => {
    const { converterReady, convertToPdf } = await load();
    expect(await converterReady()).toBe(true);
    await expect(convertToPdf(doc("crash"), "txt")).rejects.toThrow(/signal SIGSEGV/);
    writeFileSync(broken, "");
    expect(await converterReady()).toBe(false);
    rmSync(broken);
    expect(await converterReady()).toBe(true);
  });

  it("is not ready after three failed conversions in a row, and a success resets the count", async () => {
    const { converterReady, convertToPdf } = await load();
    expect(await converterReady()).toBe(true);
    writeFileSync(broken, "");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(convertToPdf(doc("x"), "txt")).rejects.toThrow(/exit 3/);
    }
    expect(await converterReady()).toBe(true);
    await expect(convertToPdf(doc("x"), "txt")).rejects.toThrow(/exit 3/);
    expect(await converterReady()).toBe(false);
    rmSync(broken);
    expect(await converterReady()).toBe(true);
  });

  it("does not count a document-specific timeout against readiness", async () => {
    process.env.SOFFICE_TIMEOUT_MS = "200";
    const { converterReady, convertToPdf } = await load();
    expect(await converterReady()).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(convertToPdf(doc("sleep 5"), "txt")).rejects.toThrow(/timed out/);
    }
    expect(await converterReady()).toBe(true);
  });
});
