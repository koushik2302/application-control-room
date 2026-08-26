// Verifies candidate job postings by actually rendering each one and reading
// its real metadata -- the fix for tickets that stored a specific URL but with
// no location, no date, and a model-guessed (often wrong) company name. Renders
// in a real browser (not a plain fetch) because the big ATS posting pages
// (Workday, Greenhouse's newer boards) are SPAs that inject their schema.org
// JobPosting JSON-LD via JS -- a static fetch sees none of it. Eightfold/Lever
// expose it statically, but rendering handles every case uniformly.
//
// Runs in its own real Node process (spawned by server/verify.js), same reason
// as the autofill worker: playwright needs node:inspector, absent from the pkg
// exe. Standalone -- imports only fs + playwright.
//
// Protocol: stdin JSON { urls:[...], bravePath }; stdout one JSON result
// { results: { <url>: {ok,title,company,location,datePosted,validThrough,expired} } }
// then a __ACR_VERIFY_DONE__ marker line. Closes the browser and exits when done.
import fs from "fs";
import { chromium } from "playwright";

const DONE_MARKER = "__ACR_VERIFY_DONE__";

const EXPIRED_TEXT_RE =
  /no longer (accepting|available|open)|position (has been )?(filled|closed)|this (job|posting|position) is (closed|no longer)|not accepting applications|posting (has )?expired|req(uisition)? (is )?closed/i;

// A dead posting often doesn't say so in words -- it silently 301/302s to
// the company's general "Current openings" board instead (confirmed live:
// a stale Greenhouse job id redirected to the board's plain listing page,
// which has no expiry text and no validThrough date to catch it, and was
// stored as a live ticket). The last path segment of a specific-posting URL
// is normally its requisition id/slug (e.g. ".../jobs/4824019101"); if that
// segment is gone from where the page actually landed, the browser was
// bounced off the specific posting onto something else.
function pathIdentifier(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    return "";
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function verifyOne(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Prefer waiting for the JobPosting JSON-LD to appear (the data we actually
    // want) over a blanket networkidle -- many ATS pages never go idle. Fall
    // back to a short settle if it never shows (we still text-scan the body).
    await page
      .waitForFunction(
        () => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) => /JobPosting/.test(s.textContent || "")),
        { timeout: 6000 }
      )
      .catch(() => {});
    await page.waitForTimeout(400);

    const info = await page.evaluate(() => {
      function pickJobPosting() {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          let parsed;
          try {
            parsed = JSON.parse(s.textContent);
          } catch {
            continue;
          }
          const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
          for (const n of nodes) {
            const t = n && n["@type"];
            if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return n;
          }
        }
        return null;
      }

      function locString(jp) {
        if (!jp) return "";
        const parts = [];
        const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
        for (const l of locs) {
          const a = l && l.address;
          if (!a) continue;
          for (const k of ["addressLocality", "addressRegion", "addressCountry"]) {
            const v = a[k];
            const s = typeof v === "object" && v ? v.name || v["@id"] || "" : v || "";
            if (s) parts.push(String(s));
          }
        }
        // Remote / applicant-location requirements
        const alr = jp.applicantLocationRequirements;
        const alrArr = Array.isArray(alr) ? alr : alr ? [alr] : [];
        for (const r of alrArr) if (r && r.name) parts.push(String(r.name));
        if (jp.jobLocationType) parts.push(String(jp.jobLocationType));
        return parts.join(", ");
      }

      const jp = pickJobPosting();
      const metaSite = document.querySelector('meta[property="og:site_name"]')?.content || "";
      const bodyText = (document.body?.innerText || "").slice(0, 4000);
      return {
        title: (jp && jp.title) || document.title || "",
        company: (jp && jp.hiringOrganization && (jp.hiringOrganization.name || jp.hiringOrganization)) || metaSite || "",
        location: locString(jp),
        datePosted: (jp && jp.datePosted) || "",
        validThrough: (jp && jp.validThrough) || "",
        bodyText,
      };
    });

    const now = Date.now();
    let expired = false;
    if (info.validThrough) {
      const vt = Date.parse(info.validThrough);
      if (Number.isFinite(vt) && vt < now) expired = true;
    }
    if (!expired && EXPIRED_TEXT_RE.test(info.bodyText || "")) expired = true;
    if (!expired) {
      const wantedId = pathIdentifier(url);
      const landedId = pathIdentifier(page.url());
      // Only a signal when the original URL actually looked like a specific
      // posting (a real id/slug, not empty and not a bare board root) and
      // the browser landed somewhere else entirely -- avoids false-dropping
      // a page that legitimately redirects to an equivalent posting URL
      // that happens to just reformat the same id.
      if (wantedId && wantedId !== landedId && !page.url().includes(wantedId)) expired = true;
    }

    // If JSON-LD had no location, fall back to scanning the visible text for an
    // India city / country mention so a page that simply omitted structured
    // location isn't wrongly treated as "unknown".
    let location = info.location;
    if (!location) {
      const m = (info.bodyText || "").match(
        /\b(india|bengaluru|bangalore|mumbai|new delhi|delhi|gurgaon|gurugram|noida|hyderabad|chennai|pune|kolkata|remote)\b/i
      );
      if (m) location = m[0];
    }

    return {
      ok: true,
      title: (info.title || "").slice(0, 200),
      company: typeof info.company === "string" ? info.company.slice(0, 120) : "",
      location: (location || "").slice(0, 200),
      datePosted: info.datePosted || "",
      validThrough: info.validThrough || "",
      expired,
    };
  } catch (e) {
    return { ok: false, reason: (e.message || "load failed").split("\n")[0] };
  }
}

async function main() {
  const { urls = [], bravePath } = JSON.parse(await readStdin());
  const results = {};
  let browser;
  try {
    browser = bravePath && fs.existsSync(bravePath)
      ? await chromium.launch({ executablePath: bravePath, headless: true })
      : await chromium.launch({ headless: true });

    // Verify up to CONCURRENCY postings at once (each on its own page) -- the
    // per-URL waits dominate wall time, so a small pool cuts a ~11-URL batch
    // from minutes to well under one. A shared queue index hands out URLs.
    const CONCURRENCY = 4;
    let next = 0;
    async function workerLoop() {
      const page = await browser.newPage();
      try {
        while (true) {
          const i = next++;
          if (i >= urls.length) break;
          results[urls[i]] = await verifyOne(page, urls[i]);
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, workerLoop));
  } catch (e) {
    // whole-batch failure: mark everything unverified so the caller drops them
    for (const url of urls) if (!results[url]) results[url] = { ok: false, reason: e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  process.stdout.write(JSON.stringify({ results }) + "\n" + DONE_MARKER + "\n");
  process.exit(0);
}

main();
