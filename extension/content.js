// Injected on demand (via chrome.scripting.executeScript, never as a
// persistent content script) when the user clicks "Autofill this page" in
// the popup. Ported from the desktop app's server/autofillWorker.js, which
// does the same job through Playwright against a separate automated
// browser -- this version does it with plain DOM APIs against the tab the
// user is already signed into. Same hard rules as that file: never touches
// a password/account-creation field, never fills a demographic/EEO
// question, never clicks Submit/Apply/Finish, and a resume/cover-letter
// file input is only ever filled by the background script's debugger-API
// path (opt-in) -- otherwise it's highlighted for the user to drop the file
// in themselves.

window.__acrFill = function (profile, settings) {
  const AUTH_RE = /password|create.*account|confirm.*password|verify.*password/i;
  const DEMOGRAPHIC_RE =
    /gender|\bsex\b|\brace\b|ethnic|hispanic|latino|disab|veteran|military|sexual orientation|\breligion\b|date of birth|\bdob\b|equal (employment|opportunity)|\beeo\b|voluntary self|self.?identif/i;
  const WORK_AUTH_RE = /work authoriz|authoriz.*work|sponsor|visa|right to work|eligib.*work|legally.*work|citizen|nationality/i;
  const INSTITUTION_RE = /universit|college|institut|alma mater|\bschool\b|campus|education/i;
  const HONEYPOT_RE =
    /do not (enter|fill|use|type)|robots? only|for robots|if you'?re? (a )?human|leave (this|it)\s*(field|input)?\s*(blank|empty)|anti-?bot|\bhoneypot\b|\bhp[_-]/i;

  // Order matters -- labelKey() takes the first match, so a field like
  // "Phone Extension" or "Local First Name" must hit its own specific rule
  // before it can fall through to the generic phone/name one and get the
  // wrong value stuffed into it. Confirmed live against a real Workday form
  // (Airbus): before these specific rules existed, "Given Name" (the real
  // required field) went unmatched entirely while "Local First Name" (native-
  // script name, a different field) wrongly caught the Latin name instead,
  // and "Phone Number"/"Phone Extension"/"Country Phone Code" all received
  // the exact same full phone string.
  const FIELD_MATCHERS = [
    { key: "localName", re: /\blocal\b/i }, // native-script name fields -- we have no transliteration, leave blank
    { key: "skip-extension", re: /extension|\bext\.?\s*$/i },
    { key: "phoneCode", re: /phone.*code|country.*code.*phone|dial.*code|std\s*code/i },
    { key: "firstName", re: /first\s*name|given\s*name/i },
    { key: "lastName", re: /last\s*name|surname|family\s*name/i },
    { key: "fullName", re: /full\s*name|your\s*name|^name$|candidate\s*name|applicant\s*name/i },
    { key: "email", re: /e-?mail/i },
    { key: "phone", re: /phone|mobile|contact\s*number/i },
    { key: "address", re: /street|address\s*line\s*\d?|mailing\s*address|residential\s*address|permanent\s*address|current\s*address|home\s*address|^address$/i },
    { key: "city", re: /\b(city|town)\b/i },
    { key: "pincode", re: /pin\s*code|\bpincode\b|postal\s*code|post\s*code|\bzip\b|zip\s*code/i },
    { key: "location", re: /current\s*location|based\s*in|^location$|\blocation\b/i },
    { key: "linkedin", re: /linked\s*in/i },
    { key: "github", re: /git\s*hub/i },
    { key: "portfolio", re: /portfolio|personal\s*(site|website)|website/i },
  ];

  // The leading country calling code out of a "+91 82772 73661"-style
  // number, for a field that specifically asks for just the code.
  function phoneCodeOf(phone) {
    const m = (phone || "").match(/^\s*(\+\d{1,4})/);
    return m ? m[1] : "";
  }

  // Splits a one-line address into as many parts as there are Address Line
  // fields on the form, so line 2/3 get the rest of the address instead of
  // a second and third copy of the whole thing. Prefers splitting at "near"
  // (matches how this profile's address already reads: street, then a
  // landmark/locality clause) and otherwise falls back to an even split
  // across the comma-separated segments.
  function splitAddress(address, partCount) {
    if (!address || partCount <= 1) return [address];
    const nearMatch = address.match(/^(.*?),?\s*(near\s+.*)$/i);
    if (partCount === 2 && nearMatch) return [nearMatch[1].trim(), nearMatch[2].trim()];
    const segments = address.split(",").map((s) => s.trim()).filter(Boolean);
    if (segments.length <= 1) return [address];
    const perPart = Math.ceil(segments.length / partCount);
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      parts.push(segments.slice(i * perPart, (i + 1) * perPart).join(", "));
    }
    return parts;
  }

  function normalizeLabel(label) {
    return (label || "")
      .replace(/[[\]_.-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
  }

  function labelKey(label) {
    const n = normalizeLabel(label);
    if (AUTH_RE.test(n)) return "auth";
    for (const { key, re } of FIELD_MATCHERS) if (re.test(n)) return key;
    return null;
  }

  function splitName(fullName) {
    const parts = (fullName || "").trim().split(/\s+/);
    return { first: parts[0] || "", last: parts.slice(1).join(" ") || parts[0] || "" };
  }

  function valueFor(key, profile) {
    switch (key) {
      case "firstName":
        return splitName(profile.name).first;
      case "lastName":
        return splitName(profile.name).last;
      case "fullName":
        return profile.name || "";
      case "email":
        return profile.email || "";
      case "phone":
        return profile.phone || "";
      case "phoneCode":
        return phoneCodeOf(profile.phone);
      case "address":
        return profile.address || "";
      case "city":
        return profile.city || "";
      case "pincode":
        return profile.pincode || "";
      case "location":
        return profile.location || "";
      case "linkedin":
        return profile.linkedin || "";
      case "github":
        return profile.github || "";
      case "portfolio":
        return profile.portfolio || "";
      default:
        return "";
    }
  }

  // Deterministic answers for standing questions the user has explicitly
  // stated -- work-authorization/citizenship (India only; another country
  // named in the question is left for the user) and university dropdowns
  // (pick PES, else "Other(s)").
  function deterministicChoice(question, options) {
    const q = question || "";
    const mentionsForeign =
      /\bU\.?S\.?A?\.?\b|\bUK\b|\bUAE\b|\bEU\b/.test(q) ||
      /united states|america|united kingdom|britain|england|canada|australia|germany|france|netherlands|ireland|singapore|dubai|japan|switzerland|schengen|europe|new zealand|malaysia|hong kong|qatar|saudi/i.test(q);
    const find = (re) => (options || []).find((o) => re.test(o)) || "";
    if (WORK_AUTH_RE.test(q)) {
      if (mentionsForeign) return "";
      if (/citizen|nationality/i.test(q)) return find(/^\s*india(n)?\b/i) || find(/\bindia(n)?\b/i);
      if (/sponsor|visa/i.test(q)) return find(/^\s*no\b/i);
      return find(/^\s*yes\b/i);
    }
    if (INSTITUTION_RE.test(q)) return find(/\bpes\b/i) || find(/^\s*others?\b/i);
    return "";
  }

  function isVisible(el) {
    return el.getClientRects().length > 0;
  }

  // A plain `el.value = x` updates the DOM and reads back correctly, but on
  // a React-controlled input (most of these Workday forms) React's own
  // validation state doesn't get invalidated by it -- confirmed live on a
  // real Shell form: after this plain assignment, the Phone Number field
  // showed the right value but a STALE "Enter a valid format" error stayed
  // on screen, and only cleared once the field was actually typed into (or,
  // tested directly, once set via this same native-setter + input-event
  // workaround the Experience filler already used). Used for every text/
  // textarea field now, not just the Experience page's.
  function setReactValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  function labelFor(el) {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      const d = document.getElementById(describedBy);
      if (d) return d.innerText.trim();
    }
    return el.placeholder || el.name || el.id || "";
  }

  const result = { filled: [], skipped: [], fileFields: [] };

  const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter(isVisible);

  // How many "Address Line N" fields this particular form has, so the
  // address can be split across them instead of the same full string
  // getting stuffed into every one (confirmed live: Workday forms commonly
  // have 2-3 address-line fields for a single address).
  const addressFieldCount = inputs.filter((el) => {
    const t = (el.type || "text").toLowerCase();
    if (t === "file" || ["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(t)) return false;
    return labelKey(labelFor(el)) === "address";
  }).length;
  const addressParts = splitAddress(profile.address, addressFieldCount);
  let addressIndex = 0;

  // When a form has its own separate Country/Territory Phone Code field
  // (already holding "+91"), the plain Phone Number field must NOT also
  // carry the country code -- confirmed live on the real Shell form: filling
  // "+91 82772 73661" into Phone Number when a phoneCode field already
  // existed failed validation ("Enter a valid format for Phone Number").
  // Airbus, which has no separate phoneCode field, needs the full number
  // with its country code in the one Phone Number field it has -- so this
  // only strips the code when there's actually somewhere else for it to go.
  const hasPhoneCodeField = inputs.some((el) => {
    const t = (el.type || "text").toLowerCase();
    if (t === "file" || ["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(t)) return false;
    return labelKey(labelFor(el)) === "phoneCode";
  });
  function phoneNumberValue(phone) {
    if (!hasPhoneCodeField) return phone || "";
    return (phone || "").replace(/^\s*\+\d{1,4}\s*/, "").trim();
  }

  for (const el of inputs) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "text").toLowerCase();
    if (["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(type)) continue;

    const label = labelFor(el);
    if (!label) continue;
    if (HONEYPOT_RE.test(label)) {
      result.skipped.push({ label, reason: "honeypot" });
      continue;
    }
    if (DEMOGRAPHIC_RE.test(normalizeLabel(label))) {
      result.skipped.push({ label, reason: "demographic/EEO -- left for you" });
      continue;
    }

    if (type === "file") {
      // Never filled here -- reported back so the popup/background can
      // decide (debugger-API upload if enabled, otherwise the user drops
      // the file in manually). Give it a stable handle to find it again.
      const marker = `acr-file-${result.fileFields.length}`;
      el.setAttribute("data-acr-file", marker);
      el.style.outline = "3px solid #e20015";
      el.style.outlineOffset = "2px";
      result.fileFields.push({ marker, label });
      continue;
    }

    const key = labelKey(label);
    if (key === "auth") {
      result.skipped.push({ label, reason: "auth field -- never auto-filled" });
      continue;
    }
    if (key === "localName") {
      result.skipped.push({ label, reason: "native-script name field -- left for you" });
      continue;
    }
    if (key === "skip-extension") {
      result.skipped.push({ label, reason: "phone extension -- no data" });
      continue;
    }

    if (tag === "select") {
      const options = Array.from(el.options).map((o) => o.text.trim());
      let choice = deterministicChoice(label, options);
      if (!choice && key) choice = valueFor(key, profile); // rare: a <select> reused as a plain text-ish field
      const match = options.find((o) => o.toLowerCase() === (choice || "").toLowerCase());
      if (match) {
        const optionValue = Array.from(el.options).find((o) => o.text.trim() === match).value;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
        setter.call(el, optionValue);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        result.filled.push({ label, value: match });
      } else {
        result.skipped.push({ label, reason: "dropdown -- no confident choice, left for you" });
      }
      continue;
    }

    if (!key) {
      result.skipped.push({ label, reason: "no matching profile field" });
      continue;
    }
    let value;
    if (key === "address") {
      value = addressParts[addressIndex] || "";
      addressIndex++;
    } else if (key === "phone") {
      value = phoneNumberValue(profile.phone);
    } else {
      value = valueFor(key, profile);
    }
    if (!value) {
      result.skipped.push({ label, reason: "profile has no value for this field" });
      continue;
    }
    setReactValue(el, value);
    result.filled.push({ label, value });
  }

  // Native radio groups only (custom Workday-style listbox dropdowns aren't
  // ported in this first version -- see the extension's README note).
  const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(isVisible);
  const groups = new Map();
  for (const r of radios) {
    const name = r.name || "";
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  for (const [name, group] of groups) {
    const groupLabel = (() => {
      const fs = group[0].closest("fieldset");
      if (fs) {
        const legend = fs.querySelector("legend");
        if (legend) return legend.innerText.trim();
      }
      return labelFor(group[0]) || name;
    })();
    if (DEMOGRAPHIC_RE.test(normalizeLabel(groupLabel))) {
      result.skipped.push({ label: groupLabel, reason: "demographic/EEO -- left for you" });
      continue;
    }
    const options = group.map((r) => labelFor(r) || r.value);
    const choice = deterministicChoice(groupLabel, options);
    if (!choice) {
      result.skipped.push({ label: groupLabel, reason: "radio group -- no confident choice, left for you" });
      continue;
    }
    const idx = options.findIndex((o) => o.toLowerCase() === choice.toLowerCase());
    if (idx >= 0) {
      group[idx].checked = true;
      group[idx].dispatchEvent(new Event("change", { bubbles: true }));
      result.filled.push({ label: groupLabel, value: options[idx] });
    }
  }

  return result;
};

// Fills Workday's "My Experience" page -- Work Experience and Education,
// each a repeatable block ("Add Another" per section). Separate from
// __acrFill above because these fields are React-controlled in a way plain
// text/select inputs on other pages aren't (confirmed live against the real
// Airbus form): a raw `el.value = x` gets silently ignored, and the school/
// field-of-study typeahead only reveals its option list after a real Enter
// keypress, not just an input event. Async because those popups render on a
// delay.
window.__acrFillExperience = async function (profile) {
  const result = { filled: [], skipped: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setReactValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function visibleOptions() {
    return Array.from(document.querySelectorAll('[role="option"]')).filter((x) => x.getClientRects().length > 0);
  }

  // Whole-word overlap between `queryWords` and `text` -- NOT substring
  // containment. Confirmed live why that distinction matters: searching
  // "PES University" against Airbus's real reference list matched "University
  // of Peshawar", because a plain `.includes("pes")` is true for "Peshawar"
  // (it literally starts with those three letters) even though the words are
  // unrelated. Splitting `text` into real words and requiring an exact word
  // match rejects that coincidence -- "peshawar" !== "pes" -- while still
  // matching genuine cases like "engineering" appearing as its own word.
  // Generic institutional words -- "university" alone would score a match
  // against nearly every option in a school-name list, defeating the point
  // of requiring an overlap at all. Stripped from the query before scoring
  // so only actually-distinctive words (the school's real name) count.
  // Confirmed live this needs to be broad, not just the obvious two or
  // three: "Nitte Meenakshi Institute of Technology" matched an unrelated
  // "Peoples Education Society Institute of TECHNOLOGY" purely on the shared
  // word "technology" -- common subject/descriptor words in institution
  // names are just as likely to cause a false positive as "university" is.
  const GENERIC_INSTITUTION_WORDS = new Set([
    "university", "college", "institute", "institution", "school", "campus", "of", "the", "and",
    "technology", "technological", "engineering", "science", "sciences", "management", "studies",
    "arts", "commerce", "polytechnic", "academy", "education", "national", "state", "international",
  ]);
  function wordOverlapScore(text, queryWords) {
    const textWords = text.toLowerCase().split(/\W+/);
    return queryWords.filter((w) => !GENERIC_INSTITUTION_WORDS.has(w) && textWords.includes(w)).length;
  }

  // Known alternate names for a school that don't textually resemble the
  // name in `profile.education`, tried in order when the primary query finds
  // nothing usable -- confirmed live and user-supplied: PES University's
  // Workday reference-list entry is actually filed as "Peoples Education
  // Society Institute of Technology" (an older/formal name), which a search
  // for "PES University" or "PES" alone never surfaces, but "P.E.S
  // University" does.
  const SCHOOL_ALIASES = [{ test: /\bpes\b/i, tryQueries: ["P.E.S University", "Peoples Education Society"] }];

  // One search-and-score pass: type `query`, press Enter, score the results,
  // return the winning option element (or null if nothing scores).
  async function searchOnce(el, query) {
    setReactValue(el, query);
    await sleep(600);
    pressEnter(el);
    await sleep(900);
    const options = visibleOptions();
    if (options.length === 0) return null;
    const queryWords = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      const score = wordOverlapScore((opt.innerText || "").trim(), queryWords);
      if (score > bestScore) {
        best = opt;
        bestScore = score;
      }
    }
    return best;
  }

  // Types into a typeahead input, presses Enter to reveal its option list,
  // clicks the option whose text best overlaps `query` (word-overlap, not
  // exact match -- these lists rarely contain the literal school name).
  // Retries with any known alias queries for this school if the primary
  // query finds nothing, and only then falls back to "Other" -- a SEPARATE
  // search for that literal word, since (confirmed live) the "Other"
  // catch-all only appears when you search for it directly, not as a
  // standing member of every result set. Mirrors the desktop tool's
  // INSTITUTION_RE fallback-to-Other rule.
  async function fillTypeahead(el, query) {
    let chosen = await searchOnce(el, query);
    if (!chosen) {
      const alias = SCHOOL_ALIASES.find((a) => a.test.test(query));
      for (const q of (alias && alias.tryQueries) || []) {
        chosen = await searchOnce(el, q);
        if (chosen) break;
      }
    }
    if (!chosen) {
      setReactValue(el, "Other");
      await sleep(600);
      pressEnter(el);
      await sleep(900);
      chosen = visibleOptions().find((o) => /^other\b/i.test((o.innerText || "").trim()));
    }
    if (!chosen) return null;
    const label = (chosen.innerText || "").trim();
    chosen.click();
    await sleep(400);
    return label;
  }

  // Common Indian degree short-forms, expanded before scoring -- confirmed
  // live this was a real bug, not a hypothetical: "B.E." splits into "b" and
  // "e" once punctuation is stripped, both too short to survive the
  // length-3 filter (needed to keep "of"/"and" etc. out elsewhere), so the
  // query ended up empty and a real match ("Bachelor Degree") was missed
  // entirely even though it was sitting right there in the option list.
  const DEGREE_ABBREVIATIONS = {
    be: "bachelor", btech: "bachelor", bsc: "bachelor", ba: "bachelor", bcom: "bachelor",
    me: "master", mtech: "master", msc: "master", ma: "master", mcom: "master",
    phd: "doctoral",
  };
  // Keys above are period-free (all periods stripped for lookup) so "B.E.",
  // "B.E", and "BE" all normalize to the same "be" key -- confirmed live
  // this needed to be robust to punctuation, not just one exact spelling.
  function expandDegreeAbbreviation(query) {
    const key = query.toLowerCase().trim().replace(/\./g, "");
    return DEGREE_ABBREVIATIONS[key] || query;
  }

  // Click-open a Workday "button" style dropdown (Degree, etc.), pick the
  // option with the best word overlap against `query`, click it.
  async function fillButtonDropdown(btn, query) {
    btn.click();
    await sleep(600);
    const options = visibleOptions();
    if (options.length === 0) return null;
    const queryWords = expandDegreeAbbreviation(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      const text = (opt.innerText || "").trim();
      if (/^(select one|other)/i.test(text)) continue; // never the placeholder or generic "Other" here
      const score = wordOverlapScore(text, queryWords);
      if (score > bestScore) {
        best = opt;
        bestScore = score;
      }
    }
    if (!best) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return null;
    }
    const label = (best.innerText || "").trim();
    best.click();
    await sleep(300);
    return label;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function toMonthYear(s) {
    if (!s || /present/i.test(s)) return null;
    const m = s.match(/([A-Za-z]+)\.?\s+(\d{4})/);
    if (!m) return null;
    const key = m[1].toLowerCase().replace(/\.$/, "");
    const mm = MONTHS[key.slice(0, 4)] || MONTHS[key.slice(0, 3)];
    if (!mm) return null;
    return { month: String(mm).padStart(2, "0"), year: m[2] };
  }

  // "Title, Company, Oct 2024 - Jul 2025\n- bullet\n- bullet" -> one entry
  // per header line (a line not starting with "-"), with its following
  // bullet lines joined into a description paragraph.
  function parseExperience(text) {
    const blocks = [];
    let current = null;
    for (const raw of (text || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("-")) {
        if (current) current.bullets.push(line.replace(/^-+\s*/, ""));
      } else {
        current = { header: line, bullets: [] };
        blocks.push(current);
      }
    }
    return blocks.map((b) => {
      const dateMatch = b.header.match(/([A-Za-z]+\.?\s+\d{4})\s*[-–]\s*([A-Za-z]+\.?\s+\d{4}|present)/i);
      let rest = b.header;
      let from = "";
      let to = "";
      let current2 = false;
      if (dateMatch) {
        from = dateMatch[1];
        to = dateMatch[2];
        current2 = /present/i.test(to);
        rest = b.header.slice(0, dateMatch.index).replace(/,\s*$/, "").trim();
      }
      const parts = rest.split(",").map((s) => s.trim()).filter(Boolean);
      return {
        title: parts[0] || "",
        company: parts.slice(1).join(", "),
        from,
        to,
        current: current2,
        description: b.bullets.join(". "),
      };
    });
  }

  // "PES University, Bengaluru — MBA, Operations & Business Analytics (Minor) — Sep 2025 – Sep 2027 — CGPA 7.86"
  // -> one entry per line, em-dash-separated: school, degree/field, date range.
  function parseEducation(text) {
    return (text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const segments = line.split(/[—–-]{1,2}(?=\s)/).map((s) => s.trim());
        const school = (segments[0] || "").split(",")[0].trim();
        const degreeField = segments[1] || "";
        // Years are pulled from wherever they appear in the line, not
        // anchored right after the dash -- "Sep 2025 – Sep 2027" has a month
        // name between the dash and the year, which a plain
        // /\d{4}\s*-\s*\d{4}/ match misses entirely (confirmed: it returned
        // null against this exact profile string). Two 4-digit numbers
        // anywhere on the line, in order, are from/to; "present" if present.
        const years = line.match(/\d{4}/g) || [];
        const isPresent = /present/i.test(line);
        const gpaMatch = line.match(/\b(?:cgpa|gpa)\s*[:\s]?\s*([\d.]+)/i);
        return {
          school,
          degree: degreeField.split(",")[0].trim(),
          fieldOfStudy: degreeField.split(",").slice(1).join(",").trim(),
          from: years[0] || "",
          to: isPresent ? "present" : years[1] || "",
          gpa: gpaMatch ? gpaMatch[1] : "",
        };
      });
  }

  function blockIndices(prefix) {
    const idxs = new Set();
    for (const el of document.querySelectorAll(`[id^="${prefix}-"]`)) {
      const m = el.id.match(new RegExp(`^${prefix}-(\\d+)--`));
      if (m) idxs.add(Number(m[1]));
    }
    return Array.from(idxs).sort((a, b) => a - b);
  }

  // Both sections' "Add Another" buttons share the same visible text, so
  // they're told apart by DOM order (Work Experience's section, and its
  // button, always render before Education's on this page) with a runtime
  // check that clicking one actually grew the *right* section's block count
  // -- if it didn't, stop adding rather than risk clicking the wrong one.
  async function addAnotherBlock(prefix, addButtons, buttonIndex) {
    const before = blockIndices(prefix).length;
    const btn = addButtons[buttonIndex];
    if (!btn) return false;
    btn.click();
    await sleep(500);
    return blockIndices(prefix).length > before;
  }

  // Everything below is wrapped so a thrown error is reported back in
  // `result.error` instead of vanishing -- confirmed this was a real gap:
  // chrome.scripting.executeScript does NOT reject/throw when an injected
  // async function itself throws, it just omits `result` for that call, and
  // popup.js was blindly reading `.filled.length` off that missing result,
  // which itself throws and gets caught too late to say what actually broke
  // inside here. Whatever got filled before the throw stays filled; nothing
  // after it does, since the throw aborts the rest of this function.
  try {

  // ---------- Work Experience ----------
  const experienceEntries = parseExperience(profile.experience);
  if (experienceEntries.length === 0) {
    result.skipped.push({ label: "Work Experience", reason: "profile has no parsable experience text" });
  } else {
    let addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]')).filter((b) => b.getClientRects().length > 0);
    for (let i = blockIndices("workExperience").length; i < experienceEntries.length; i++) {
      const grew = await addAnotherBlock("workExperience", addButtons, 0);
      if (!grew) break; // couldn't confirm the right section grew -- stop rather than guess
      addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]')).filter((b) => b.getClientRects().length > 0);
    }
    const indices = blockIndices("workExperience");
    for (let i = 0; i < Math.min(indices.length, experienceEntries.length); i++) {
      const idx = indices[i];
      const entry = experienceEntries[i];
      const field = (name) => document.getElementById(`workExperience-${idx}--${name}`);
      const jobTitle = field("jobTitle");
      const companyName = field("companyName");
      const location = field("location");
      const currentCb = field("currentlyWorkHere");
      const startMonth = field("startDate-dateSectionMonth-input");
      const startYear = field("startDate-dateSectionYear-input");
      const endMonth = field("endDate-dateSectionMonth-input");
      const endYear = field("endDate-dateSectionYear-input");
      const roleDesc = field("roleDescription");

      if (jobTitle && entry.title) { setReactValue(jobTitle, entry.title); result.filled.push({ label: `Work Experience ${i + 1}: Job Title`, value: entry.title }); }
      if (companyName && entry.company) { setReactValue(companyName, entry.company); result.filled.push({ label: `Work Experience ${i + 1}: Company`, value: entry.company }); }
      if (location && profile.location) { setReactValue(location, profile.location); result.filled.push({ label: `Work Experience ${i + 1}: Location`, value: profile.location }); }
      if (currentCb && entry.current && !currentCb.checked) {
        currentCb.click();
        result.filled.push({ label: `Work Experience ${i + 1}: I currently work here`, value: "checked" });
      }
      const from = toMonthYear(entry.from);
      if (from && startMonth && startYear) {
        setReactValue(startMonth, from.month);
        setReactValue(startYear, from.year);
        result.filled.push({ label: `Work Experience ${i + 1}: Start Date`, value: `${from.month}/${from.year}` });
      }
      if (!entry.current) {
        const to = toMonthYear(entry.to);
        if (to && endMonth && endYear) {
          setReactValue(endMonth, to.month);
          setReactValue(endYear, to.year);
          result.filled.push({ label: `Work Experience ${i + 1}: End Date`, value: `${to.month}/${to.year}` });
        }
      }
      if (roleDesc && entry.description) { setReactValue(roleDesc, entry.description); result.filled.push({ label: `Work Experience ${i + 1}: Role Description`, value: entry.description }); }
    }
  }

  // ---------- Education ----------
  const educationEntries = parseEducation(profile.education);
  if (educationEntries.length === 0) {
    result.skipped.push({ label: "Education", reason: "profile has no parsable education text" });
  } else {
    let addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]')).filter((b) => b.getClientRects().length > 0);
    for (let i = blockIndices("education").length; i < educationEntries.length; i++) {
      const grew = await addAnotherBlock("education", addButtons, 1);
      if (!grew) break;
      addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]')).filter((b) => b.getClientRects().length > 0);
    }
    const indices = blockIndices("education");
    for (let i = 0; i < Math.min(indices.length, educationEntries.length); i++) {
      const idx = indices[i];
      const entry = educationEntries[i];
      const schoolEl = document.getElementById(`education-${idx}--school`);
      const degreeBtn = document.getElementById(`education-${idx}--degree`);
      const fieldEl = document.getElementById(`education-${idx}--fieldOfStudy`);

      if (schoolEl && entry.school) {
        const picked = await fillTypeahead(schoolEl, entry.school);
        result.filled.push({ label: `Education ${i + 1}: School`, value: picked || "(no option found)" });
      }
      if (degreeBtn && entry.degree) {
        const picked = await fillButtonDropdown(degreeBtn, entry.degree);
        if (picked) result.filled.push({ label: `Education ${i + 1}: Degree`, value: picked });
        else result.skipped.push({ label: `Education ${i + 1}: Degree`, reason: "no confident match, left for you" });
      }
      if (fieldEl && entry.fieldOfStudy) {
        const picked = await fillTypeahead(fieldEl, entry.fieldOfStudy);
        result.filled.push({ label: `Education ${i + 1}: Field of Study`, value: picked || "(no option found)" });
      }

      // Not every Workday tenant asks for these -- confirmed live that Shell's
      // does (gradeAverage, firstYearAttended/lastYearAttended as YEAR-only
      // fields, unlike Airbus which didn't have this section at all) while
      // Airbus's didn't have them. Filled only when the field actually exists.
      const gradeEl = document.getElementById(`education-${idx}--gradeAverage`);
      if (gradeEl && entry.gpa) { setReactValue(gradeEl, entry.gpa); result.filled.push({ label: `Education ${i + 1}: Grade Average`, value: entry.gpa }); }
      const firstYearEl = document.getElementById(`education-${idx}--firstYearAttended-dateSectionYear-input`);
      if (firstYearEl && entry.from) { setReactValue(firstYearEl, entry.from); result.filled.push({ label: `Education ${i + 1}: First Year Attended`, value: entry.from }); }
      const lastYearEl = document.getElementById(`education-${idx}--lastYearAttended-dateSectionYear-input`);
      if (lastYearEl && entry.to && entry.to !== "present") { setReactValue(lastYearEl, entry.to); result.filled.push({ label: `Education ${i + 1}: Last Year Attended`, value: entry.to }); }
    }
  }

  } catch (e) {
    result.error = e.message || String(e);
  }

  return result;
};

// Clicks a Save/Continue/Next-style button to advance a multi-page
// application -- NEVER a Submit/Apply/Finish button, checked defensively
// even though the two regexes shouldn't overlap. Returns true if it
// actually clicked something (the caller re-scans the new page itself).
window.__acrAdvance = function () {
  const CONTINUE_RE = /^\s*(save|continue|next)\s*(and\s*continue)?\s*$|save\s*(&|and)\s*continue/i;
  const SUBMIT_RE = /submit|^\s*apply(\s*now)?\s*$|finish|send\s*application|review\s*and\s*submit/i;
  const buttons = Array.from(document.querySelectorAll("button")).filter((b) => b.getClientRects().length > 0);
  const btn = buttons.find((b) => CONTINUE_RE.test((b.innerText || "").trim()) && !SUBMIT_RE.test((b.innerText || "").trim()));
  if (!btn) return false;
  btn.click();
  return true;
};
