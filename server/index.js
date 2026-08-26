import "./env.js";
import fs from "fs";
import path from "path";
import { baseDir } from "./paths.js";
import express from "express";
import cors from "cors";
import { getData, setProfile, setTickets, setWatchlist, DATA_DIR, nextTicketId } from "./store.js";
import { tailor, search } from "./llm.js";
import { generateResumePdf, regenerateAllResumes, resumeFilePath } from "./resume.js";
import { generateCoverLetterPdf, regenerateAllCoverLetters, coverLetterFilePath } from "./coverLetter.js";
import { runDailyCycle } from "./dailyRun.js";
import { scheduleDaily } from "./schedule.js";
import { autofillApplication } from "./autofill.js";

const PORT = process.env.PORT || 3001;
const DAILY_RUN_TIME = process.env.ACR_DAILY_TIME || "08:00"; // server local time, HH:MM
// Days the auto-search/tailor cycle is allowed to run: 0=Sun ... 6=Sat. Default Mon-Thu.
const ALLOWED_DAYS = (process.env.ACR_RUN_DAYS || "1,2,3,4").split(",").map((d) => Number(d.trim()));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function alreadyRanToday() {
  const data = getData();
  return data.runLog.some((r) => r.started?.slice(0, 10) === todayStr());
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/resumes", express.static(path.join(DATA_DIR, "resumes")));

app.get("/api/profile", (req, res) => res.json(getData().profile));

// Every profile save re-renders every existing ticket's resume PDF (and
// cover letter) against it, so contact info / education / summary edits —
// and any future tweak to either document's layout — never go stale next
// to a tracker entry.
app.put("/api/profile", async (req, res) => {
  try {
    const profile = setProfile(req.body);
    let tickets = await regenerateAllResumes({ profile, tickets: getData().tickets });
    tickets = await regenerateAllCoverLetters({ profile, tickets });
    setTickets(tickets);
    res.json(profile);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tickets", (req, res) => res.json(getData().tickets));
app.put("/api/tickets", (req, res) => res.json(setTickets(req.body)));

// Logs a newly-confirmed match: assigns the ticket id, renders a resume PDF
// tailored to this JD from the real profile content, and stores both.
app.post("/api/tickets/log", async (req, res) => {
  try {
    const { company, role, jd, tailored, sourceUrl, platform, postedRecency } = req.body;
    const data = getData();
    const ticket = {
      id: nextTicketId(data.tickets),
      company: company || "—",
      role: role || "—",
      date: new Date().toISOString().slice(0, 10),
      status: "Draft",
      matchScore: tailored?.matchScore,
      missing: tailored?.missing,
      tailoredBullets: tailored?.tailoredBullets,
      tailoredEntries: tailored?.tailoredEntries,
      // Kept so this ticket's resume can be re-tailored later (e.g. after a
      // profile edit) without asking the user to re-paste the JD.
      ...(jd ? { jd } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(platform ? { platform } : {}),
      ...(postedRecency ? { postedRecency } : {}),
    };
    ticket.resumeUrl = await generateResumePdf({ profile: data.profile, ticket });
    const coverLetterUrl = await generateCoverLetterPdf({ profile: data.profile, ticket });
    if (coverLetterUrl) ticket.coverLetterUrl = coverLetterUrl;
    const next = [ticket, ...data.tickets];
    setTickets(next);
    res.json(next);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/watchlist", (req, res) => res.json(getData().watchlist));
app.put("/api/watchlist", (req, res) => res.json(setWatchlist(req.body)));

app.get("/api/run-log", (req, res) => res.json(getData().runLog));

app.post("/api/tailor", async (req, res) => {
  try {
    const { company, role, jd } = req.body;
    const result = await tailor({ profile: getData().profile, company, role, jd });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const { query, location } = req.body;
    const result = await search({ profile: getData().profile, query, location });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Opens the real posting in a visible browser window and fills in whatever
// it can from the profile (contact fields, resume/cover-letter file
// uploads, drafted answers for essay questions) -- never clicks
// Submit/Apply/anything, and never touches password/account-creation
// fields. See autofill.js for the full guardrails. The browser window is
// left open for the user to review and submit manually.
app.post("/api/tickets/:id/autofill", async (req, res) => {
  try {
    const data = getData();
    const ticket = data.tickets.find((t) => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    if (!ticket.sourceUrl) return res.status(400).json({ error: "This ticket has no posting URL to open." });
    const summary = await autofillApplication({ profile: data.profile, ticket });
    res.json(summary);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Absolute on-disk paths for a ticket's generated resume/cover-letter PDFs.
// Only useful to something running on this same machine (the browser
// extension's background script, via chrome.debugger's DOM.setFileInputFiles,
// which needs a real filesystem path rather than a URL/blob) -- same
// same-machine trust boundary the rest of this unauthenticated local app
// already assumes.
app.get("/api/tickets/:id/files", (req, res) => {
  const data = getData();
  const ticket = data.tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  const resume = resumeFilePath(ticket);
  const coverLetter = coverLetterFilePath(ticket);
  res.json({
    resumePath: resume && fs.existsSync(resume) ? resume : null,
    coverLetterPath: coverLetter && fs.existsSync(coverLetter) ? coverLetter : null,
  });
});

// Manual trigger for the daily automation, so you can test it without waiting
// for the scheduled time. Always stops at logging a Draft ticket — never
// applies anywhere on its own.
let runInProgress = false;
app.post("/api/daily-run/trigger", async (req, res) => {
  if (runInProgress) return res.status(409).json({ error: "A run is already in progress." });
  runInProgress = true;
  try {
    const summary = await runDailyCycle({ trigger: "manual" });
    res.json(summary);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    runInProgress = false;
  }
});

// Serve the built frontend in production (single-exe / `npm run build` mode).
const distDir = path.join(baseDir, "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next();
  });
});

async function runDailyIfDue(trigger) {
  if (!ALLOWED_DAYS.includes(new Date().getDay())) {
    console.log("Skipping daily run — today is not an allowed run day (ACR_RUN_DAYS).");
    return;
  }
  if (runInProgress) {
    console.log("Skipping run — a run is already in progress.");
    return;
  }
  runInProgress = true;
  console.log(`Starting ${trigger} search/tailor run...`);
  try {
    const summary = await runDailyCycle({ trigger });
    console.log(`Run finished: ${summary.added} new draft ticket(s), ${summary.errors.length} error(s).`);
  } catch (e) {
    console.error("Run failed:", e);
  } finally {
    runInProgress = false;
  }
}

app.listen(PORT, async () => {
  console.log(`Application Control Room server running on http://localhost:${PORT}`);

  // Refresh every ticket's resume PDF and cover letter on boot, so a code
  // change to either layout (or a data.json edited by hand) can't leave
  // stale documents behind.
  try {
    const data = getData();
    if (data.tickets.length) {
      let tickets = await regenerateAllResumes({ profile: data.profile, tickets: data.tickets });
      tickets = await regenerateAllCoverLetters({ profile: data.profile, tickets });
      setTickets(tickets);
      console.log(`Refreshed ${tickets.length} resume PDF(s)/cover letter(s) against the current profile/layout.`);
    }
  } catch (e) {
    console.error("Startup resume refresh failed:", e);
  }

  if (process.env.ACR_DISABLE_CRON !== "1") {
    // Catch-up run: if the server just started (e.g. laptop was just turned on)
    // on an allowed day and no run has happened yet today, run now instead of
    // waiting for the fixed daily time — the server won't be up 24/7.
    if (ALLOWED_DAYS.includes(new Date().getDay()) && !alreadyRanToday()) {
      runDailyIfDue("startup");
    }
    const at = scheduleDaily(DAILY_RUN_TIME, () => runDailyIfDue("daily"));
    console.log(
      `Daily auto-search/tailor scheduled for ${at} on days [${ALLOWED_DAYS.join(",")}] (0=Sun..6=Sat, server local time). Also runs once at startup on an allowed day if it hasn't run yet today. Keep this window running.`
    );
  } else {
    console.log("Daily auto-search/tailor disabled (ACR_DISABLE_CRON=1).");
  }
});
