import path from "path";
import { baseDir } from "./paths.js";
import dotenv from "dotenv";
dotenv.config({ path: path.join(baseDir, ".env") });

import express from "express";
import cors from "cors";
import { getData, setProfile, setTickets, setWatchlist } from "./store.js";
import { tailor, search } from "./llm.js";
import { runDailyCycle } from "./dailyRun.js";
import { scheduleDaily } from "./schedule.js";

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

app.get("/api/profile", (req, res) => res.json(getData().profile));
app.put("/api/profile", (req, res) => res.json(setProfile(req.body)));

app.get("/api/tickets", (req, res) => res.json(getData().tickets));
app.put("/api/tickets", (req, res) => res.json(setTickets(req.body)));

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

app.listen(PORT, () => {
  console.log(`Application Control Room server running on http://localhost:${PORT}`);
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
