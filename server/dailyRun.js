import { getData, setTickets, appendRunLog, nextTicketId } from "./store.js";
import { search, tailor } from "./llm.js";
import { generateResumePdf } from "./resume.js";
import { generateCoverLetterPdf } from "./coverLetter.js";

const MATCH_THRESHOLD = 60;
const MAX_NEW_TICKETS_PER_QUERY = 3;
// The search-stage matchScore is a rough relevance estimate off a short
// snippet; tailor()'s matchScore is a real ATS-style score computed against
// the candidate's actual profile. A low tailored score even after search
// judged it relevant is a strong signal the "JD" was too vague/generic to
// tailor against meaningfully -- in practice this reliably flags generic
// company careers-landing pages (e.g. "IBM Internships", "Apprenticeships")
// that individually-specific-posting checks upstream didn't catch, since
// they're real company domains with plausible-looking titles.
const MIN_TAILORED_SCORE = 50;

function alreadySeen(tickets, r) {
  return tickets.some(
    (t) =>
      (t.sourceUrl && r.url && t.sourceUrl === r.url) ||
      (t.company?.toLowerCase() === (r.company || "").toLowerCase() &&
        t.role?.toLowerCase() === (r.role || "").toLowerCase())
  );
}

// Runs the full daily cycle: search every watchlist entry, tailor the best new
// matches against the saved profile, and log them as Draft tickets. Never
// submits anything — Draft is the end of the automated part.
export async function runDailyCycle({ trigger = "cron" } = {}) {
  const data = getData();
  const { profile, watchlist } = data;
  let tickets = [...data.tickets];

  const summary = { started: new Date().toISOString(), trigger, queries: [], added: 0, errors: [] };

  if (!watchlist.length) {
    summary.errors.push("Watchlist is empty — nothing to search for.");
  }
  if (!profile.experience && !profile.projects) {
    summary.errors.push("Profile has no experience/projects filled in — skipping tailoring.");
    appendRunLog({ ...summary, finished: new Date().toISOString() });
    return summary;
  }

  for (const w of watchlist) {
    const qSummary = { query: w.query, location: w.location, found: 0, added: 0, error: null };
    try {
      const results = await search({ profile, query: w.query, location: w.location });
      const candidates = (results.results || [])
        .filter((r) => !alreadySeen(tickets, r))
        .filter((r) => (r.matchScore ?? 0) >= MATCH_THRESHOLD)
        .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
        .slice(0, MAX_NEW_TICKETS_PER_QUERY);

      qSummary.found = results.results?.length || 0;

      for (const r of candidates) {
        try {
          const jd = `${r.snippet || ""}${r.url ? `\n\nSource: ${r.url}` : ""}`;
          const tailored = await tailor({ profile, company: r.company, role: r.role, jd });
          if ((tailored.matchScore ?? 0) < MIN_TAILORED_SCORE) {
            summary.errors.push(
              `Skipped ${r.company} / ${r.role}: tailored match score ${tailored.matchScore} is below ${MIN_TAILORED_SCORE} -- likely a generic landing page rather than a specific posting.`
            );
            continue;
          }
          const ticket = {
            id: nextTicketId(tickets),
            company: r.company || "—",
            role: r.role || "—",
            date: new Date().toISOString().slice(0, 10),
            status: "Draft",
            matchScore: tailored.matchScore,
            missing: tailored.missing,
            tailoredBullets: tailored.tailoredBullets,
            tailoredEntries: tailored.tailoredEntries,
            jd,
            sourceUrl: r.url || "",
            platform: r.platform || "",
            postedRecency: r.postedRecency || "",
            location: r.location || "",
            auto: true,
          };
          try {
            ticket.resumeUrl = await generateResumePdf({ profile, ticket });
          } catch (e) {
            summary.errors.push(`Resume PDF failed for ${r.company} / ${r.role}: ${e.message}`);
          }
          try {
            const coverLetterUrl = await generateCoverLetterPdf({ profile, ticket });
            if (coverLetterUrl) ticket.coverLetterUrl = coverLetterUrl;
          } catch (e) {
            summary.errors.push(`Cover letter failed for ${r.company} / ${r.role}: ${e.message}`);
          }
          tickets = [ticket, ...tickets];
          qSummary.added += 1;
          summary.added += 1;
        } catch (e) {
          qSummary.error = e.message;
          summary.errors.push(`Tailor failed for ${r.company} / ${r.role}: ${e.message}`);
        }
      }
    } catch (e) {
      qSummary.error = e.message;
      summary.errors.push(`Search failed for "${w.query}": ${e.message}`);
    }
    summary.queries.push(qSummary);
  }

  setTickets(tickets);
  summary.finished = new Date().toISOString();
  appendRunLog(summary);
  return summary;
}
