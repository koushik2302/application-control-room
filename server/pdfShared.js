// Shared PDF styling for resume.js and coverLetter.js -- one visual
// identity (fonts, gold accent, ASCII-safety) across every document this
// app generates, so a resume and its cover letter always look like they
// came from the same place.
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./store.js";
import { baseDir } from "./paths.js";

export const DOCS_DIR = path.join(DATA_DIR, "resumes");

export const FONT_REGULAR = "Arial";
export const FONT_BOLD = "Arial-Bold";
export const FONT_ITALIC = "Arial-Italic";

// Matches the portfolio site's --accent brand color (see Portfolio/index.html).
export const GOLD = "#9c7a3f"; // deepened from the site's #c8a96e for legibility as small print text
export const INK = "#000";
export const BODY_INK = "#222";

// PDFKit's standard "Helvetica"/"Helvetica-Bold" are the PDF spec's built-in
// base-14 fonts -- most viewers substitute a system sans for them, but that's
// a viewer convention, not a guarantee, and they also depend on .afm metrics
// files that pkg's bundler doesn't reliably embed (confirmed: assets glob in
// package.json silently produced zero matches, likely because the project
// path contains literal parentheses that break pkg's internal glob
// matching). Registering the real Arial TTFs sidesteps both problems: an
// explicit, guaranteed typeface (matching the portfolio resume's ArialMT),
// read from a plain file next to the exe via `baseDir` (the same proven
// mechanism already used for data/dist/.env), never through pkg's
// snapshot/asset machinery.
export const FONTS_DIR = path.join(baseDir, "fonts");

export function registerFonts(doc) {
  const regularPath = path.join(FONTS_DIR, "Arial-Regular.ttf");
  const boldPath = path.join(FONTS_DIR, "Arial-Bold.ttf");
  const italicPath = path.join(FONTS_DIR, "Arial-Italic.ttf");
  // Falls back to PDFKit's built-in standard fonts if the TTFs aren't
  // present (dev environments that haven't pulled assets/fonts, or an old
  // release built before this) rather than hard-failing PDF generation.
  if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
    doc.registerFont(FONT_REGULAR, regularPath);
    doc.registerFont(FONT_BOLD, boldPath);
    doc.registerFont(FONT_ITALIC, fs.existsSync(italicPath) ? italicPath : regularPath);
  } else {
    doc.registerFont(FONT_REGULAR, "Helvetica");
    doc.registerFont(FONT_BOLD, "Helvetica-Bold");
    doc.registerFont(FONT_ITALIC, "Helvetica-Oblique");
  }
}

// PDFKit's standard (non-embedded) fonts only cover WinAnsi-ish Latin-1 --
// accented letters, smart quotes, and separators like a bullet or middot
// silently vanish into unmapped-glyph garbage in the extracted text layer
// (confirmed with pdftotext: an accented o in "Corporacion" came out as a
// replacement-char glyph). Normalize anything going into the PDF to plain
// ASCII so the text layer is always clean, which matters for ATS parsers
// reading that layer directly.
export function asciiSafe(s) {
  if (!s) return s;
  const curlyQuotes = new RegExp("[‘’]", "g");
  const curlyDoubleQuotes = new RegExp("[“”]", "g");
  const dashes = new RegExp("[–—]", "g");
  const dots = new RegExp("[·•]", "g");
  const combiningMarks = new RegExp("[̀-ͯ]", "g");
  const nonAscii = new RegExp("[^\\x00-\\x7F]", "g");
  return s
    .replace(curlyQuotes, "'")
    .replace(curlyDoubleQuotes, '"')
    .replace(dashes, "-")
    .replace(dots, "-")
    .normalize("NFKD")
    .replace(combiningMarks, "")
    .replace(nonAscii, "");
}

// Filesystem/URL-safe company slug for document filenames, e.g. "P&G
// Careers India" -> "PG-Careers-India". Falls back to "Company" so a blank
// or all-punctuation name never collapses the filename to just the ticket id.
export function companySlug(company) {
  const slug = (company || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug || "Company";
}

export function docToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
