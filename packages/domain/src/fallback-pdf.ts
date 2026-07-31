import { assertPublicProjectionPrivacy } from "./public-truth.js";
import type { EmergencyScoreSheet, ScheduleFallbackDocument, ScoreSheetSection } from "./fallback-exports.js";

const pageWidth = 595;
const pageHeight = 842;
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

function pdfEscape(value: string): string {
  return ascii(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrap(value: string, maximumCharacters: number): string[] {
  const words = ascii(value).split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maximumCharacters) {
      if (current) {
        lines.push(current);
        current = "";
      }
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

function textOperation(line: PdfLine, y: number): string {
  const size = line.size ?? 10;
  const x = margin + (line.indent ?? 0);
  const font = line.bold ? "F2" : "F1";
  return `BT /${font} ${size} Tf 0 g ${x} ${y} Td (${pdfEscape(line.text)}) Tj ET\n`;
}

function pagination(lines: readonly PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let y = pageHeight - margin;
  for (const line of lines) {
    const gap = line.gapBefore ?? 0;
    const height = Math.max(lineHeight, (line.size ?? 10) + 4) + gap;
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

function pageStream(lines: readonly PdfLine[], pageNumber: number, pageCount: number): string {
  let y = pageHeight - margin;
  let stream = "";
  for (const line of lines) {
    y -= line.gapBefore ?? 0;
    stream += textOperation(line, y);
    y -= Math.max(lineHeight, (line.size ?? 10) + 4);
  }
  stream += textOperation({ text: `Page ${pageNumber} of ${pageCount}`, size: 8 }, 26);
  return stream;
}

function pdf(objects: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n%MATCHDAY\n";
  const chunks: Uint8Array[] = [encoder.encode(header)];
  const offsets = [0];
  let offset = chunks[0]!.byteLength;

  objects.forEach((object, index) => {
    offsets.push(offset);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${object}\nendobj\n`);
    chunks.push(chunk);
    offset += chunk.byteLength;
  });

  const xrefOffset = offset;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (let index = 1; index <= objects.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n `);
  }
  xref.push(
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  );
  chunks.push(encoder.encode(xref.join("\n")));

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

function render(lines: readonly PdfLine[]): Uint8Array {
  const pages = pagination(lines);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];
  const fixedObjectCount = 4;
  for (let index = 0; index < pages.length; index += 1) {
    pageObjectIds.push(fixedObjectCount + index * 2 + 1);
    contentObjectIds.push(fixedObjectCount + index * 2 + 2);
  }

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  pages.forEach((pageLines, index) => {
    const stream = pageStream(pageLines, index + 1, pages.length);
    const length = new TextEncoder().encode(stream).byteLength;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`,
    );
    objects.push(`<< /Length ${length} >>\nstream\n${stream}endstream`);
  });

  return pdf(objects);
}

function metadataLines(input: {
  competitionName: string;
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

export function renderScheduleFallbackPdf(document: ScheduleFallbackDocument): Uint8Array {
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

  return render(lines);
}

function scoreSheetRows(section: ScoreSheetSection): PdfLine[] {
  const rows: PdfLine[] = [
    { text: section.label, size: 12, bold: true, gapBefore: 12 },
    { text: section.columns.join(" | "), size: 8, bold: true },
  ];
  const count = section.repeatable ? 5 : 2;
  for (let index = 0; index < count; index += 1) {
    rows.push({ text: `${String(index + 1).padStart(2, "0")}  ${section.columns.map(() => "________________").join(" | ")}`, size: 8 });
  }
  return rows;
}

export function renderEmergencyScoreSheetPdf(sheet: EmergencyScoreSheet): Uint8Array {
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
  return render(lines);
}
