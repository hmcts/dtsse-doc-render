import { unzip } from "./zip.ts";

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity.toLowerCase()] ?? _;
  });
}

const TOKEN =
  /<w:p(?=[\s>])[^>]*?(?:\/)?>|<\/w:p>|<w:tr(?=[\s>])[^>]*>|<\/w:tr>|<w:tc(?=[\s>])[^>]*>|<\/w:tc>|<w:t(?=[\s>])[^>]*?(?:\/>|>([^<]*)<\/w:t>)|<w:br\b[^>]*\/?>|<w:cr\s*\/>|<w:tab\s*\/>/g;

/**
 * Reduces a WordprocessingML part to the plain-text form used by expected.txt: one line per non-empty paragraph, a table
 * row as its cells joined by " | ", a line break inside a paragraph as the two characters \n, and each line trimmed.
 */
export function partText(xml: string): string[] {
  const lines: string[] = [];
  let paragraph: string | null = null;
  let cells: string[] | null = null;
  let cellParts: string[] | null = null;

  for (const match of xml.matchAll(TOKEN)) {
    const token = match[0];
    if (token.startsWith("<w:p")) {
      paragraph = token.endsWith("/>") ? null : "";
    } else if (token === "</w:p>") {
      const text = (paragraph ?? "").trim();
      paragraph = null;
      if (text) {
        if (cellParts) {
          cellParts.push(text);
        } else {
          lines.push(text);
        }
      }
    } else if (token.startsWith("<w:tr")) {
      cells = [];
    } else if (token === "</w:tr>") {
      if (cells?.some((c) => c !== "")) {
        lines.push(cells.join(" | "));
      }
      cells = null;
    } else if (token.startsWith("<w:tc")) {
      cellParts = [];
    } else if (token === "</w:tc>") {
      cells?.push((cellParts ?? []).join(" "));
      cellParts = null;
    } else if (paragraph !== null) {
      if (token.startsWith("<w:t>") || token.startsWith("<w:t ")) {
        paragraph += decode(match[1] ?? "").replace(/\r?\n/g, "\\n");
      } else if (token.startsWith("<w:br") || token.startsWith("<w:cr")) {
        paragraph += "\\n";
      } else if (token.startsWith("<w:tab")) {
        paragraph += " ";
      }
    }
  }
  return lines;
}

/** Extracts the text of a .docx: header paragraphs first, prefixed "[header] ", then the body. */
export function docxText(docx: Buffer): string[] {
  const parts = unzip(docx);
  const headers = [...parts.keys()].filter((name) => /^word\/header\d*\.xml$/.test(name)).sort();
  const lines: string[] = [];
  for (const name of headers) {
    for (const line of partText(parts.get(name)!.toString("utf8"))) {
      lines.push(`[header] ${line}`);
    }
  }
  const body = parts.get("word/document.xml");
  if (!body) {
    throw new Error("word/document.xml is missing from the returned docx");
  }
  lines.push(...partText(body.toString("utf8")));
  return lines;
}
