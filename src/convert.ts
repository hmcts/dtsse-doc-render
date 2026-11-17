import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type OutputFormat = "pdf" | "docx";
export type ConvertTarget = "pdf" | "doc" | "odt" | "html" | "txt";

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly timedOut = false
  ) {
    super(message);
  }
}

export class ConversionBusyError extends Error {
  override name = "ConversionBusyError";
}

const soffice = (): string => process.env.SOFFICE_BIN || "soffice";
const timeoutMs = (): number => Number(process.env.SOFFICE_TIMEOUT_MS || 60_000);
const profileRoot = (): string => process.env.SOFFICE_PROFILE_DIR || path.join(os.tmpdir(), "lo-profile");
const poolSize = (): number => Math.max(1, Number(process.env.SOFFICE_POOL_SIZE || 2));
const queueLimit = (): number => {
  const configured = Number(process.env.SOFFICE_QUEUE_LIMIT);
  return Number.isFinite(configured) && configured >= 0 && process.env.SOFFICE_QUEUE_LIMIT ? configured : poolSize() * 4;
};
const queueTimeoutMs = (): number => Number(process.env.SOFFICE_QUEUE_TIMEOUT_MS || 60_000);
const CRASH_THRESHOLD = 3;

// Flat XML formats (fodt, fods, fodp, xml) are excluded: they carry links as plain attributes and LibreOffice
// sniffs content, so they are the easiest vehicle for pulling in local files. html is excluded because its
// import fetches arbitrary resources.
type Magic = "zip" | "ole" | "rtf" | "any";
const SOURCE_TYPES: Record<string, Magic[]> = {
  docx: ["zip"],
  doc: ["ole", "rtf"],
  odt: ["zip"],
  rtf: ["rtf"],
  txt: ["any"],
  xlsx: ["zip"],
  xls: ["ole"],
  ods: ["zip"],
  pptx: ["zip"],
  ppt: ["ole"],
  odp: ["zip"]
};

const TARGETS: Record<ConvertTarget, string> = {
  pdf: "pdf",
  doc: "doc:MS Word 97",
  odt: "odt:writer8",
  html: "html:HTML (StarWriter)",
  txt: "txt:Text (encoded):UTF8"
};

const TEXT_INFILTER = "Text (encoded):UTF8";

const matchesMagic = (document: Buffer, kinds: Magic[]): boolean =>
  kinds.some((kind) => {
    switch (kind) {
      case "zip":
        return document.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      case "ole":
        return document.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      case "rtf":
        return /^(?:\xef\xbb\xbf)?\s*\{\\rtf/.test(document.subarray(0, 32).toString("latin1"));
      default:
        return true;
    }
  });

// Writes into registrymodifications.xcu, keys from LibreOffice's officecfg schema (share/registry/main.xcd).
// Link update modes: 0 always, 1 on request, 2 never.
const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisablePythonRuntime" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
</oor:items>
`;

const initialisedProfiles = new Set<number>();

interface Profile {
  profile: string;
  home: string;
}

const writeProfile = async ({ profile, home }: Profile): Promise<void> => {
  await rm(profile, { recursive: true, force: true });
  await mkdir(path.join(profile, "user"), { recursive: true });
  await writeFile(path.join(profile, "user", "registrymodifications.xcu"), PROFILE_SETTINGS);
  await mkdir(home, { recursive: true });
};

const prepareProfile = async (slot: number): Promise<Profile> => {
  const prepared = { profile: path.join(profileRoot(), String(slot)), home: path.join(profileRoot(), `home-${slot}`) };
  if (!initialisedProfiles.has(slot)) {
    await writeProfile(prepared);
    initialisedProfiles.add(slot);
  }
  await mkdir(prepared.home, { recursive: true });
  return prepared;
};

const sofficeEnv = (home: string, tmp: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  LANG: process.env.LANG || "C.UTF-8",
  TMPDIR: tmp
});

const free: number[] = [];
const waiting: Array<{ resolve: (slot: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
let created = 0;

const acquire = (): Promise<number> => {
  const reuse = free.pop();
  if (reuse !== undefined) {
    return Promise.resolve(reuse);
  }
  if (created < poolSize()) {
    return Promise.resolve(created++);
  }
  if (waiting.length >= queueLimit()) {
    return Promise.reject(new ConversionBusyError(`Conversion queue is full (${waiting.length} waiting)`));
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) {
          waiting.splice(index, 1);
        }
        reject(new ConversionBusyError(`Timed out after ${queueTimeoutMs()}ms waiting for a conversion slot`));
      }, queueTimeoutMs())
    };
    waiting.push(waiter);
  });
};

const release = (slot: number): void => {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(slot);
  } else {
    free.push(slot);
  }
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

const run = (args: string[], limitMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child: ChildProcess = spawn(soffice(), args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    const killGroup = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, limitMs);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ConversionError(`Could not start ${soffice()}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ConversionError(`LibreOffice timed out after ${limitMs}ms`, true));
      } else {
        resolve({ code, signal, output });
      }
    });
  });

const crashed = new WeakSet<object>();
let ready: boolean | undefined;
let consecutiveFailures = 0;

const recordSuccess = (): void => {
  consecutiveFailures = 0;
  ready = true;
};

const recordFailure = (result: RunResult, produced: boolean): void => {
  if (result.signal) {
    ready = false;
    return;
  }
  if (!produced && result.code !== 0) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= CRASH_THRESHOLD) {
      ready = false;
    }
  }
};

const convert = async ({ profile, home }: Profile, document: Buffer, extension: string, target: ConvertTarget, limitMs: number): Promise<Buffer> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "convert-"));
  try {
    const inDir = path.join(workDir, "in");
    const outDir = path.join(workDir, "out");
    const tmp = path.join(workDir, "tmp");
    await Promise.all([inDir, outDir, tmp].map((dir) => mkdir(dir)));
    const input = path.join(inDir, `input.${extension}`);
    await writeFile(input, document);
    const args = ["--headless", "--norestore", "--nologo", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(profile).href}`];
    if (extension === "txt") {
      args.push(`--infilter=${TEXT_INFILTER}`);
    }
    args.push("--convert-to", TARGETS[target], "--outdir", outDir, input);
    const result = await run(args, limitMs, sofficeEnv(home, tmp));
    const output = await readFile(path.join(outDir, `input.${target}`)).catch(() => undefined);
    if (result.code !== 0 || !output) {
      recordFailure(result, output !== undefined);
      const failure = new ConversionError(
        `LibreOffice conversion failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`}): ${result.output.trim().slice(0, 500)}`
      );
      if (result.signal) {
        crashed.add(failure);
      }
      throw failure;
    }
    recordSuccess();
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

export async function convertTo(document: Buffer, sourceExtension: string, targetFormat: ConvertTarget): Promise<Buffer> {
  const extension =
    sourceExtension
      .replace(/^\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "docx";
  const magic = SOURCE_TYPES[extension];
  if (!magic) {
    throw new ConversionError(`Unsupported source document type '.${extension}'. Allowed: ${Object.keys(SOURCE_TYPES).join(", ")}`);
  }
  if (!(targetFormat in TARGETS)) {
    throw new ConversionError(`Unsupported output format '${targetFormat}'`);
  }
  if (!matchesMagic(document, magic)) {
    throw new ConversionError(`The document content does not match its '.${extension}' file type`);
  }
  const slot = await acquire();
  try {
    return await convert(await prepareProfile(slot), document, extension, targetFormat, timeoutMs());
  } catch (error) {
    if (error instanceof ConversionError && crashed.has(error)) {
      initialisedProfiles.delete(slot);
    }
    throw error;
  } finally {
    release(slot);
  }
}

export const convertToPdf = (document: Buffer, sourceExtension: string): Promise<Buffer> => convertTo(document, sourceExtension, "pdf");

let probing: Promise<boolean> | undefined;

const probe = async (): Promise<boolean> => {
  if (ready === undefined) {
    const root = profileRoot();
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(path.join(root, "probe-"));
    try {
      const { code } = await run(["--version"], 15_000, sofficeEnv(home, home));
      ready = code === 0;
    } catch {
      ready = false;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return ready;
  }
  // A crashed or repeatedly failing LibreOffice: prove it with a real conversion on a dedicated profile.
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "probe-"));
  try {
    const probeProfile = { profile: path.join(probeRoot, "profile"), home: path.join(probeRoot, "home") };
    await writeProfile(probeProfile);
    const pdf = await convert(probeProfile, Buffer.from("ready"), "txt", "pdf", 30_000);
    ready = pdf.subarray(0, 4).toString() === "%PDF";
  } catch {
    ready = false;
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
  if (ready) {
    consecutiveFailures = 0;
  }
  return ready;
};

export async function converterReady(): Promise<boolean> {
  if (ready === true) {
    return true;
  }
  probing ??= probe().finally(() => {
    probing = undefined;
  });
  return probing;
}
