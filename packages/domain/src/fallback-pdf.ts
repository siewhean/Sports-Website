import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { assertPublicProjectionPrivacy } from "./public-truth.js";
import type { EmergencyScoreSheet, ScheduleFallbackDocument, ScoreSheetSection } from "./fallback-exports.js";

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 40;
const lineHeight = 14;
const bottomMargin = 46;

type PdfLine = Readonly<{
  text: string;
  size?: number;
  indent?: number;
  gapBefore?: number;
  bold?: boolean;
}>;

function ascii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\x20-\x7e]/gu, "?")
    .replace(/\s+/gu, " ")
    .trim();
}

function wrap(value: string, maximumCharacters: number): string[] {
  const words = ascii(value).split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maximumCharacters) {
      if (current) lines.push(current);
      current = "";
      for (let index = 0; index < word.length; index += maximumCharacters) {
        lines.push(word.slice(index, index + maximumCharacters));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maximumCharacters) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function lineHeightFor(line: PdfLine): number {
  return Math.max(lineHeight, (line.size ?? 10) + 4);
}

function pagination(lines: readonly PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let y = pageHeight - margin;
  for (const line of lines) {
    const height = lineHeightFor(line) + (line.gapBefore ?? 0);
    if (page.length > 0 && y - height < bottomMargin) {
      pages.push(page);
      page = [];
      y = pageHeight - margin;
    }
    page.push(line);
    y -= height;
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

function drawPage(
  page: PDFPage,
  lines: readonly PdfLine[],
  pageNumber: number,
  pageCount: number,
  regular: PDFFont,
  bold: PDFFont,
): void {
  let y = pageHeight - margin;
  for (const line of lines) {
    y -= line.gapBefore ?? 0;
    page.drawText(ascii(line.text), {
      x: margin + (line.indent ?? 0),
      y,
      size: line.size ?? 10,
      font: line.bold ? bold : regular,
      color: rgb(0, 0, 0),
    });
    y -= lineHeightFor(line);
  }
  page.drawText(`Page ${pageNumber} of ${pageCount}`, {
    x: margin,
    y: 26,
    size: 8,
    font: regular,
    color: rgb(0, 0, 0),
  });
}

async function render(lines: readonly PdfLine[], title: string, generatedAt: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const generated = new Date(generatedAt);
  document.setTitle(ascii(title));
  document.setAuthor("Matchday");
  document.setCreator("Matchday fallback document renderer");
  document.setProducer("Matchday fallback document renderer");
  document.setCreationDate(generated);
  document.setModificationDate(generated);

  const pages = pagination(lines);
  pages.forEach((pageLines, index) => {
    drawPage(document.addPage([pageWidth, pageHeight]), pageLines, index + 1, pages.length, regular, bold);
  });
  return document.save({ addDefaultPage: false, useObjectStreams: false, updateFieldAppearances: false });
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
    { text: `${input.sport.replaceAll("_", " ")} | ${input.timezone}`, size: 9 },
    {
      text: `Schedule v${input.scheduleVersion} | Results v${input.resultVersion} | Generated ${input.generatedAt}`,
      size: 8,
    },
    { text: `Source ${input.sourceFingerprint}`, size: 7 },
  ];
}

export async function renderScheduleFallbackPdf(document: ScheduleFallbackDocument): Promise<Uint8Array> {
  assertPublicProjectionPrivacy(document);
  const lines: PdfLine[] = [
    { text: document.competitionName, size: 19, bold: true },
    { text: "Published competition schedule", size: 13, bold: true },
    ...metadataLines(document),
    { text: `Verify: ${document.publicVerificationUrl}`, size: 8, gapBefore: 4 },
  ];

  for (const division of document.divisions) {
    lines.push({ text: division.divisionName, size: 15, bold: true, gapBefore: 14 });
    lines.push({ text: "Code | Stage | Participants | Start - End | Playing area", size: 8, bold: true });
    for (const match of division.matches) {
      const participants = `${match.home.displayName || "TBD"} vs ${match.away.displayName || "TBD"}`;
      const value = `${match.matchCode} | ${match.stage} | ${participants} | ${match.startsAt} - ${match.endsAt} | ${match.playingArea}`;
      for (const [index, part] of wrap(value, 92).entries()) {
        lines.push({ text: part, size: 9, indent: index === 0 ? 0 : 12 });
      }
    }
  }
  return render(lines, document.competitionName, document.generatedAt);
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
    { text: `Sheet ID: ${sheet.sheetIdentifier}`, size: 8, gapBefore: 4 },
    { text: `${match.divisionName} | ${match.matchCode} | ${match.stage}`, size: 13, bold: true, gapBefore: 12 },
    { text: `${match.home.displayName || "TBD"} vs ${match.away.displayName || "TBD"}`, size: 16, bold: true },
    { text: `${match.startsAt} - ${match.endsAt} | ${match.playingArea}`, size: 9 },
  ];
  for (const section of sheet.sections) lines.push(...scoreSheetRows(section));
  return render(lines, `${sheet.competitionName} score sheet`, sheet.generatedAt);
}
