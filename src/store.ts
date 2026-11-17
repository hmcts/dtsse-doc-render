import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface TemplateStore {
  find(name: string): Promise<Buffer | undefined>;
  list(): Promise<string[]>;
  save(name: string, content: Buffer): Promise<void>;
}

export interface StoreOptions {
  templatesDir?: string;
  uploadDir?: string;
  env?: string;
}

export class InvalidTemplateName extends Error {}

export const assertTemplateName = (name: string): void => {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    throw new InvalidTemplateName(`Invalid template name: ${JSON.stringify(name)}`);
  }
};

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])));
  return nested.flat().filter((file) => file.toLowerCase().endsWith(".docx"));
};

const topLevelFolder = (root: string, file: string): string => path.relative(root, file).split(path.sep)[0] ?? "";

export const createStore = ({ templatesDir = "/templates", uploadDir = "/tmp/templates", env }: StoreOptions = {}): TemplateStore => {
  let index = new Map<string, string>();

  // Lower rank wins: the selected environment, then Base, then everything else.
  const rank = (file: string): number => {
    const folder = topLevelFolder(templatesDir, file);
    if (env && folder === env) {
      return 0;
    }
    return folder === "Base" ? 1 : 2;
  };

  const reindex = async (): Promise<void> => {
    const files = (await walk(templatesDir)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const next = new Map<string, string>();
    for (const file of files) {
      const name = path.basename(file);
      if (!next.has(name)) {
        next.set(name, file);
      }
    }
    for (const file of await walk(uploadDir)) {
      next.set(path.basename(file), file);
    }
    index = next;
  };

  return {
    async find(name) {
      assertTemplateName(name);
      if (!index.has(name)) {
        await reindex();
      }
      const file = index.get(name);
      return file ? readFile(file) : undefined;
    },
    async list() {
      await reindex();
      return [...index.keys()].sort();
    },
    async save(name, content) {
      assertTemplateName(name);
      await mkdir(uploadDir, { recursive: true });
      const file = path.join(uploadDir, name);
      await writeFile(file, content);
      index.set(name, file);
    }
  };
};
