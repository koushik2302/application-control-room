// Generates a cover letter PDF per ticket, visually matching resume.js (same
// Arial/gold identity via pdfShared.js) so a resume and its cover letter
// always look like a pair. Body paragraphs come from llm.js's
// draftCoverLetter() -- this module is purely the rendering side.
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import {
  DOCS_DIR,
  FONT_REGULAR,
  FONT_BOLD,
  GOLD,
  INK,
  BODY_INK,
  FONTS_DIR,
  registerFonts,
  asciiSafe,
  companySlug,
  docToBuffer,
} from "./pdfShared.js";
import { draftCoverLetter } from "./llm.js";

function coverLetterFileName(ticket) {
  return `${ticket.id}-CoverLetter-${companySlug(ticket.company)}.pdf`;
}

export function coverLetterFilePath(ticket) {
  return path.join(DOCS_DIR, coverLetterFileName(ticket));
}

export function coverLetterUrl(ticket) {
  return `/resumes/${coverLetterFileName(ticket)}`;
}

function renderDoc(profile, ticket, paragraphs) {
  const regularPath = path.join(FONTS_DIR, "Arial-Regular.ttf");
  const initialFont = fs.existsSync(regularPath) ? regularPath : undefined;
  const doc = new PDFDocument({ margin: 56, bufferPages: true, ...(initialFont ? { font: initialFont } : {}) });
  registerFonts(doc);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Header block -- same treatment as resume.js: bold name, gold contact
  // links, thin gold rule -- so the two documents read as a matched pair.
  doc.font(FONT_BOLD).fontSize(16).fillColor(INK).text(asciiSafe(profile.name) || "Cover Letter");
  doc.moveDown(0.2);
  const contactLine = [profile.email, profile.phone, profile.location].filter(Boolean).join("  |  ");
  if (contactLine) {
    doc.font(FONT_REGULAR).fontSize(9.5).fillColor("#333").text(asciiSafe(contactLine));
  }
  const linksLine = [profile.linkedin, profile.github, profile.portfolio].filter(Boolean).join("  |  ");
  if (linksLine) {
    doc.font(FONT_REGULAR).fontSize(9.5).fillColor(GOLD).text(asciiSafe(linksLine));
  }
  doc.moveDown(0.5);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(0.75)
    .strokeColor(GOLD)
    .stroke();
  doc.moveDown(1);

  const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  doc.font(FONT_REGULAR).fontSize(10.5).fillColor(BODY_INK).text(asciiSafe(dateStr));
  doc.moveDown(1);

  const company = ticket.company && ticket.company !== "—" ? ticket.company : "Hiring Team";
  doc.font(FONT_REGULAR).fontSize(10.5).fillColor(BODY_INK).text(asciiSafe(`Dear ${company} Hiring Team,`));
  doc.moveDown(1);

  paragraphs.forEach((p) => {
    doc.font(FONT_REGULAR).fontSize(10.5).fillColor(BODY_INK).text(asciiSafe(p), doc.page.margins.left, doc.y, {
      width: contentWidth,
      lineGap: 2.5,
      align: "justify",
    });
    doc.moveDown(0.8);
  });

  doc.moveDown(0.3);
  doc.font(FONT_REGULAR).fontSize(10.5).fillColor(BODY_INK).text("Sincerely,");
  doc.moveDown(0.6);
  doc.font(FONT_BOLD).fontSize(10.5).fillColor(BODY_INK).text(asciiSafe(profile.name) || "");

  return doc;
}

// Drafts the letter body via llm.js, renders it, and writes the PDF.
// Cleans up any previous cover letter file for this ticket (a re-tailor or
// company-name edit changes the filename) the same way resume.js does,
// scoped to "-CoverLetter-" filenames only so it never touches that
// ticket's resume.
export async function generateCoverLetterPdf({ profile, ticket }) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const filePath = coverLetterFilePath(ticket);

  for (const f of fs.readdirSync(DOCS_DIR)) {
    if (!f.includes("-CoverLetter-")) continue;
    if (f.startsWith(`${ticket.id}-CoverLetter-`) && f !== path.basename(filePath)) {
      fs.unlinkSync(path.join(DOCS_DIR, f));
    }
  }

  const paragraphs = await draftCoverLetter({ profile, ticket });
  if (!paragraphs.length) return null; // no JD/context to draft from yet -- nothing to render

  const doc = renderDoc(profile, ticket, paragraphs);
  const buffer = await docToBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return coverLetterUrl(ticket);
}

// Regenerates every ticket's cover letter against the given profile --
// sibling to resume.js's regenerateAllResumes(), same "never goes stale"
// guarantee. Tickets with no JD/company context yet just get coverLetterUrl
// left unset (generateCoverLetterPdf returns null for those).
export async function regenerateAllCoverLetters({ profile, tickets }) {
  const next = [];
  for (const ticket of tickets) {
    const url = await generateCoverLetterPdf({ profile, ticket });
    next.push(url ? { ...ticket, coverLetterUrl: url } : ticket);
  }
  return next;
}
