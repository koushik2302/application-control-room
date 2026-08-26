const ticketSelect = document.getElementById("ticket");
const autoUploadBox = document.getElementById("autoUpload");
const runBtn = document.getElementById("run");
const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error((res && res.error) || "Unknown error"));
      resolve(res.data);
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const stored = await chrome.storage.local.get(["autoUpload"]);
  autoUploadBox.checked = !!stored.autoUpload;
  autoUploadBox.addEventListener("change", () => chrome.storage.local.set({ autoUpload: autoUploadBox.checked }));

  try {
    const [tickets, tab] = await Promise.all([send({ type: "GET_TICKETS" }), activeTab()]);
    ticketSelect.innerHTML = "";
    let preselect = 0;
    tickets.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.id} — ${t.company}`;
      ticketSelect.appendChild(opt);
      if (tab && t.sourceUrl && tab.url && sameHost(t.sourceUrl, tab.url)) preselect = i;
    });
    ticketSelect.selectedIndex = preselect;
  } catch (e) {
    setStatus(`Couldn't reach Control Room at localhost:3001 — is the app running?\n${e.message}`, true);
    runBtn.disabled = true;
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function exec(tabId, func, args) {
  const [injectionResult] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  // chrome.scripting.executeScript does NOT reject when the injected function
  // itself throws -- it just omits `result` for that frame and puts the
  // failure in `.error` instead. Reading `.filled.length` off an undefined
  // result was throwing a much less useful error later, masking whatever
  // actually broke inside the page. Surface it directly.
  if (injectionResult.error) throw new Error(String(injectionResult.error.message || injectionResult.error));
  return injectionResult.result;
}

// Fills whichever fields exist on the CURRENT page: the generic text/select/
// radio scan always runs, and the Work Experience/Education filler runs too
// if this happens to be the "My Experience" page (detected by the presence
// of workExperience-*/education-* fields Workday's own markup uses).
async function fillCurrentPage(tabId, profile) {
  const generic = await exec(tabId, (p) => window.__acrFill(p, {}), [profile]);
  const hasExperienceFields = await exec(tabId, () => !!document.querySelector('[id^="workExperience-"], [id^="education-"]'), []);
  let experience = null;
  if (hasExperienceFields) {
    experience = await exec(
      tabId,
      (p) => window.__acrFillExperience(p),
      [profile]
    );
  }
  return { generic, experience };
}

async function handleFileFields(tab, fileFields) {
  const lines = [];
  const ticketId = ticketSelect.value;
  if (autoUploadBox.checked && ticketId) {
    const files = await send({ type: "GET_TICKET_FILES", ticketId });
    for (const f of fileFields) {
      const isCoverLetter = /cover/i.test(f.label);
      const filePath = isCoverLetter ? files.coverLetterPath : files.resumePath || files.coverLetterPath;
      if (!filePath) {
        lines.push(`- "${f.label}": no file on disk for ${ticketId} — dropped in manually instead.`);
        continue;
      }
      try {
        await send({ type: "UPLOAD_FILE", tabId: tab.id, marker: f.marker, filePath });
        lines.push(`- "${f.label}": uploaded via ${ticketId}.`);
      } catch (e) {
        lines.push(`- "${f.label}": auto-upload failed (${e.message}) — drop it in manually.`);
      }
    }
  } else if (fileFields.length > 0) {
    lines.push(`${fileFields.length} file field(s) highlighted in red — drop the resume/cover letter in yourself.`);
  }
  return lines;
}

// Fills the current page, then repeatedly clicks Save/Continue and fills
// whatever page it lands on next -- Application Questions, Voluntary
// Disclosures (which will mostly just get skipped per-field, since those
// are demographic/EEO questions the generic filler already refuses to
// touch), stopping at Review. HARD SAFETY RULE, same as the desktop tool:
// __acrAdvance() in content.js only ever clicks a Save/Continue/Next button,
// never Submit/Apply/Finish -- so this loop naturally stops at the
// review/submit step without ever risking an actual submission.
const MAX_PAGES = 8;
async function run() {
  runBtn.disabled = true;
  try {
    const tab = await activeTab();
    if (!tab || !tab.id) throw new Error("No active tab.");
    const profile = await send({ type: "GET_PROFILE" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

    const allLines = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      setStatus(`Filling page ${page}…`);
      const { generic, experience } = await fillCurrentPage(tab.id, profile);
      allLines.push(`Page ${page}: filled ${generic.filled.length}, left ${generic.skipped.length} for you.`);
      if (experience) {
        allLines.push(`  My Experience: filled ${experience.filled.length}, left ${experience.skipped.length} for you.`);
        if (experience.error) allLines.push(`  My Experience error (stopped early): ${experience.error}`);
      }
      if (generic.fileFields.length > 0) {
        allLines.push(...(await handleFileFields(tab, generic.fileFields)).map((l) => "  " + l));
      }
      setStatus(allLines.join("\n"));

      const advanced = await exec(tab.id, () => window.__acrAdvance(), []);
      if (!advanced) break; // no Save/Continue button found -- likely the Review page, stop here
      await sleep(1500); // let the next page render before scanning it
    }

    allLines.push("Stopped before Review — nothing was submitted. Check everything, then submit yourself.");
    setStatus(allLines.join("\n"));
  } catch (e) {
    setStatus(`Error: ${e.message}`, true);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", run);
init();
