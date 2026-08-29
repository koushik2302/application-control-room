# Application Control Room

A local job-hunt cockpit. It searches company career pages for postings that match
your background, drafts an **ATS-tailored resume + cover-letter PDF** for each one,
and tracks every application as a ticket on a board.

It **never submits anything.** Every draft is reviewed by you. The optional Chrome
extension only *fills* a form on a tab you already have open — it does not click submit.

Everything runs and stays on your machine: resume tailoring and match scoring use a
**local Ollama model** (no paid API, nothing leaves the box); job search uses the
**Tavily** free tier.

---

## Stack

| Layer | Tech |
|---|---|
| UI | React 19 + Vite |
| API / workers | Node (Express 5), Playwright for the autofill + posting-verification workers |
| PDF generation | pdfkit |
| Tailoring & match scoring | Ollama (`qwen3:8b` by default), local |
| Job search | Tavily API (free tier) |
| Autofill helper | unpacked Chrome extension in `extension/` |
| Storage | plain JSON + PDFs under `data/` — no database |

---

## Prerequisites

- **Node.js 20+** (22 recommended)
- **Ollama** running locally with the model pulled: install from https://ollama.com,
  then `ollama pull qwen3:8b` and keep `ollama serve` up
- A **free Tavily API key** — sign up at https://tavily.com (no credit card), used
  only by the Search tab

---

## Setup

```bash
npm install
cp .env.example .env        # then paste your Tavily key into TAVILY_API_KEY=
npm run dev                 # web UI + API together, with reload
```

Open the URL it prints (default **http://localhost:3001**).

| command | what |
|---|---|
| `npm run dev` | web UI + API, live reload (normal use) |
| `npm start` | build once, then serve |
| `npm run server` | API only |
| `npm run build` | production build into `dist/` |
| `npm run build:exe` | package a standalone Windows `.exe` into `release/` |

---

## The tabs

- **Profile** — the single source of truth. Name, contact, education, experience,
  projects, skills, plus address/city/pincode for autofill. The resume/cover-letter
  generator and the match scorer use only this. Empty Experience **and** Projects =
  tailoring is skipped.
- **Search** — run a Tavily query, review real postings, promote the good ones to
  tickets. Each gets a tailored resume + cover-letter PDF in `data/resumes/`.
- **Watchlist** — saved `{query, location}` searches. The daily cycle runs all of
  them; new matches land as `Draft` tickets.
- **Tailor** — tailor a resume/cover letter against a JD you paste in directly,
  without going through search.
- **Tracker** — the board. Move tickets across `Draft → Applied → Interview → …`.

The automated part stops at `Draft`. Nothing is ever submitted for you.

---

## Daily auto-run

On startup and on a schedule the server runs the full cycle (search every watchlist
entry → tailor the best new matches → write `Draft` tickets with PDFs). Controlled
by `.env`:

```
ACR_DAILY_TIME=08:00      # 24h, server local time
ACR_RUN_DAYS=1,2,3,4      # 0=Sun … 6=Sat
ACR_DISABLE_CRON=1        # set to skip the scheduled run entirely
```

---

## Chrome extension (optional autofill helper)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   the `extension/` folder.
2. Keep the app running — the extension talks to `localhost:3001`.
3. Open a job application form, click the extension, hit **Fill**. Review everything.
   **It never submits.**

---

## Where data lives

- `data/data.json` — profile, tickets, watchlist, run log
- `data/resumes/` — every generated resume + cover-letter PDF
- `.env` — your Tavily key (git-ignored; never commit or share)
- `autofill-browser-profile/` — the Playwright browser profile the autofill worker
  drives (real session state; git-ignored, never commit)

No cloud, no account, no telemetry.

---

## Notes

- The search stage (`server/llm.js`, `search()`) currently appends `"internship"` to
  every query and filters the results toward India — see the function and its
  `isEntryLevelRole(...)` helper to change either.
- All five LLM prompts in `server/llm.js` frame the scraped JD/question text as
  untrusted data, not instructions (prompt-injection hardening).
- `CHANGELOG.md` is the running build log (git-ignored, kept locally) — newest
  entries on top, append-only.
