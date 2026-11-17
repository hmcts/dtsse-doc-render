import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type OutputFormat = "pdf" | "docx";

export class ConversionError extends Error {}

const soffice = (): string => process.env.SOFFICE_BIN || "soffice";
const timeoutMs = (): number => Number(process.env.SOFFICE_TIMEOUT_MS || 60_000);
const profileRoot = (): string => process.env.SOFFICE_PROFILE_DIR || path.join(os.tmpdir(), "lo-profile");
const poolSize = (): number => Math.max(1, Number(process.env.SOFFICE_POOL_SIZE || 2));

const free: number[] = [];
const waiting: Array<(slot: number) => void> = [];
let created = 0;

const acquire = (): Promise<number> => {
  const reuse = free.pop();
  if (reuse !== undefined) {
    return Promise.resolve(reuse);
  }
  if (created < poolSize()) {
    return Promise.resolve(created++);
  }
  return new Promise((resolve) => waiting.push(resolve));
};

const release = (slot: number): void => {
  const next = waiting.shift();
  if (next) {
    next(slot);
  } else {
    free.push(slot);
  }
};

const run = (args: string[], limitMs: number): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child: ChildProcess = spawn(soffice(), args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
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
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ConversionError(`LibreOffice timed out after ${limitMs}ms`));
      } else {
        resolve({ code, output });
      }
    });
  });

export async function convertToPdf(document: Buffer, sourceExtension: string): Promise<Buffer> {
  const extension =
    sourceExtension
      .replace(/^\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "docx";
  const workDir = await mkdtemp(path.join(os.tmpdir(), "convert-"));
  const slot = await acquire();
  try {
    const profile = path.join(profileRoot(), String(slot));
    await mkdir(profile, { recursive: true });
    const input = path.join(workDir, `input.${extension}`);
    await writeFile(input, document);
    const { code, output } = await run(
      [
        "--headless",
        "--norestore",
        "--nologo",
        "--nolockcheck",
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        workDir,
        input
      ],
      timeoutMs()
    );
    const pdf = await readFile(path.join(workDir, "input.pdf")).catch(() => undefined);
    if (code !== 0 || !pdf) {
      throw new ConversionError(`LibreOffice conversion failed (exit ${code}): ${output.trim().slice(0, 500)}`);
    }
    return pdf;
  } finally {
    release(slot);
    await rm(workDir, { recursive: true, force: true });
  }
}

let ready = false;

export async function converterReady(): Promise<boolean> {
  if (ready) {
    return true;
  }
  try {
    const { code } = await run(["--version"], 15_000);
    ready = code === 0;
  } catch {
    ready = false;
  }
  return ready;
}
