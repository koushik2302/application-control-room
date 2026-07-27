import { getData, setTickets, appendRunLog } from "./store.js";
import { search, tailor } from "./llm.js";

const MATCH_THRESHOLD = 60;
const MAX_NEW_TICKETS_PER_QUERY = 3;

function ticketId(n) {
  return `APP-${String(n).padStart(3, "0")}`;
}

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
          const ticket = {
            id: ticketId(tickets.length + 1),
            company: r.company || "—",
            role: r.role || "—",
            date: new Date().toISOString().slice(0, 10),
            status: "Draft",
            matchScore: tailored.matchScore,
            missing: tailored.missing,
            tailoredBullets: tailored.tailoredBullets,
            sourceUrl: r.url || "",
            platform: r.platform || "",
            postedRecency: r.postedRecency || "",
            auto: true,
          };
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
