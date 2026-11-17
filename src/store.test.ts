import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, InvalidTemplateName } from "./store.ts";

let root: string;
let templates: string;
let uploads: string;

const put = async (dir: string, relative: string, content: string) => {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "store-test-"));
  templates = path.join(root, "templates");
  uploads = path.join(root, "uploads");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = async (store: ReturnType<typeof createStore>, name: string) => (await store.find(name))?.toString();

describe("template store", () => {
  it("indexes .docx files recursively by file name and ignores other files", async () => {
    await put(templates, "a/b/Deep.docx", "deep");
    await put(templates, "Upper.DOCX", "upper");
    await put(templates, "notes.txt", "no");
    const store = createStore({ templatesDir: templates, uploadDir: uploads });
    expect(await store.list()).toEqual(["Deep.docx", "Upper.DOCX"]);
    expect(await text(store, "Deep.docx")).toBe("deep");
  });

  it("returns undefined for an unknown template and tolerates missing directories", async () => {
    const store = createStore({ templatesDir: templates, uploadDir: uploads });
    expect(await store.find("Nope.docx")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("uses Base before other folders without TEMPLATE_ENV", async () => {
    await put(templates, "AAT/T.docx", "aat");
    await put(templates, "Base/T.docx", "base");
    await put(templates, "Other/T.docx", "other");
    expect(await text(createStore({ templatesDir: templates, uploadDir: uploads }), "T.docx")).toBe("base");
  });

  it("lets the selected environment override Base", async () => {
    await put(templates, "AAT/T.docx", "aat");
    await put(templates, "Base/T.docx", "base");
    await put(templates, "Base/Only.docx", "only");
    const store = createStore({ templatesDir: templates, uploadDir: uploads, env: "AAT" });
    expect(await text(store, "T.docx")).toBe("aat");
    expect(await text(store, "Only.docx")).toBe("only");
  });

  it("falls back to Base when the environment folder lacks the template", async () => {
    await put(templates, "Base/T.docx", "base");
    await put(templates, "PROD/T.docx", "prod");
    expect(await text(createStore({ templatesDir: templates, uploadDir: uploads, env: "AAT" }), "T.docx")).toBe("base");
  });

  it("gives uploaded templates precedence", async () => {
    await put(templates, "Base/T.docx", "base");
    await put(uploads, "T.docx", "uploaded");
    expect(await text(createStore({ templatesDir: templates, uploadDir: uploads, env: "AAT" }), "T.docx")).toBe("uploaded");
  });

  it("saves an upload, creating the directory, and serves it straight away", async () => {
    await put(templates, "Base/T.docx", "base");
    const store = createStore({ templatesDir: templates, uploadDir: path.join(uploads, "nested") });
    expect(await text(store, "T.docx")).toBe("base");
    await store.save("T.docx", Buffer.from("new"));
    expect(await text(store, "T.docx")).toBe("new");
    expect(await createStore({ templatesDir: templates, uploadDir: path.join(uploads, "nested") }).list()).toEqual(["T.docx"]);
  });

  it("re-indexes when a name is missing so files copied in later are found", async () => {
    const store = createStore({ templatesDir: templates, uploadDir: uploads });
    expect(await store.find("Late.docx")).toBeUndefined();
    await put(templates, "Base/Late.docx", "late");
    expect(await text(store, "Late.docx")).toBe("late");
  });

  it.each(["../x.docx", "a/b.docx", "a\\b.docx", "..", "a..b.docx", "", "x\0.docx"])("rejects the template name %j", async (name) => {
    const store = createStore({ templatesDir: templates, uploadDir: uploads });
    await expect(store.find(name)).rejects.toBeInstanceOf(InvalidTemplateName);
    await expect(store.save(name, Buffer.from("x"))).rejects.toBeInstanceOf(InvalidTemplateName);
  });

  it("uses /templates and /tmp/templates by default", async () => {
    expect(await createStore().find("definitely-not-here.docx")).toBeUndefined();
  });
});
