// Zips each test/fixtures/src/<name>/ directory into test/fixtures/<name>.docx. The built files are committed, so
// running this is only needed after editing a fixture. Usage: node test/fixtures/build.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src");

const DOS_TIME = 0;
const DOS_DATE = (46 << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/**
 * Zips one document from a directory: document.xml, and optionally header1.xml, styles.xml, numbering.xml, media/<files>
 * and rels.xml, whose Relationship elements are added to the document relationships as written.
 */
function buildDocx(dir) {
  const has = (file) => existsSync(join(dir, file));
  const headers = has("header1.xml") ? ["header1.xml"] : [];
  const media = has("media") ? readdirSync(join(dir, "media")).sort() : [];
  const extensions = [...new Set(media.map((m) => m.split(".").pop().toLowerCase()))];

  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    extensions.map((e) => `<Default Extension="${e}" ContentType="${MEDIA_TYPES[e]}"/>`).join("") +
    `<Override PartName="/word/document.xml" ContentType="${WML}.document.main+xml"/>` +
    (has("styles.xml") ? `<Override PartName="/word/styles.xml" ContentType="${WML}.styles+xml"/>` : "") +
    (has("numbering.xml") ? `<Override PartName="/word/numbering.xml" ContentType="${WML}.numbering+xml"/>` : "") +
    headers.map((h) => `<Override PartName="/word/${h}" ContentType="${WML}.header+xml"/>`).join("") +
    "</Types>";
  const rootRels = `${XML_DECL}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `${XML_DECL}<Relationships xmlns="${REL_NS}">${headers
    .map((h, i) => `<Relationship Id="rId${i + 2}" Type="${OFFICE_REL}/header" Target="${h}"/>`)
    .join("")}${has("styles.xml") ? `<Relationship Id="rIdStyles" Type="${OFFICE_REL}/styles" Target="styles.xml"/>` : ""}${
    has("numbering.xml") ? `<Relationship Id="rIdNumbering" Type="${OFFICE_REL}/numbering" Target="numbering.xml"/>` : ""
  }${has("rels.xml") ? readFileSync(join(dir, "rels.xml"), "utf8").trim() : ""}</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels) },
    { name: "word/document.xml", data: readFileSync(join(dir, "document.xml")) },
    ...(has("styles.xml") ? [{ name: "word/styles.xml", data: readFileSync(join(dir, "styles.xml")) }] : []),
    ...(has("numbering.xml") ? [{ name: "word/numbering.xml", data: readFileSync(join(dir, "numbering.xml")) }] : []),
    ...headers.map((h) => ({ name: `word/${h}`, data: readFileSync(join(dir, h)) })),
    ...media.map((m) => ({ name: `word/media/${m}`, data: readFileSync(join(dir, "media", m)) }))
  ]);
}

/**
 * A fixture holds the template in its own directory and, optionally, the templates it includes in includes/<name>/, one
 * directory per template laid out the same way. They are built into test/fixtures/<fixture>.includes/<name>.
 */
function build(name) {
  const dir = join(srcDir, name);
  writeFileSync(join(here, `${name}.docx`), buildDocx(dir));
  const includes = join(dir, "includes");
  if (existsSync(includes)) {
    const out = join(here, `${name}.includes`);
    mkdirSync(out, { recursive: true });
    for (const entry of readdirSync(includes, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      writeFileSync(join(out, entry.name), buildDocx(join(includes, entry.name)));
    }
  }
}

const names = readdirSync(srcDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
for (const name of names) {
  build(name);
}
console.log(`built ${names.length} fixtures`);
