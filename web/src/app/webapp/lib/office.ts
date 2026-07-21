// PowerPoint (.pptx) and Excel (.xlsx) → plain text, in the browser.
//
// Gemini rejects OOXML outright — generateContent 400s with "Unsupported MIME type" on
// …presentationml.presentation and …spreadsheetml.sheet, the same way it does on .docx. Only
// application/pdf gets the real document-vision path; everything else must arrive as text. So the
// only way to let people attach a deck or a workbook is to extract the text here and send that,
// exactly as the .docx branch already does with mammoth.
//
// Both parsers are loaded lazily from prepareFile so fflate and read-excel-file stay out of
// /webapp's first-load bundle. Every throw is a FileError, so prepareFile needs no translation.

import { FileError, MaxTextChars, sanitizeExtractedText } from "./files";

/** OOXML namespaces. Looked up by namespace rather than by `a:`/`p:` prefix, which a producer is
 *  free to rename. */
const NS_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_REL_ATTR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL_PART = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Slide placeholders that repeat furniture on every slide — page numbers, dates, footers. Left in,
 *  every slide ends with a stray number the model may read as content. */
const FurniturePlaceholders = new Set(["sldNum", "dt", "ftr"]);

// Zip guards, all checked from the central directory *before* anything is inflated. An OOXML file is
// attacker-supplied and a few hundred KB of zip can inflate to gigabytes.
//
// The size caps deliberately cover only the parts we actually inflate — the XML. A deck's bulk is
// its media, which we never unpack, so charging those bytes against the budget would reject a
// perfectly ordinary photo-heavy deck that is comfortably under the 10MB attachment limit.
/** Total inflated bytes allowed across the parts we read. */
const MaxTotalUnzipped = 40_000_000;
/** Inflated bytes allowed for any single part we read. */
const MaxEntryUnzipped = 15_000_000;
/** Entries allowed in the archive at all, media included — a cheap ceiling on central-directory
 *  games. A 500-slide deck with a picture on every slide lands well under this. */
const MaxEntries = 5000;
/** Compression ratio allowed for an entry, applied only above {@link RatioCheckFloor} — small XML
 *  parts legitimately compress very well and would false-positive at any useful threshold. */
const MaxCompressionRatio = 150;
const RatioCheckFloor = 1_000_000;

/** OLE2/CFB container magic. A password-protected .pptx/.xlsx is not a zip at all — it is a CFB file
 *  wrapping an encrypted package — and so are the legacy .ppt/.xls/.doc binaries. */
const CfbMagic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && CfbMagic.every((b, i) => bytes[i] === b);
}

/**
 * Walk an OOXML package, applying the bomb guards to every part matching `wanted`.
 *
 * With `extract` set the matching parts are inflated and returned as decoded UTF-8, keyed by part
 * name — that is the .pptx path, where we do the unpacking ourselves. With `extract` false nothing
 * is inflated at all and only the central directory is measured: that is the .xlsx path, where
 * read-excel-file opens the archive itself and this is our chance to refuse a bomb before handing
 * the file over.
 */
async function readParts(
  file: File,
  name: string,
  wanted: (part: string) => boolean,
  extract = true,
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isCfb(bytes)) throw new FileError("legacy-office", name);

  const { unzipSync } = await import("fflate");
  let entries = 0;
  let totalUnzipped = 0;
  let unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter: (entry) => {
        if ((entries += 1) > MaxEntries) throw new FileError("unreadable", name);
        if (!wanted(entry.name)) return false;
        const original = entry.originalSize || 0;
        totalUnzipped += original;
        if (
          original > MaxEntryUnzipped ||
          totalUnzipped > MaxTotalUnzipped ||
          (original > RatioCheckFloor && original / Math.max(entry.size, 1) > MaxCompressionRatio)
        ) {
          throw new FileError("unreadable", name);
        }
        return extract;
      },
    });
  } catch (e) {
    throw e instanceof FileError ? e : new FileError("unreadable", name);
  }

  const decoder = new TextDecoder();
  const parts = new Map<string, string>();
  for (const [part, data] of Object.entries(unzipped)) parts.set(part, decoder.decode(data));
  return parts;
}

/**
 * Parse one XML part. DTDs are stripped first — OOXML never legitimately uses them, and leaving them
 * in is a free entity-expansion vector — and the result is checked for `parsererror`, because
 * DOMParser signals failure by *returning* an error document rather than throwing.
 */
function parseXml(xml: string, name: string): Document {
  const safe = xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "").replace(/<!ENTITY[\s\S]*?>/gi, "");
  const doc = new DOMParser().parseFromString(safe, "application/xml");
  if (doc.querySelector("parsererror")) throw new FileError("unreadable", name);
  return doc;
}

/** Resolve a relationship Target against the directory of the part that declared it. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${baseDir}${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/** `ppt/slides/slide1.xml` → `ppt/slides/`. */
function dirOf(part: string): string {
  return part.slice(0, part.lastIndexOf("/") + 1);
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
function relsPathFor(part: string): string {
  return `${dirOf(part)}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;
}

/** Relationship Id → resolved part name, for one part's `.rels` file. */
function readRels(parts: Map<string, string>, ownerPart: string, name: string) {
  const rels = new Map<string, { target: string; type: string }>();
  const xml = parts.get(relsPathFor(ownerPart));
  if (!xml) return rels;
  const doc = parseXml(xml, name);
  const base = dirOf(ownerPart);
  for (const rel of Array.from(doc.getElementsByTagNameNS(NS_REL_PART, "Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target || rel.getAttribute("TargetMode") === "External") continue;
    rels.set(id, { target: resolveTarget(base, target), type: rel.getAttribute("Type") ?? "" });
  }
  return rels;
}

/** Nearest ancestor `<p:sp>` of a paragraph, or null when the text lives in a table or a raw frame. */
function owningShape(node: Element): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.namespaceURI === NS_PRESENTATION && el.localName === "sp") return el;
  }
  return null;
}

/** True for the slide-number/date/footer placeholders we drop. */
function isFurniture(shape: Element | null): boolean {
  if (!shape) return false;
  for (const ph of Array.from(shape.getElementsByTagNameNS(NS_PRESENTATION, "ph"))) {
    if (FurniturePlaceholders.has(ph.getAttribute("type") ?? "")) return true;
  }
  return false;
}

/**
 * Text of one slide (or notes) part, one line per paragraph. Runs inside a paragraph are joined with
 * no separator — DrawingML splits `<a:t>` mid-word wherever formatting changes, so anything else
 * inserts spaces into the middle of words.
 */
function textOfPart(doc: Document): string {
  const lines: string[] = [];
  for (const para of Array.from(doc.getElementsByTagNameNS(NS_DRAWING, "p"))) {
    if (isFurniture(owningShape(para))) continue;
    const runs = Array.from(para.getElementsByTagNameNS(NS_DRAWING, "t"));
    const line = runs.map((r) => r.textContent ?? "").join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/** Accumulates output under a character budget, cutting only at whole-record boundaries. */
class Budget {
  private readonly chunks: string[] = [];
  private used = 0;
  /** Records that didn't fit. */
  dropped = 0;

  /** Appends a record if it fits whole; otherwise counts it as dropped. Returns false once full. */
  add(chunk: string): boolean {
    if (this.dropped > 0 || this.used + chunk.length > MaxTextChars) {
      this.dropped += 1;
      return false;
    }
    this.chunks.push(chunk);
    this.used += chunk.length;
    return true;
  }

  join(): string {
    return this.chunks.join("\n\n");
  }
}

/** Extract the text of a .pptx: slides in presentation order, with speaker notes kept separate. */
export async function extractPptx(file: File, name: string): Promise<string> {
  const parts = await readParts(
    file,
    name,
    (part) =>
      part.startsWith("ppt/") &&
      (part.endsWith(".xml") || part.endsWith(".rels")) &&
      !/\/(media|embeddings|fonts)\//.test(part) &&
      !/slideLayout|slideMaster|notesMaster|handoutMaster|theme|tableStyles|presProps|viewProps/.test(part),
  );

  const presentationXml = parts.get("ppt/presentation.xml");
  if (!presentationXml) throw new FileError("unreadable", name);
  const presentation = parseXml(presentationXml, name);
  const presentationRels = readRels(parts, "ppt/presentation.xml", name);

  // Presentation order comes from <p:sldIdLst>, never from the slideN.xml part numbers — reordering
  // a deck in PowerPoint rewrites the list and leaves the part names alone.
  const slideParts: string[] = [];
  for (const sldId of Array.from(presentation.getElementsByTagNameNS(NS_PRESENTATION, "sldId"))) {
    const relId = sldId.getAttributeNS(NS_REL_ATTR, "id");
    const target = relId ? presentationRels.get(relId)?.target : undefined;
    if (target && parts.has(target)) slideParts.push(target);
  }
  if (!slideParts.length) throw new FileError("unreadable", name);

  const budget = new Budget();
  let withText = 0;

  slideParts.forEach((slidePart, i) => {
    const number = i + 1;
    const slideXml = parts.get(slidePart);
    if (!slideXml) return;
    const body = sanitizeExtractedText(textOfPart(parseXml(slideXml, name)));
    if (body) withText += 1;

    // Notes live in a part numbered independently of the slide, so it has to be resolved through
    // this slide's own rels rather than by matching numbers.
    let notes = "";
    for (const rel of readRels(parts, slidePart, name).values()) {
      if (!rel.type.endsWith("/notesSlide")) continue;
      const notesXml = parts.get(rel.target);
      if (notesXml) notes = sanitizeExtractedText(textOfPart(parseXml(notesXml, name)));
      break;
    }

    const sections = [
      `## Slide ${number}`,
      body || "[no extractable text — this slide is an image, chart, or diagram]",
    ];
    if (notes) sections.push(`### Speaker notes (slide ${number})`, notes);
    budget.add(sections.join("\n"));
  });

  if (!withText) throw new FileError("no-text", name);

  const total = slideParts.length;
  const shown = total - budget.dropped;
  const preamble =
    `[Text extracted from the PowerPoint file "${name}" — ${total} slide${total === 1 ? "" : "s"}, ` +
    `${withText} of which contained text. Only text was extracted: charts, diagrams, SmartArt, ` +
    `images, and any text inside a picture are NOT included, and neither is the slide layout. Do ` +
    `not state or infer numbers, trends, or visual content that is not written below. If the user ` +
    `asks about something that would live in a chart or an image, say the extract does not contain ` +
    `it and offer to read a PDF export of the deck instead.]`;
  const truncation = !budget.dropped
    ? ""
    : shown > 0
      ? `\n\n[TRUNCATED: slides 1-${shown} of ${total} are included. Slides ${shown + 1}-${total} were ` +
        `cut to fit and are not available — tell the user if they ask about them.]`
      : `\n\n[TRUNCATED: this deck is too long to include — none of its ${total} slides fit. Tell the ` +
        `user the extract is empty and ask them for a shorter excerpt or a PDF export.]`;

  return `${preamble}\n\n${budget.join()}${truncation}`;
}

/** Spreadsheet column index (0-based) → `A`, `B`, … `AA`. */
function columnLetter(index: number): string {
  let out = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    out = String.fromCharCode(65 + (n % 26)) + out;
  }
  return out;
}

/** One cell → a TSV-safe string. Dates arrive as Date objects, so they never reach the model as the
 *  bare serial numbers Excel actually stores. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).replace(/[\t\r\n]+/g, " ").trim();
}

/** Extract the text of a .xlsx: one TSV block per sheet, in tab order. */
export async function extractXlsx(file: File, name: string): Promise<string> {
  // read-excel-file opens the archive itself, so measure the parts it will inflate first and refuse
  // a bomb before handing the file over. Nothing is unpacked by this pass.
  await readParts(file, name, (part) => part.startsWith("xl/") && part.endsWith(".xml"), false);

  const readXlsxFile = (await import("read-excel-file/browser")).default;
  let sheets;
  try {
    sheets = await readXlsxFile(file);
  } catch {
    throw new FileError("unreadable", name);
  }
  if (!sheets.length) throw new FileError("no-text", name);

  const budget = new Budget();
  let withData = 0;

  for (const { sheet, data } of sheets) {
    const rows = data.map((row) => row.map(cellText));
    while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
    const width = rows.reduce((w, row) => {
      let last = 0;
      row.forEach((c, i) => {
        if (c) last = i + 1;
      });
      return Math.max(w, last);
    }, 0);

    if (!rows.length || !width) {
      budget.add(`## Sheet: ${sheet}\n[empty]`);
      continue;
    }
    withData += 1;
    const body = rows.map((row) => row.slice(0, width).join("\t").replace(/\t+$/, "")).join("\n");
    const range = `[rows 1-${rows.length}, columns A-${columnLetter(width - 1)}; row 1 is treated as the header]`;
    budget.add(sanitizeExtractedText(`## Sheet: ${sheet}\n${range}\n${body}`));
  }

  if (!withData) throw new FileError("no-text", name);

  const total = sheets.length;
  const shown = total - budget.dropped;
  const preamble =
    `[Text extracted from the Excel file "${name}" — ${total} sheet${total === 1 ? "" : "s"}, ` +
    `tab-separated, one block per sheet. Cell values only: every number below is the value Excel ` +
    `last cached, with no formula behind it, and charts, images, formatting, and comments are NOT ` +
    `included. Do not state or infer visual content. If the user asks about a chart, say the ` +
    `extract does not contain it and offer to read a PDF export of the workbook instead.]`;
  const truncation = budget.dropped
    ? `\n\n[TRUNCATED: ${shown} of ${total} sheets are included. The remaining ${budget.dropped} were ` +
      `cut to fit and are not available — tell the user if they ask about them.]`
    : "";

  return `${preamble}\n\n${budget.join()}${truncation}`;
}
