import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { splitLines, parseEntries } from "./textBlocks.js";
import {
  DOCS_DIR as RESUME_DIR,
  FONT_REGULAR,
  FONT_BOLD,
  FONT_ITALIC,
  GOLD,
  INK,
  BODY_INK,
  FONTS_DIR,
  registerFonts,
  asciiSafe,
  companySlug,
  docToBuffer,
} from "./pdfShared.js";

// Prefers this ticket's JD-rewritten entries (bullets reworded in the JD's
// language, but structurally locked to the same entry they came from -- see
// llm.js's applyEntryRewrites guardrail) over the raw profile text. Falls
// back to the profile's real entries for a ticket that predates this
// feature, or if tailoring produced nothing for that field.
function experienceEntries(profile, ticket) {
  return ticket.tailoredEntries?.experience?.length
    ? ticket.tailoredEntries.experience
    : parseEntries(profile.experience);
}

function projectEntries(profile, ticket) {
  return ticket.tailoredEntries?.projects?.length ? ticket.tailoredEntries.projects : parseEntries(profile.projects);
}

function entriesToLines(entries) {
  return entries.flatMap((e) => [e.title, ...e.bullets]);
}

// Parses profile.skills' "Category: item, item, ..." lines (one category per
// line) into {label, items} pairs, so the renderer can bold just the
// category label the way the portfolio resume does. A line with no ":"
// becomes an unlabeled category (label "") so old flat comma-list skills
// data still renders instead of silently disappearing.
function skillsCategories(text) {
  return splitLines(text).map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return { label: "", items: line };
    return { label: line.slice(0, idx).trim(), items: line.slice(idx + 1).trim() };
  });
}

function resumeFileName(ticket) {
  return `${ticket.id}-${companySlug(ticket.company)}.pdf`;
}

export function resumeFilePath(ticket) {
  return path.join(RESUME_DIR, resumeFileName(ticket));
}

export function resumeUrl(ticket) {
  return `/resumes/${resumeFileName(ticket)}`;
}

// Progressively denser layouts, tried in order until the content fits on one
// page. A resume that spills onto page 2 mostly doesn't get read past page 1.
const DENSITY_STEPS = [
  // Measured against the real renderer (not estimated): the largest sizing
  // that still holds one page for the current profile, landing at ~97.6%
  // page fill with headroom before the 100%-fill boundary that measurably
  // overflows to page 2.
  { margin: 53, name: 20.7, header: 12.2, body: 10.2, bulletGap: 2.7, sectionGap: 0.95 },
  { margin: 46, name: 19, header: 12, body: 10, bulletGap: 0.5, sectionGap: 0.7 },
  { margin: 40, name: 17, header: 11, body: 9.3, bulletGap: 1.5, sectionGap: 0.45 },
  { margin: 34, name: 16, header: 10.5, body: 8.6, bulletGap: 1, sectionGap: 0.3 },
  { margin: 28, name: 15, header: 10, body: 8, bulletGap: 0, sectionGap: 0.2 },
  { margin: 24, name: 14, header: 9.5, body: 7.5, bulletGap: 0, sectionGap: 0.12 },
];

function renderDoc(profile, ticket, sizes) {
  // PDFDocument's constructor loads a default font immediately (Helvetica,
  // unless told otherwise) -- pass our own TTF as the initial font so that
  // eager load hits our registered file instead of PDFKit's standard-font
  // .afm data, which may not exist as a real file in a packaged exe.
  const regularPath = path.join(FONTS_DIR, "Arial-Regular.ttf");
  const initialFont = fs.existsSync(regularPath) ? regularPath : undefined;
  const doc = new PDFDocument({ margin: sizes.margin, bufferPages: true, ...(initialFont ? { font: initialFont } : {}) });
  registerFonts(doc);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font(FONT_BOLD).fontSize(sizes.name).fillColor(INK).text(asciiSafe(profile.name) || "Resume");

  if (profile.tagline) {
    doc.moveDown(0.1);
    doc.font(FONT_ITALIC).fontSize(sizes.body + 0.5).fillColor(GOLD).text(asciiSafe(profile.tagline));
  }
  doc.moveDown(0.15);

  const contactLine = [profile.email, profile.phone, profile.location].filter(Boolean).join("  |  ");
  if (contactLine) {
    doc.font(FONT_REGULAR).fontSize(sizes.body).fillColor("#333").text(asciiSafe(contactLine));
  }
  const linksLine = [profile.linkedin, profile.github, profile.portfolio].filter(Boolean).join("  |  ");
  if (linksLine) {
    doc.font(FONT_REGULAR).fontSize(sizes.body).fillColor(GOLD).text(asciiSafe(linksLine));
  }
  doc.moveDown(sizes.sectionGap / 2);

  // Thin gold rule under the header block, mirroring the portfolio resume's
  // section-divider treatment.
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(0.75)
    .strokeColor(GOLD)
    .stroke();
  doc.moveDown(sizes.sectionGap);

  // PDFKit's `indent` option only shifts the first line of a paragraph --
  // once a bullet wraps, the continuation line snaps back to the page
  // margin instead of staying under the bullet, producing a ragged left
  // edge. Position the text box explicitly instead so every line (first and
  // wrapped) shares the same left edge and width.
  const bulletIndent = 10;
  const contentLeft = doc.page.margins.left + bulletIndent;
  const bulletWidth = contentWidth - bulletIndent;

  // A gold, bold section title with a thin gold rule underneath -- shared by
  // every section (Education/Experience/Projects/Skills/Certifications) so
  // the accent treatment stays consistent throughout.
  const sectionTitle = (title) => {
    doc.font(FONT_BOLD).fontSize(sizes.header).fillColor(GOLD).text(title, doc.page.margins.left, doc.y);
    const ruleY = doc.y + 1;
    doc
      .moveTo(doc.page.margins.left, ruleY)
      .lineTo(doc.page.width - doc.page.margins.right, ruleY)
      .lineWidth(0.5)
      .strokeColor(GOLD)
      .stroke();
    doc.moveDown(sizes.bulletGap / 6 + 0.3);
  };

  // `bulleted: false` renders plain lines (Education, Certifications) --
  // `bulleted: true` (the default) renders a "- " prefix per line
  // (Experience/Projects bullets).
  const section = (title, lines, { bulleted = true } = {}) => {
    if (!lines || lines.length === 0) return;
    sectionTitle(title);
    doc.font(FONT_REGULAR).fontSize(sizes.body).fillColor(BODY_INK);
    lines.forEach((l) => {
      const text = bulleted ? `- ${asciiSafe(l)}` : asciiSafe(l);
      const [left, width] = bulleted ? [contentLeft, bulletWidth] : [doc.page.margins.left, contentWidth];
      doc.text(text, left, doc.y, { width, lineGap: sizes.bulletGap, align: "justify" });
    });
    doc.moveDown(sizes.sectionGap);
  };

  section("Education", splitLines(profile.education), { bulleted: false });
  section("Experience", entriesToLines(experienceEntries(profile, ticket)));
  section("Projects", entriesToLines(projectEntries(profile, ticket)));

  const skills = skillsCategories(profile.skills);
  if (skills.length) {
    sectionTitle("Skills");
    skills.forEach(({ label, items }) => {
      if (label) {
        doc.font(FONT_BOLD).fontSize(sizes.body).fillColor(BODY_INK).text(`${asciiSafe(label)}: `, doc.page.margins.left, doc.y, {
          width: contentWidth,
          lineGap: sizes.bulletGap,
          continued: true,
        });
        doc.font(FONT_REGULAR).fillColor(BODY_INK).text(asciiSafe(items), { lineGap: sizes.bulletGap });
      } else {
        doc.font(FONT_REGULAR).fontSize(sizes.body).fillColor(BODY_INK).text(asciiSafe(items), doc.page.margins.left, doc.y, {
          width: contentWidth,
          lineGap: sizes.bulletGap,
        });
      }
    });
    doc.moveDown(sizes.sectionGap);
  }

  section("Certifications", splitLines(profile.certifications), { bulleted: false });

  return doc;
}

// Renders a resume with Experience/Projects bullets rewritten in this
// ticket's JD language where genuinely applicable (see llm.js's tailor(),
// which rewrites each entry's bullets in place with a same-count guardrail
// per entry -- an earlier fuzzy-matched approach risked attaching a
// rewritten bullet to the wrong job entry; this can't, since each entry's
// rewrite is keyed by its own position, never merged across entries).
// Education/Skills/Certifications are never rewritten (profile.summary is
// not rendered in the PDF at all -- the tagline covers that role visually --
// but still feeds tailor()'s prompt as candidate context). Falls back to the profile's
// real entries verbatim for tickets that predate tailoredEntries. Tries
// progressively denser layouts to fit one page.
export async function generateResumePdf({ profile, ticket }) {
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  const filePath = resumeFilePath(ticket);

  // A re-tailor or a company-name edit changes the filename -- clean up any
  // previously-written file(s) for this ticket id (including the old
  // "<id>.pdf" naming from before company names were added) so renames
  // don't leave orphaned PDFs behind in the resumes folder. Excludes
  // "-CoverLetter-" filenames -- coverLetter.js writes to this same
  // directory, and without this guard a resume regeneration would delete
  // that ticket's cover letter too (both filenames start with the same
  // "<id>-" prefix).
  for (const f of fs.readdirSync(RESUME_DIR)) {
    if (f.includes("-CoverLetter-")) continue;
    const isOldFormat = f === `${ticket.id}.pdf`;
    const isNewFormat = f.startsWith(`${ticket.id}-`) && f.endsWith(".pdf");
    if ((isOldFormat || isNewFormat) && f !== path.basename(filePath)) {
      fs.unlinkSync(path.join(RESUME_DIR, f));
    }
  }

  let doc;
  for (let i = 0; i < DENSITY_STEPS.length; i++) {
    doc = renderDoc(profile, ticket, DENSITY_STEPS[i]);
    const pageCount = doc.bufferedPageRange().count;
    if (process.env.ACR_DEBUG_RESUME) {
      console.log(`[resume] tier ${i} (${JSON.stringify(DENSITY_STEPS[i])}) -> ${pageCount} page(s), doc.y=${doc.y}`);
    }
    if (pageCount <= 1 || i === DENSITY_STEPS.length - 1) break;
  }

  const buffer = await docToBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return resumeUrl(ticket);
}

// Regenerates every ticket's resume PDF against the given profile -- used so
// a profile edit (new contact info, education, a tweak to the layout code)
// never leaves stale resumes sitting next to tracker entries. Returns a new
// tickets array with resumeUrl refreshed on each one.
export async function regenerateAllResumes({ profile, tickets }) {
  const next = [];
  for (const ticket of tickets) {
    const url = await generateResumePdf({ profile, ticket });
    next.push({ ...ticket, resumeUrl: url });
  }
  return next;
}
