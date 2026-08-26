// Runs the actual Playwright automation in its OWN real Node process,
// separate from the main pkg-packaged server. Reason: `playwright` needs
// `node:inspector` internally, and pkg's embedded Node build doesn't
// support it -- confirmed directly by running the packaged exe:
// `Error [ERR_INSPECTOR_NOT_AVAILABLE]: Inspector is not available`. That's
// not fixable from inside the pkg snapshot, so server/autofill.js spawns
// this file with a real Node binary instead (the system's own node in dev,
// or a portable node.exe copied next to the exe by finish-release.js when
// packaged) -- a normal Node process has full node:inspector support, and
// requires `playwright`/`playwright-core` from a real on-disk node_modules
// folder the ordinary way, no snapshot involved.
//
// Protocol: reads one JSON payload from stdin (profile, ticket, and the
// already-resolved resumeFilePath/coverLetterFilePath/bravePath strings --
// computed by the parent, not here, so this file has zero dependency on
// resume.js/coverLetter.js/paths.js and stays a fully standalone script).
// Writes the result JSON to stdout followed by a `__ACR_AUTOFILL_DONE__`
// marker line the parent watches for. Deliberately does NOT exit after
// that -- the browser window must stay open for the user to review and
// submit manually, so this process only exits once that browser
// disconnects (the user closed it) or after an unrecoverable launch error.
import fs from "fs";
import { execFileSync } from "child_process";
import { chromium } from "playwright";
import { draftAnswer, draftCoverLetter, chooseOption } from "./llm.js";

const AUTH_FIELD_RE = /password|create.*account|confirm.*password|verify.*password/i;

// Demographic / equal-opportunity / voluntary self-identification questions
// must never be auto-answered -- they're the candidate's own to state. This is
// a hard backstop in addition to chooseOption()'s own prompt-level refusal, so
// a radio/select carrying one of these labels is left untouched even if the
// model tried to pick something.
const DEMOGRAPHIC_FIELD_RE =
  /gender|\bsex\b|\brace\b|ethnic|hispanic|latino|disab|veteran|military|sexual orientation|\breligion\b|date of birth|\bdob\b|equal (employment|opportunity)|\beeo\b|voluntary self|self.?identif/i;

// Work-authorization questions used to be skipped like demographics, but the
// user explicitly supplied standing answers ("if they ask whether visa
// sponsorship is required in India it is a no, and I'm a citizen of India"),
// so they're now answered DETERMINISTICALLY in deterministicChoice() -- never
// by the LLM (chooseOption's prompt still refuses them, which is fine since
// they're resolved before it's called). Questions naming a country other than
// India are still left for the user: the standing answers only hold for India.
const WORK_AUTH_RE = /work authoriz|authoriz.*work|sponsor|visa|right to work|eligib.*work|legally.*work|citizen|nationality/i;

function mentionsForeignCountry(q) {
  return (
    /\bU\.?S\.?A?\.?\b|\bUK\b|\bUAE\b|\bEU\b/.test(q) ||
    /united states|america|united kingdom|britain|england|canada|australia|germany|france|netherlands|ireland|singapore|dubai|japan|switzerland|schengen|europe|new zealand|malaysia|hong kong|qatar|saudi/i.test(q)
  );
}

// Institution dropdowns: pick the user's real university when listed, else the
// list's "Other(s)" entry (explicitly requested: "sometimes PES University
// won't be there on the list, at that time put Others").
const INSTITUTION_RE = /universit|college|institut|alma mater|\bschool\b|campus|education/i;

function findOption(options, re) {
  return (options || []).find((o) => re.test(o)) || "";
}

// Fixed, user-supplied answers resolved by rule instead of the LLM -- an 8B
// model is flakier than a regex for standing answers the user has stated
// outright. Returns "" when no rule applies (caller may then fall back to
// chooseOption, except for work-auth questions, which are never sent to it).
function deterministicChoice(question, options) {
  const q = question || "";
  if (WORK_AUTH_RE.test(q)) {
    if (mentionsForeignCountry(q)) return ""; // another country's rules -- user's call
    if (/citizen|nationality/i.test(q)) return findOption(options, /^\s*india(n)?\b/i) || findOption(options, /\bindia(n)?\b/i);
    if (/sponsor|visa/i.test(q)) return findOption(options, /^\s*no\b/i);
    return findOption(options, /^\s*yes\b/i); // authorized / eligible / right to work in India
  }
  if (INSTITUTION_RE.test(q)) {
    return findOption(options, /\bpes\b/i) || findOption(options, /^\s*others?\b/i);
  }
  return "";
}

// Order matters -- labelKey() takes the first match, so a field like "Phone
// Extension" or "Local First Name" must hit its own specific rule before it
// can fall through to the generic phone/name one and get the wrong value
// stuffed into it. Confirmed live against a real Workday form (Airbus):
// before these specific rules existed, "Given Name" (the real required
// field) went unmatched entirely while "Local First Name" (a native-script
// name field) wrongly caught the Latin name instead, and "Phone Number" /
// "Phone Extension" / "Country Phone Code" all received the exact same full
// phone string, and every "Address Line N" field got the exact same full
// address string instead of being split across them.
const FIELD_MATCHERS = [
  { key: "localName", re: /\blocal\b/i }, // native-script name fields -- we have no transliteration, leave blank
  { key: "skip-extension", re: /extension|\bext\.?\s*$/i },
  { key: "phoneCode", re: /phone.*code|country.*code.*phone|dial.*code|std\s*code/i },
  { key: "firstName", re: /first\s*name|given\s*name/i },
  { key: "lastName", re: /last\s*name|surname|family\s*name/i },
  { key: "fullName", re: /full\s*name|your\s*name|^name$|candidate\s*name|applicant\s*name/i },
  { key: "email", re: /e-?mail/i },
  { key: "phone", re: /phone|mobile|contact\s*number/i },
  // Street address only. "address" is intentionally NOT in the `location`
  // matcher below (that would dump the city into a street field, or vice
  // versa). Email is matched earlier, so "Email Address" never reaches here.
  { key: "address", re: /street|address\s*line\s*\d?|mailing\s*address|residential\s*address|permanent\s*address|current\s*address|home\s*address|^address$/i },
  // City and pincode get their OWN fields (kept separate from `address` above so
  // the street value never carries the city/pincode into it, and vice versa).
  { key: "city", re: /\b(city|town)\b/i },
  { key: "pincode", re: /pin\s*code|\bpincode\b|postal\s*code|post\s*code|\bzip\b|zip\s*code/i },
  { key: "location", re: /current\s*location|based\s*in|^location$|\blocation\b/i },
  // \s* because normalizeLabel splits camelCase -> "LinkedIn" becomes
  // "linked in" and "GitHub" becomes "git hub".
  { key: "linkedin", re: /linked\s*in/i },
  { key: "github", re: /git\s*hub/i },
  { key: "portfolio", re: /portfolio|personal\s*(site|website)|website/i },
];

const ESSAY_HINT_RE =
  /\?|\bwhy\b|\bhow\b|describe|explain|tell (us|me)|share (a|an|your)|challenge|motivat|experience with|what (makes|interests|are|is)|walk (us|me)|give an example|your (thoughts|approach|opinion|experience)|in your own words|elaborate/i;

// An open-ended application QUESTION we should draft a grounded answer for.
// Any free-text <textarea> (that isn't the cover letter, handled separately)
// qualifies; a single-line text input only qualifies when its label reads like
// an actual question (long enough + question-shaped), so we never dump a
// paragraph into a short structured field like "Title" or "Referral name".
function isOpenEndedQuestion(f) {
  const label = f.label || "";
  if (!label) return false;
  if (f.tag === "textarea") return true;
  const isTextInput = f.tag === "input" && ["text", "search", ""].includes(f.type || "text");
  return isTextInput && label.length >= 15 && ESSAY_HINT_RE.test(label);
}

// Honeypot / bot-trap fields: forms plant a field that real humans (who can't
// see it, or are told not to) leave empty, and treat any submission that filled
// it as a bot. Filling one would get the whole application silently rejected.
// Detected by its give-away label text (confirmed live on a Workday form:
// "Enter website. This input is for robots only, do not enter if you're
// human.") so we deliberately never fill it.
const HONEYPOT_RE =
  /do not (enter|fill|use|type)|robots? only|for robots|if you'?re? (a )?human|leave (this|it)\s*(field|input)?\s*(blank|empty)|anti-?bot|\bhoneypot\b|\bhp[_-]/i;

// Buttons that ADVANCE a multi-page application to the next step without
// committing it -- safe to auto-click so autofill can walk the user through a
// multi-page form (Save / Continue / Next / Save & Continue). Requested
// explicitly by the user ("click save/continue at the end, any number of
// times").
const CONTINUE_BTN_RE = /^\s*(save|continue|next)\s*$|save\s*(&|and)\s*continue/i;
// Final / irreversible actions autofill NEVER auto-clicks -- submitting the
// application stays the user's own deliberate action, every time. Used as a
// defensive guard even though CONTINUE_BTN_RE shouldn't match these.
const SUBMIT_BTN_RE = /submit|^\s*apply(\s*now)?\s*$|finish|send\s*application|confirm.*submit|complete.*application/i;

// Real ATS forms often have no visible <label> at all -- the only text to
// go on is the raw form field name/id, which tends to look like
// "applicant[lead_attributes[first_name]]" or "firstName" rather than
// "First Name" (confirmed directly against a real Freshteam posting: every
// field matcher missed until this normalization was added, since
// /first\s*name/i doesn't match "first_name" -- no whitespace between the
// words). Splits camelCase/snake_case/bracket-nesting into space-separated
// words so the same regex matchers work against either a real label or a
// bare field name.
function normalizeLabel(label) {
  return (label || "")
    .replace(/[[\]_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function labelKey(label) {
  const normalized = normalizeLabel(label);
  if (AUTH_FIELD_RE.test(normalized)) return "auth";
  for (const { key, re } of FIELD_MATCHERS) {
    if (re.test(normalized)) return key;
  }
  return null;
}

function splitName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || parts[0] || "" };
}

// The leading country calling code out of a "+91 82772 73661"-style number,
// for a field that specifically asks for just the code rather than the
// whole thing.
function phoneCodeOf(phone) {
  const m = (phone || "").match(/^\s*(\+\d{1,4})/);
  return m ? m[1] : "";
}

// Splits a one-line address into as many parts as there are Address Line
// fields on the current page, so line 2/3 get the rest of the address
// instead of a second and third copy of the whole thing. Prefers splitting
// at "near" (matches how this profile's address already reads: street, then
// a landmark/locality clause) and otherwise falls back to an even split
// across the comma-separated segments.
function splitAddress(address, partCount) {
  if (!address || partCount <= 1) return [address];
  const nearMatch = address.match(/^(.*?),?\s*(near\s+.*)$/i);
  if (partCount === 2 && nearMatch) return [nearMatch[1].trim(), nearMatch[2].trim()];
  const segments = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) return [address];
  const perPart = Math.ceil(segments.length / partCount);
  const parts = [];
  for (let i = 0; i < partCount; i++) parts.push(segments.slice(i * perPart, (i + 1) * perPart).join(", "));
  return parts;
}

// Launches a PERSISTENT browser context backed by an on-disk profile dir, so
// logins/cookies survive between autofill runs. This is what makes the
// "extension-like" workflow work: the user signs in to a gated ATS (Workday,
// Oracle Cloud, iCIMS) ONCE in this browser, and every later application on that
// same ATS is already authenticated -- no re-entering an email/login for each
// new posting. The profile dir is passed in by the parent (userDataDir) so it
// lives in a stable app-owned location. Returns the BrowserContext (it behaves
// like a browser for our needs: newPage(), pages(), close()).
// A previous run's browser only ever exits when the user closes its window
// (see the header comment / the process.exit(0) at the bottom of main()) --
// nothing ever forces it closed on its own. If that previous run got
// orphaned instead of closed cleanly (the laptop was shut down/slept mid-run,
// the server was killed, a crash, etc.), its Brave process tree keeps running
// forever and holds an exclusive lock on this profile dir, so the NEXT
// launch fails with "Opening in existing browser session." Rather than
// require someone to hunt down and kill those PIDs by hand every time, find
// and force-close any Brave process still using this exact profile dir
// before launching -- safe because the app's whole design only ever wants
// one live browser per profile at a time (that's the point of a *persistent*
// profile: one ongoing signed-in session, not several in parallel).
function reapStaleProfileProcesses(userDataDir) {
  let rows;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='brave.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 10000 },
    );
    const parsed = JSON.parse(out || "[]");
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return; // best-effort -- if this fails, the real launch error below still surfaces
  }
  const stale = rows.filter((r) => r.CommandLine && r.CommandLine.includes(userDataDir));
  for (const r of stale) {
    try {
      execFileSync("taskkill", ["/PID", String(r.ProcessId), "/F", "/T"], { timeout: 10000 });
    } catch {
      /* already gone, or a race with another handler -- fine either way */
    }
  }
}

async function launchBrowser(bravePath, userDataDir) {
  const opts = {
    headless: false,
    viewport: null,
    // Persistent profiles that were closed abruptly (e.g. the window force-quit)
    // otherwise reopen with Chromium's "restore pages?" bubble and stale tabs,
    // which can leave the wrong tab focused. Suppress that so every run starts
    // clean on the posting we navigate to, while keeping the saved logins.
    args: ["--hide-crash-restore-bubble", "--no-first-run", "--no-default-browser-check"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (bravePath && fs.existsSync(bravePath)) opts.executablePath = bravePath;
  try {
    return await chromium.launchPersistentContext(userDataDir, opts);
  } catch (e) {
    if (!/existing browser session|already in use/i.test(e.message)) throw e;
    reapStaleProfileProcesses(userDataDir);
    return chromium.launchPersistentContext(userDataDir, opts); // one retry; a real second failure just throws
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { profile, ticket, resumeFilePath, coverLetterFilePath, bravePath, userDataDir } = JSON.parse(await readStdin());
  const result = { filled: [], drafted: [], fileUploads: [], skipped: [] };
  let browser;

  try {
    browser = await launchBrowser(bravePath, userDataDir);
    // Persistent context opens with one blank page already -- reuse it rather
    // than spawning a second, so the window the user sees is the one we drive.
    let page = browser.pages()[0] || (await browser.newPage());

    const navResponse = await page.goto(ticket.sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // A fixed short sleep isn't enough for every ATS -- confirmed directly:
    // a JPMorgan/Oracle Cloud posting was still showing a bare loading
    // spinner (zero fields in the DOM yet) a full 1.5s after domcontentloaded.
    // Wait for the network to actually go quiet, AND for at least one
    // interactive element to exist, whichever comes first/succeeds -- both
    // are best-effort with their own timeout, since some pages legitimately
    // never go network-idle (analytics beacons, polling) or legitimately
    // have zero fields (a plain description page with no form at all).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForSelector("input, textarea, select, button, a", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800); // small settle buffer for final client-side hydration

    // Some company career sites (Schneider Electric's careers.se.com,
    // confirmed directly) sit behind an anti-bot layer (Akamai Bot Manager)
    // that fingerprints browser automation and serves an "Access Denied" page
    // instead of the real content -- so there are literally zero form fields
    // to find, and the run would otherwise return an empty summary that looks
    // identical to "nothing on this page matched". We deliberately do NOT try
    // to evade that detection (no stealth/fingerprint spoofing) -- that would
    // mean defeating a security control the site put there on purpose. Instead
    // we detect the block from the main-document HTTP status and/or the
    // tell-tale page text, and report it plainly so the user knows to fill the
    // form manually rather than being left guessing why autofill did nothing.
    const navStatus = navResponse ? navResponse.status() : 0;
    const blockSignal = await page
      .evaluate(() => {
        const title = (document.title || "").toLowerCase();
        const bodyText = (document.body?.innerText || "").slice(0, 2000).toLowerCase();
        const hay = `${title}\n${bodyText}`;
        // Common anti-bot / WAF block-page phrasings (Akamai, Cloudflare,
        // Imperva, generic 403 pages). Kept deliberately specific so a real
        // application form that merely uses one of these words in passing
        // doesn't trip it.
        return /access denied|you don'?t have permission to access|request blocked|reference\s*#?\d|verify you are (a )?human|are you a robot|attention required|bot detection|unusual traffic/.test(hay);
      })
      .catch(() => false);

    if (navStatus >= 400 || blockSignal) {
      result.error =
        `${ticket.company || "This site"} blocks automated browsers (anti-bot protection` +
        (navStatus >= 400 ? `, HTTP ${navStatus}` : "") +
        `), so autofill can't reach the form. Open the posting and fill it in manually — your resume and cover letter PDFs are ready in the ticket.`;
      result.blocked = true;
      process.stdout.write(JSON.stringify(result) + "\n__ACR_AUTOFILL_DONE__\n");
      if (browser) browser.on("close", () => process.exit(0));
      return;
    }

    // Reveal buttons: many ATS (Freshteam, and especially Workday/Oracle Cloud)
    // show a DESCRIPTION page first and only reveal the actual form after one or
    // more "Apply"/"Apply Manually"/"Start Your Application" clicks -- sometimes
    // in a new browser tab. All are safe, non-submitting navigations (they only
    // move toward the form, never a final Submit). Deliberately excludes any
    // control that also looks like a sign-in/submit action.
    const REVEAL_BTN_RE =
      /^apply now$|^apply$|^apply manually$|apply for this (job|position)|start (your )?application|^i'?m interested$|^get started$|^continue$|^next$/i;

    async function currentPage() {
      // If a reveal click opened the form in a new tab, follow it.
      const pages = browser.contexts?.().length ? undefined : null; // (no-op guard for older API)
      const all = page.context().pages().filter((p) => !p.isClosed());
      const newest = all[all.length - 1];
      if (newest && newest !== page) {
        page = newest;
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      }
      return page;
    }

    async function settle() {
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await page.waitForSelector("input, textarea, select, button, a", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
    }

    async function scanPage() {
      return page.evaluate(() => {
      function labelFor(el) {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l?.textContent?.trim()) return l.textContent.trim();
        }
        const wrap = el.closest("label");
        if (wrap?.textContent?.trim()) return wrap.textContent.trim();
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const t = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
            .trim();
          if (t) return t;
        }
        // Open-ended application questions ("Tell us about a time...", "How do
        // you check the output is correct?") usually render the QUESTION in a
        // block above the field, not as a real <label>, and the field's own
        // placeholder is a useless "Type your response". For a textarea or a
        // plain text input, walk up a few levels looking at preceding siblings
        // for that question text, and prefer it over the placeholder below.
        {
          const tg = el.tagName.toLowerCase();
          const ty = (el.getAttribute("type") || "text").toLowerCase();
          if (tg === "textarea" || (tg === "input" && ["text", "search", "email", "url", ""].includes(ty))) {
            let node = el;
            for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
              let sib = node.previousElementSibling;
              for (let s = 0; s < 3 && sib; s++, sib = sib.previousElementSibling) {
                const txt = (sib.textContent || "").trim().replace(/\s+/g, " ");
                if (txt && txt.length > 12 && txt.length < 400 && /\?|tell us|describe|\bwhy\b|\bhow\b|\bwhat\b|experience with|walk us|give an example/i.test(txt)) {
                  return txt;
                }
              }
            }
          }
        }
        if (el.placeholder) return el.placeholder;
        // File inputs first check ANCESTOR automation-ids/text before
        // falling back to the input's OWN technical automation id --
        // confirmed directly on Workday this ordering matters: the real
        // <input>'s own data-automation-id is the generic
        // "file-upload-input-ref" (which tells you nothing), while its
        // dropzone wrapper two levels up carries data-automation-id
        // "resumeUpload" -- the actually meaningful signal. The dropzone's
        // own visible text ("Drop file here / Select file") never mentions
        // "resume" at all, so this has to check ancestor automation-ids as
        // their own real source, not merely as a name for text already
        // being scanned.
        if ((el.getAttribute("type") || "").toLowerCase() === "file") {
          let node = el.parentElement;
          for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
            const nodeAutomationId = node.getAttribute?.("data-automation-id") || node.getAttribute?.("data-testid") || node.getAttribute?.("data-qa");
            if (nodeAutomationId && /resume|cv|cover.?letter/i.test(nodeAutomationId)) return nodeAutomationId;
            const text = node.textContent?.trim();
            if (text && text.length < 300 && /resume|cv|cover letter/i.test(text)) return text;
          }
        }
        // Enterprise ATS platforms (Workday confirmed directly) heavily use
        // data-automation-id/data-testid instead of real <label> elements.
        const automationId = el.getAttribute("data-automation-id") || el.getAttribute("data-testid") || el.getAttribute("data-qa");
        if (automationId) return automationId;
        if (el.name) return el.name;
        return "";
      }

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        // getComputedStyle reports an element's OWN display even when a parent is
        // display:none, so a field on a hidden page/step still looks "visible"
        // here -- which made the scanner pick up later-page fields and made
        // auto-advance think the page never changed. Layout boxes are the
        // reliable signal: none exist when the element (or any ancestor) is
        // display:none / not rendered.
        return el.getClientRects().length > 0;
      }

      // The group label for a radio-button set: a wrapping <fieldset>'s
      // <legend>, then aria-labelledby, then the nearest preceding heading/label
      // text -- radio groups rarely have a per-input <label> that names the
      // actual QUESTION (those name each OPTION instead).
      function groupLabel(el) {
        const fs = el.closest("fieldset");
        const legend = fs?.querySelector("legend");
        if (legend?.textContent?.trim()) return legend.textContent.trim();
        const labelledBy = el.getAttribute("aria-labelledby") || fs?.getAttribute("aria-labelledby");
        if (labelledBy) {
          const t = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
            .trim();
          if (t) return t;
        }
        const scope = fs || el.parentElement;
        let node = scope?.previousElementSibling;
        for (let i = 0; i < 3 && node; i++, node = node.previousElementSibling) {
          const t = node.textContent?.trim();
          if (t && t.length < 200) return t;
        }
        return "";
      }

      const candidates = Array.from(document.querySelectorAll("input, textarea, select"));
      const out = [];
      const radioMap = {}; // name -> { label, options: [{acrId, optionLabel}] }
      candidates.forEach((el, i) => {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "submit", "button", "reset", "image"].includes(type)) return;
        if (el.disabled) return;

        // Radio buttons: grouped by their shared `name` into one question. Each
        // radio is itself often visually hidden behind a styled label, so -- like
        // file inputs -- we don't require the input itself to be visible, only
        // that it can be clicked via its label; skip only if truly detached.
        if (type === "radio") {
          const name = el.getAttribute("name") || `__anon_${i}`;
          el.setAttribute("data-acr-id", String(i));
          const optionLabel = labelFor(el) || el.getAttribute("value") || "";
          (radioMap[name] ||= { label: groupLabel(el), options: [] }).options.push({
            acrId: String(i),
            optionLabel: optionLabel.slice(0, 120),
          });
          return;
        }

        // File inputs are routinely styled invisible on purpose (a custom
        // drag-and-drop dropzone sits on top of the real <input> -- confirmed
        // directly on Workday) -- Playwright's setInputFiles() works on a
        // hidden file input regardless, since it sets the files property
        // directly rather than needing a real user-visible click/drag. Every
        // other field type still needs to be genuinely visible to fill.
        if (type !== "file" && !isVisible(el)) return;

        // A READONLY combobox-style input is really a click-to-open dropdown
        // trigger (Oracle Cloud renders these), not a fillable text field --
        // leave it for the custom-dropdown pass below instead of trying (and
        // failing) to .fill() it here.
        if (
          el.readOnly &&
          ((el.getAttribute("role") || "") === "combobox" || el.getAttribute("aria-haspopup") === "listbox")
        ) {
          return;
        }

        el.setAttribute("data-acr-id", String(i));
        const field = {
          acrId: String(i),
          tag: el.tagName.toLowerCase(),
          type,
          label: labelFor(el).slice(0, 200),
          // Text inputs that drive an autocomplete/list popup: after filling
          // one, the popup can stay open ON TOP of the rest of the form and
          // swallow every later click/fill -- the fill pass presses Escape
          // after these.
          combo:
            el.getAttribute("aria-haspopup") === "listbox" ||
            (el.getAttribute("role") || "") === "combobox" ||
            (el.getAttribute("aria-autocomplete") || "") === "list",
        };
        // Native <select>: capture the real option texts so the picker can
        // choose one (skip placeholder/prompt options like "Select...").
        if (el.tagName.toLowerCase() === "select") {
          field.options = Array.from(el.options)
            .map((o) => (o.textContent || "").trim())
            .filter((t) => t && !/^(select|choose|please|--)/i.test(t));
        }
        out.push(field);
      });

      // Custom (non-native) dropdowns: Workday/Oracle-style comboboxes render
      // as a <button aria-haspopup="listbox"> or a [role="combobox"] element,
      // not a <select>, so the input/textarea/select query above never sees
      // them -- this was why "dropdowns don't work" on real ATS forms. Capture
      // the TRIGGER here; its options only exist in the DOM after clicking it
      // open, so they're read in the fill pass, not during the scan.
      const customTriggers = Array.from(
        document.querySelectorAll(
          'button[aria-haspopup="listbox"], [role="combobox"], input[aria-haspopup="listbox"]'
        )
      );
      customTriggers.forEach((el, j) => {
        if (el.hasAttribute("data-acr-id")) return; // already captured as a native field
        if (el.tagName.toLowerCase() === "select") return;
        // Non-readonly combobox INPUTS were captured as text fields above (with
        // combo:true); only click-to-open triggers belong here.
        if (el.tagName.toLowerCase() === "input" && !el.readOnly) return;
        if (!isVisible(el)) return;
        const id = `c${j}`;
        el.setAttribute("data-acr-id", id);
        out.push({
          acrId: id,
          tag: "customdropdown",
          type: "customdropdown",
          label: (labelFor(el) || (el.textContent || "").trim()).slice(0, 200),
        });
      });

      const radioGroups = Object.entries(radioMap)
        .map(([name, g]) => ({ name, label: g.label, options: g.options }))
        .filter((g) => g.options.length > 0);

      return { fields: out, radioGroups };
    }); // end scanPage()
    }

    // Detects a sign-in / create-account wall (Workday, Oracle Cloud, iCIMS all
    // gate the form behind one). We never create accounts or sign in, so this is
    // reported as a distinct, actionable state rather than a generic "no form".
    async function isAccountGate() {
      return page
        .evaluate(() => {
          const hasPassword = !!document.querySelector('input[type="password"]');
          const t = (document.body?.innerText || "").slice(0, 3000).toLowerCase();
          const signInWords = /(sign in|log ?in|create (an )?account|register|forgot password|new user|verify your email|create your account)/i.test(t);
          // A password field OR clear sign-in wording with no real application
          // fields around it.
          return hasPassword || signInWords;
        })
        .catch(() => false);
    }

    // Click a reveal button (Apply / Apply Manually / Start / Continue) if the
    // current page has no form yet, following into a new tab if one opens.
    // Returns true if it clicked something.
    async function tryReveal() {
      const btn = page
        .getByRole("button", { name: REVEAL_BTN_RE })
        .or(page.getByRole("link", { name: REVEAL_BTN_RE }));
      if ((await btn.count().catch(() => 0)) === 0) return false;
      await btn.first().click({ timeout: 5000 }).catch(() => {});
      await currentPage(); // follow a possible new tab
      await settle();
      return true;
    }

    // Scan first; the posting may already BE the form. If not, click through up
    // to 3 reveal steps (description -> Apply -> Apply Manually -> form),
    // re-scanning each time, until fields appear or there's nothing left to
    // click.
    let { fields, radioGroups } = await scanPage();
    for (let step = 0; step < 3 && fields.length === 0 && radioGroups.length === 0; step++) {
      const clicked = await tryReveal();
      if (!clicked) break;
      ({ fields, radioGroups } = await scanPage());
    }

    if (fields.length === 0 && radioGroups.length === 0) {
      if (await isAccountGate()) {
        result.error =
          "This posting (Workday/Oracle-style ATS) puts the application form behind a sign-in / create-account step, which autofill won't do for you. Create the account or sign in manually in the browser window, get to the actual form page, then re-run autofill — it will fill the form once the fields are visible.";
        result.accountGate = true;
      } else {
        result.error =
          "No application form fields found on this page — it looks like a job description or a generic careers/landing page rather than an actual apply form. Open the posting in the browser window, click Apply / navigate to the specific job's form, then re-run autofill there.";
        result.noForm = true;
      }
      process.stdout.write(JSON.stringify(result) + "\n__ACR_AUTOFILL_DONE__\n");
      if (browser) browser.on("close", () => process.exit(0));
      return;
    }

    const { first, last } = splitName(profile.name);
    let coverLetterParagraphs = null;

    // A short fill timeout (Playwright's own default is 30s) so one field
    // that's actually hidden/unreachable (real ATS forms sometimes reveal
    // fields progressively, or have decoy/off-screen inputs) fails fast
    // instead of stalling the whole run for 30 seconds.
    const FILL_TIMEOUT = 5000;

    // Fill one scanned page (text/file/select fields + radio groups). Defined
    // as a closure so the auto-advance loop below can call it once per page.
    async function fillScanned(fields, radioGroups) {
    // How many "Address Line N" fields THIS page has, so the address can be
    // split across them instead of the same full string getting stuffed
    // into every one (confirmed live: Workday forms commonly have 2-3
    // address-line fields for a single address).
    const addressFieldCount = fields.filter((f) => labelKey(f.label) === "address").length;
    const addressParts = splitAddress(profile.address, addressFieldCount);
    let addressIndex = 0;

    // When this page has its own separate Country/Territory Phone Code
    // field (already holding "+91"), the plain Phone Number field must NOT
    // also carry the country code -- confirmed live on the real Shell form:
    // filling "+91 82772 73661" into Phone Number when a phoneCode field
    // already existed failed validation ("Enter a valid format for Phone
    // Number"). Airbus, which has no separate phoneCode field, needs the
    // full number with its country code in the one Phone Number field it
    // has -- so this only strips the code when there's somewhere else for it.
    const hasPhoneCodeField = fields.some((f) => labelKey(f.label) === "phoneCode");
    function phoneNumberValue(phone) {
      if (!hasPhoneCodeField) return phone || "";
      return (phone || "").replace(/^\s*\+\d{1,4}\s*/, "").trim();
    }

    for (const f of fields) {
      const locator = page.locator(`[data-acr-id="${f.acrId}"]`);
      const key = labelKey(f.label);

      // Each field gets its own try/catch: a single field that times out or
      // errors (hidden, detached, whatever) must not abort every field
      // after it in the list -- confirmed directly this was a real bug,
      // caught testing against a real ATS form where one slow-to-render
      // field killed the rest of an otherwise-successful run.
      try {
        if (key === "auth") {
          result.skipped.push({ label: f.label, reason: "auth field -- never auto-filled" });
          continue;
        }
        if (key === "localName") {
          result.skipped.push({ label: f.label, reason: "native-script name field -- left for you" });
          continue;
        }
        if (key === "skip-extension") {
          result.skipped.push({ label: f.label, reason: "phone extension -- no data" });
          continue;
        }

        if (HONEYPOT_RE.test(f.label)) {
          result.skipped.push({ label: f.label, reason: "bot-trap (honeypot) field -- deliberately left empty" });
          continue;
        }

        if (f.type === "file") {
          if (/resume|cv/i.test(f.label)) {
            if (resumeFilePath && fs.existsSync(resumeFilePath)) {
              await locator.setInputFiles(resumeFilePath, { timeout: FILL_TIMEOUT });
              result.fileUploads.push({ label: f.label, file: "resume" });
            } else {
              result.skipped.push({ label: f.label, reason: "resume file not found on disk" });
            }
          } else if (/cover\s*letter/i.test(f.label)) {
            if (coverLetterFilePath && fs.existsSync(coverLetterFilePath)) {
              await locator.setInputFiles(coverLetterFilePath, { timeout: FILL_TIMEOUT });
              result.fileUploads.push({ label: f.label, file: "cover letter" });
            } else {
              result.skipped.push({ label: f.label, reason: "cover letter file not found on disk" });
            }
          } else {
            result.skipped.push({ label: f.label, reason: "unrecognized file upload -- left for manual attachment" });
          }
          continue;
        }

        if (f.tag === "select") {
          if (DEMOGRAPHIC_FIELD_RE.test(f.label)) {
            result.skipped.push({ label: f.label, reason: "demographic question -- left for you to answer" });
          } else if (!f.options || f.options.length === 0) {
            result.skipped.push({ label: f.label, reason: "dropdown -- no readable options to choose from" });
          } else {
            let choice = deterministicChoice(f.label, f.options);
            if (!choice && WORK_AUTH_RE.test(f.label)) {
              // Work-auth questions are rule-only -- if no rule matched (e.g.
              // it names another country), leave it rather than let the LLM
              // guess at an immigration answer.
              result.skipped.push({ label: f.label, reason: "work-authorization dropdown -- no standing answer applies (or it's about another country), left for you" });
            } else {
              if (!choice) choice = await chooseOption({ profile, ticket, question: f.label, options: f.options });
              if (choice) {
                await locator.selectOption({ label: choice }, { timeout: FILL_TIMEOUT });
                result.drafted.push({ label: f.label, note: `dropdown set to "${choice}" -- drafted, review before submitting` });
              } else {
                result.skipped.push({ label: f.label, reason: "dropdown -- no confident choice from your profile, left for manual selection" });
              }
            }
          }
          continue;
        }

        // Custom (button/combobox-style) dropdown: click it open, read the
        // popup's [role="option"] entries, pick one, and ALWAYS close the popup
        // afterwards -- a panel left open covers the fields below it and was
        // why one dropdown could stop the whole rest of the form from filling.
        if (f.tag === "customdropdown") {
          if (DEMOGRAPHIC_FIELD_RE.test(f.label)) {
            result.skipped.push({ label: f.label, reason: "demographic question -- left for you to answer" });
            continue;
          }
          try {
            await locator.click({ timeout: FILL_TIMEOUT });
            await page.waitForSelector('[role="option"]', { timeout: 3000 }).catch(() => {});
            const options = await page.evaluate(() =>
              Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li'))
                .filter((o) => o.getClientRects().length > 0)
                .map((o) => (o.textContent || "").trim())
                .filter((t) => t && !/^(select|choose|please|--)/i.test(t))
                .slice(0, 200)
            );
            if (options.length === 0) {
              result.skipped.push({ label: f.label, reason: "dropdown -- couldn't read its options after opening it" });
            } else {
              let choice = deterministicChoice(f.label, options);
              if (!choice && WORK_AUTH_RE.test(f.label)) {
                result.skipped.push({ label: f.label, reason: "work-authorization dropdown -- no standing answer applies (or it's about another country), left for you" });
              } else {
                if (!choice) choice = await chooseOption({ profile, ticket, question: f.label, options });
                if (choice) {
                  const exact = page.getByRole("option", { name: choice, exact: true }).first();
                  const ok = await exact.click({ timeout: FILL_TIMEOUT }).then(() => true).catch(() => false);
                  if (!ok) await page.getByRole("option", { name: choice }).first().click({ timeout: FILL_TIMEOUT });
                  result.drafted.push({ label: f.label, note: `dropdown set to "${choice}" -- drafted, review before submitting` });
                } else {
                  result.skipped.push({ label: f.label, reason: "dropdown -- no confident choice from your profile, left for manual selection" });
                }
              }
            }
          } finally {
            // Close any still-open options panel so it can't block later fields.
            await page.keyboard.press("Escape").catch(() => {});
          }
          continue;
        }

        if (key === "fullName") {
          await locator.fill(profile.name || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "firstName") {
          await locator.fill(first, { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "lastName") {
          await locator.fill(last, { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "email") {
          await locator.fill(profile.email || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "phone") {
          await locator.fill(phoneNumberValue(profile.phone), { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "phoneCode") {
          await locator.fill(phoneCodeOf(profile.phone), { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "location") {
          await locator.fill(profile.location || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "address") {
          const value = addressParts[addressIndex] || "";
          addressIndex++;
          await locator.fill(value, { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "city") {
          await locator.fill(profile.city || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "pincode") {
          await locator.fill(profile.pincode || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "linkedin") {
          await locator.fill(profile.linkedin || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "github") {
          await locator.fill(profile.github || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (key === "portfolio") {
          await locator.fill(profile.portfolio || "", { timeout: FILL_TIMEOUT });
          result.filled.push(f.label);
        } else if (f.tag === "textarea" && /cover\s*letter/i.test(f.label)) {
          if (!coverLetterParagraphs) coverLetterParagraphs = await draftCoverLetter({ profile, ticket });
          if (coverLetterParagraphs.length) {
            await locator.fill(coverLetterParagraphs.join("\n\n"), { timeout: FILL_TIMEOUT });
            result.drafted.push({ label: f.label, note: "cover letter -- drafted, not verified, review before submitting" });
          } else {
            result.skipped.push({ label: f.label, reason: "couldn't draft a cover letter for this ticket" });
          }
        } else if (isOpenEndedQuestion(f)) {
          const answer = await draftAnswer({ profile, ticket, question: f.label });
          if (answer) {
            await locator.fill(answer, { timeout: FILL_TIMEOUT });
            result.drafted.push({ label: f.label, note: "drafted, not verified, review before submitting" });
          } else {
            result.skipped.push({ label: f.label, reason: "couldn't draft an answer" });
          }
        } else {
          result.skipped.push({ label: f.label || "(no label found)", reason: "no confident match" });
        }

        // Filling an autocomplete-style input opens a suggestions popup that
        // can sit on top of the fields below it -- close it before moving on.
        if (f.combo) await page.keyboard.press("Escape").catch(() => {});
      } catch (e) {
        // A timed-out click/fill often means an open dropdown/autocomplete
        // panel is covering the form -- close it so ONE bad field can't block
        // every field after it (reported live: one dropdown opened and nothing
        // else got filled).
        await page.keyboard.press("Escape").catch(() => {});
        result.skipped.push({ label: f.label || "(no label found)", reason: `couldn't fill: ${e.message.split("\n")[0]}` });
      }
    }

    // Radio-button groups: one question per shared `name`, each with a small
    // set of option labels. Pick one option from the real profile (or leave it),
    // then click that radio via its label -- a native radio is often visually
    // hidden behind a styled <label>, so we click the label's locator, which
    // Playwright resolves to the control. Same review-before-submit contract as
    // dropdowns; demographic / work-authorization groups are left untouched.
    for (const g of radioGroups) {
      const groupLabel = g.label || "(unlabeled choice)";
      try {
        if (DEMOGRAPHIC_FIELD_RE.test(groupLabel)) {
          result.skipped.push({ label: groupLabel, reason: "demographic question -- left for you to answer" });
          continue;
        }
        const optionLabels = g.options.map((o) => o.optionLabel).filter(Boolean);
        if (optionLabels.length === 0) {
          result.skipped.push({ label: groupLabel, reason: "radio group -- no readable option labels" });
          continue;
        }
        let choice = deterministicChoice(groupLabel, optionLabels);
        if (!choice && WORK_AUTH_RE.test(groupLabel)) {
          result.skipped.push({ label: groupLabel, reason: "work-authorization question -- no standing answer applies (or it's about another country), left for you" });
          continue;
        }
        if (!choice) choice = await chooseOption({ profile, ticket, question: groupLabel, options: optionLabels });
        if (!choice) {
          result.skipped.push({ label: groupLabel, reason: "radio group -- no confident choice from your profile, left for manual selection" });
          continue;
        }
        const picked = g.options.find((o) => o.optionLabel.trim().toLowerCase() === choice.toLowerCase());
        if (!picked) {
          result.skipped.push({ label: groupLabel, reason: "radio group -- couldn't map the chosen option back to a button" });
          continue;
        }
        const radio = page.locator(`[data-acr-id="${picked.acrId}"]`);
        // check() sets the radio regardless of a covering styled label; fall
        // back to clicking if the real input intercepts pointer events.
        await radio.check({ timeout: FILL_TIMEOUT }).catch(async () => {
          await radio.click({ timeout: FILL_TIMEOUT, force: true });
        });
        result.drafted.push({ label: groupLabel, note: `selected "${choice}" -- drafted, review before submitting` });
      } catch (e) {
        result.skipped.push({ label: groupLabel, reason: `couldn't select: ${e.message.split("\n")[0]}` });
      }
    }
    } // end fillScanned()

    // Fill the first page...
    await fillScanned(fields, radioGroups);

    // ...then AUTO-ADVANCE through the rest of a multi-page application: click
    // Save/Continue/Next, fill the page it lands on, and repeat -- for as many
    // pages as the form has (the user asked for this explicitly). HARD SAFETY
    // RULE: it only ever clicks a Save/Continue/Next control, NEVER Submit /
    // final Apply / Finish, so it stops at the review/submit step and leaves the
    // actual submission to the user. Also stops if a click doesn't change the
    // page (a validation error on a required field it couldn't fill), so it
    // never spins on the same page.
    const pageSig = (fs, rg) => fs.map((f) => f.label).join("|") + "##" + rg.map((g) => g.label).join("|");
    let prevSig = pageSig(fields, radioGroups);
    result.pagesAdvanced = 0;
    for (let step = 0; step < 10; step++) {
      const continueBtn = page
        .getByRole("button", { name: CONTINUE_BTN_RE })
        .or(page.getByRole("link", { name: CONTINUE_BTN_RE }));
      if ((await continueBtn.count().catch(() => 0)) === 0) break; // at review/submit or end
      const btnText = (await continueBtn.first().innerText().catch(() => "")) || "";
      if (SUBMIT_BTN_RE.test(btnText)) break; // defensive: never auto-submit

      await continueBtn.first().click({ timeout: 5000 }).catch(() => {});
      await currentPage();
      await settle();

      const scan = await scanPage();
      const newSig = pageSig(scan.fields, scan.radioGroups);
      if (newSig === prevSig) break; // page didn't change -> validation error / dead click
      prevSig = newSig;
      result.pagesAdvanced++;
      if (scan.fields.length === 0 && scan.radioGroups.length === 0) break; // review/confirmation page
      await fillScanned(scan.fields, scan.radioGroups);
    }
    if (result.pagesAdvanced > 0) {
      result.note = `Auto-advanced through ${result.pagesAdvanced} more page(s) via Save/Continue. Stopped before any Submit — review everything, then submit yourself.`;
    }

    if (process.env.ACR_AUTOFILL_SCREENSHOT) {
      await page.screenshot({ path: process.env.ACR_AUTOFILL_SCREENSHOT, fullPage: true });
    }
  } catch (e) {
    result.error = e.message;
  }

  process.stdout.write(JSON.stringify(result) + "\n__ACR_AUTOFILL_DONE__\n");

  // Deliberately does NOT close the browser or exit here -- it stays open
  // for manual review/submit. Exit once the user closes that window (the
  // normal path), or after IDLE_CLOSE_MS of nobody doing that -- a safety
  // net for the case the window is never closed at all (laptop shut down or
  // slept mid-review, server killed, crash, etc.). Without this bound nothing
  // ever forces such a process closed and it, and the Brave tree under it,
  // are left running indefinitely (see reapStaleProfileProcesses() above,
  // which is what a later autofill run needed before this existed).
  const IDLE_CLOSE_MS = 30 * 60 * 1000;
  if (browser) {
    const idleTimer = setTimeout(() => {
      browser.close().catch(() => {}).finally(() => process.exit(0));
    }, IDLE_CLOSE_MS);
    browser.on("close", () => {
      clearTimeout(idleTimer);
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

main();
