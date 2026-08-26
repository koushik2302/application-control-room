// Service worker: the only place with the "debugger" permission, so it's the
// only place that can set a real file into a file input the same way the
// desktop app's Playwright path does (DOM.setFileInputFiles over the Chrome
// DevTools Protocol). Everything else (scanning/filling text fields) happens
// in content.js, injected on demand into the active tab -- nothing here runs
// on every page load.

const SERVER = "http://localhost:3001";

async function getJson(path) {
  const res = await fetch(SERVER + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Attaches just long enough to push one file into one <input type=file>,
// found via the data-acr-file marker content.js stamped on it, then detaches
// immediately -- keeps the "this tab is being debugged" banner as brief as
// the manifest lets it be, rather than leaving the tab attached for the
// whole review session.
async function setFileInput(tabId, marker, filePath) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const { root } = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-acr-file="${marker}"]`,
    });
    if (!nodeId) throw new Error(`Could not re-locate the file field (${marker}) via CDP.`);
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: [filePath], nodeId });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_PROFILE") {
        sendResponse({ ok: true, data: await getJson("/api/profile") });
      } else if (msg.type === "GET_TICKETS") {
        sendResponse({ ok: true, data: await getJson("/api/tickets") });
      } else if (msg.type === "GET_TICKET_FILES") {
        sendResponse({ ok: true, data: await getJson(`/api/tickets/${encodeURIComponent(msg.ticketId)}/files`) });
      } else if (msg.type === "UPLOAD_FILE") {
        await setFileInput(msg.tabId, msg.marker, msg.filePath);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the channel open for the async response above
});
