import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { assertPublicProjectionPrivacy } from "./public-truth.js";
import type { EmergencyScoreSheet, ScheduleFallbackDocument, ScoreSheetSection } from "./fallback-exports.js";

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 40;
const bottomMargin = 48;
const footerY = 25;
const defaultLineHeight = 14;
const textColour = rgb(0.08, 0.1, 0.09);
const mutedColour = rgb(0.32, 0.36, 0.33);
const ruleColour = rgb(0.78, 0.81, 0.79);

type PdfLine = Readonly<{
  text: string;
  size?: number;
  indent?: number;
  gapBefore?: number;
  bold?: boolean;
  muted?: boolean;
}>;

type PreparedLine = PdfLine & Readonly<{ height: number }>;

type PdfMetadata = Readonly<{
  title: string;
  subject: string;
  generatedAt: string;
}>;

type FontSet = Readonly<{
  regular: PDFFont;
  bold: PDFFont;
}>;

function printableText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[–—]/gu, "-")
    .replace(/[•·]/gu, "|")
    .replace(/→/gu, "->")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[^\x20-\x7e]/gu, "?")
    .replace(/\s+/gu, " ")
    .trim();
}

function fontFor(line: PdfLine, fonts: FontSet): PDFFont {
  return line.bold ? fonts.bold : fonts.regular;
}

function width(value: string, font: PDFFont, size: number): number {
  return font.widthOfTextAtSize(value || " ", size);
}

function splitOversizedWord(word: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = current + character;
    if (current && width(candidate, font, size) > maximumWidth) {
      parts.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [""];
}

function wrap(value: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const normalized = printableText(value);
  if (!normalized) return [""];
  const output: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    if (width(word, font, size) > maximumWidth) {
      if (current) {
        output.push(current);
        current = "";
      }
      output.push(...splitOversizedWord(word, font, size, maximumWidth));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (current && width(candidate, font, size) > maximumWidth) {
      output.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) output.push(current);
  return output.length ? output : [""];
}

function prepare(lines: readonly PdfLine[], fonts: FontSet): PreparedLine[] {
  const prepared: PreparedLine[] = [];
  for (const line of lines) {
    const size = line.size ?? 10;
    const indent = line.indent ?? 0;
    const maximumWidth = pageWidth - margin * 2 - indent;
    const wrapped = wrap(line.text, fontFor(line, fonts), size, maximumWidth);
    for (const [index, text] of wrapped.entries()) {
      prepared.push({
        ...line,
        text,
        indent,
        gapBefore: index === 0 ? (line.gapBefore ?? 0) : 0,
        height: Math.max(defaultLineHeight, size + 4),
      });
    }
  }
  return prepared;
}

function paginate(lines: readonly PreparedLine[]): PreparedLine[][] {
  const pages: PreparedLine[][] = [];
  let page: PreparedLine[] = [];
  let y = pageHeight - margin;
  for (const line of lines) {
    const requiredHeight = line.height + (line.gapBefore ?? 0);
    if (page.length > 0 && y - requiredHeight < bottomMargin) {
      pages.push(page);
      page = [];
      y = pageHeight - margin;
    }
    page.push(line);
    y -= requiredHeight;
  }
  if (page.length || pages.length === 0) pages.push(page);
  return pages;
}

function drawPage(
  page: PDFPage,
  lines: readonly PreparedLine[],
  fonts: FontSet,
  pageNumber: number,
  pageCount: number,
): void {
  let y = pageHeight - margin;
  for (const line of lines) {
    y -= line.gapBefore ?? 0;
    const size = line.size ?? 10;
    page.drawText(line.text, {
      x: margin + (line.indent ?? 0),
      y: y - size,
      size,
      font: fontFor(line, fonts),
      color: line.muted ? mutedColour : textColour,
    });
    y -= line.height;
  }
  page.drawLine({
    start: { x: margin, y: footerY + 12 },
    end: { x: pageWidth - margin, y: footerY + 12 },
    thickness: 0.5,
    color: ruleColour,
  });
  page.drawText(`Page ${pageNumber} of ${pageCount}`, {
    x: margin,
    y: footerY,
    size: 8,
    font: fonts.regular,
    color: mutedColour,
  });
}

async function render(lines: readonly PdfLine[], metadata: PdfMetadata): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const fonts: FontSet = { regular, bold };
  const generatedAt = new Date(metadata.generatedAt);
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("Fallback PDF generation time is invalid");

  document.setTitle(printableText(metadata.title));
  document.setSubject(printableText(metadata.subject));
  document.setAuthor("Matchday");
  document.setCreator("Matchday Gate C4 fallback exporter");
  document.setProducer("Matchday Gate C4 pdf-lib renderer 1");
  document.setKeywords(["matchday", "gate-c4", "fallback", "published"]);
  document.setCreationDate(generatedAt);
  document.setModificationDate(generatedAt);

  const pages = paginate(prepare(lines, fonts));
  for (const [index, pageLines] of pages.entries()) {
    const page = document.addPage([pageWidth, pageHeight]);
    drawPage(page, pageLines, fonts, index + 1, pages.length);
  }

  return document.save({
    addDefaultPage: false,
    useObjectStreams: false,
    objectsPerTick: Number.MAX_SAFE_INTEGER,
    updateFieldAppearances: false,
  });
}

function metadataLines(input: {
  sport: string;
  timezone: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  sourceFingerprint: string;
}): PdfLine[] {
  return [
    { text: `${input.sport.replaceAll("_", " ")} | ${input.timezone}`, size: 9, muted: true },
    {
      text: `Schedule v${input.scheduleVersion} | Results v${input.resultVersion} | Generated ${input.generatedAt}`,
      size: 8,
      muted: true,
    },
    { text: `Source ${input.sourceFingerprint}`, size: 7, muted: true },
  ];
}

export async function renderScheduleFallbackPdf(document: ScheduleFallbackDocument): Promise<Uint8Array> {
  assertPublicProjectionPrivacy(document);
  const lines: PdfLine[] = [
    { text: document.competitionName, size: 19, bold: true },
    { text: "Published competition schedule", size: 13, bold: true },
    ...metadataLines(document),
    { text: `Verify: ${document.publicVerificationUrl}`, size: 8, gapBefore: 4, muted: true },
  ];

  for (const division of document.divisions) {
    lines.push({ text: division.divisionName, size: 15, bold: true, gapBefore: 14 });
    lines.push({ text: "Code | Stage | Participants | Start - End | Playing area", size: 8, bold: true });
    for (const match of division.matches) {
      const participants = `${match.home.displayName || "TBD"} vs ${match.away.displayName || "TBD"}`;
      lines.push({
        text: `${match.matchCode} | ${match.stage} | ${participants} | ${match.startsAt} - ${match.endsAt} | ${match.playingArea}`,
        size: 9,
      });
    }
  }

  return render(lines, {
    title: `${document.competitionName} published schedule`,
    subject: `Schedule version ${document.scheduleVersion}, result version ${document.resultVersion}`,
    generatedAt: document.generatedAt,
  });
}

function scoreSheetRows(section: ScoreSheetSection): PdfLine[] {
  const rows: PdfLine[] = [
    { text: section.label, size: 12, bold: true, gapBefore: 12 },
    { text: section.columns.join(" | "), size: 8, bold: true },
  ];
  const count = section.repeatable ? 5 : 2;
  for (let index = 0; index < count; index += 1) {
    rows.push({
      text: `${String(index + 1).padStart(2, "0")}  ${section.columns.map(() => "________________").join(" | ")}`,
      size: 8,
    });
  }
  return rows;
}

export async function renderEmergencyScoreSheetPdf(sheet: EmergencyScoreSheet): Promise<Uint8Array> {
  assertPublicProjectionPrivacy(sheet);
  const match = sheet.match;
  const lines: PdfLine[] = [
    { text: sheet.competitionName, size: 19, bold: true },
    { text: "Emergency match score sheet", size: 13, bold: true },
    ...metadataLines(sheet),
    { text: `Sheet ID: ${sheet.sheetIdentifier}`, size: 8, gapBefore: 4, muted: true },
    { text: `${match.divisionName} | ${match.matchCode} | ${match.stage}`, size: 13, bold: true, gapBefore: 12 },
    { text: `${match.home.displayName || "TBD"} vs ${match.away.displayName || "TBD"}`, size: 16, bold: true },
    { text: `${match.startsAt} - ${match.endsAt} | ${match.playingArea}`, size: 9, muted: true },
  ];

  for (const section of sheet.sections) lines.push(...scoreSheetRows(section));
  return render(lines, {
    title: `${sheet.competitionName} ${match.matchCode} emergency score sheet`,
    subject: `Schedule version ${sheet.scheduleVersion}, result version ${sheet.resultVersion}`,
    generatedAt: sheet.generatedAt,
  });
}
