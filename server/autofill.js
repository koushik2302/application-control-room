// Opens a real job posting in a visible browser window and fills in
// whatever it can determine from the profile, then STOPS -- it never clicks
// Submit/Apply/Next/anything, and never touches a password or
// account-creation field. Reviewing and submitting stays a deliberate
// manual action by the user, every time (mirrors dailyRun.js's own rule:
// "Never submits anything -- Draft is the end of the automated part").
//
// The actual Playwright automation runs in autofillWorker.js, in its own
// real Node process -- see that file's header comment for why (short
// version: playwright needs node:inspector, which pkg's packaged exe
// doesn't support; confirmed directly via ERR_INSPECTOR_NOT_AVAILABLE).
// This file is just the parent-side plumbing: resolve a real node binary
// and the worker script's real path, spawn it, hand it what it needs over
// stdin, and read its one-line JSON result back over stdout.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { baseDir } from "./paths.js";
import { resumeFilePath } from "./resume.js";
import { coverLetterFilePath } from "./coverLetter.js";

// Real OS install path -- entirely outside the app's own directory tree, so
// it needs no packaging of its own (same tier of external prerequisite as
// Ollama already is for this app, per finish-release.js's setup instructions).
const BRAVE_PATH = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

const DONE_MARKER = "__ACR_AUTOFILL_DONE__";

function resolveNodeBinary() {
  if (process.pkg) {
    // process.execPath here points at the pkg exe itself, which lacks
    // node:inspector -- a real portable node.exe is copied next to it by
    // finish-release.js for exactly this reason.
    return path.join(baseDir, "node", "node.exe");
  }
  return process.execPath; // dev mode: whatever real node is already running this server
}

function resolveWorkerScriptPath() {
  // Real file on disk either way -- server/autofillWorker.js in dev, or
  // copied next to the exe (same baseDir pattern as fonts/) when packaged.
  // import.meta.url is resolved lazily, only on the dev-mode branch: esbuild
  // empties `import.meta` when bundling to CJS for the packaged build (it
  // logs a warning about this), so evaluating it unconditionally at module
  // load would throw inside the packaged exe even though that branch is
  // never actually taken there.
  if (process.pkg) return path.join(baseDir, "server", "autofillWorker.js");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "autofillWorker.js");
}

export async function autofillApplication({ profile, ticket }) {
  const nodeBin = resolveNodeBinary();
  const workerPath = resolveWorkerScriptPath();

  if (!fs.existsSync(nodeBin)) {
    return { error: `Autofill needs a real Node runtime at "${nodeBin}" but it's missing. Rebuild the release (npm run build:exe) or run via "npm run dev" instead.` };
  }
  if (!fs.existsSync(workerPath)) {
    return { error: `Autofill worker script not found at "${workerPath}".` };
  }

  // A stable, app-owned browser profile dir so the autofill browser remembers
  // logins between runs -- sign in to a gated ATS (Workday/Oracle/iCIMS) once
  // and every later application on it is already authenticated, no re-entering
  // an email/login per posting.
  const userDataDir = path.join(baseDir, "autofill-browser-profile");
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch {
    /* best-effort; launchPersistentContext will surface a real failure */
  }

  const payload = JSON.stringify({
    profile,
    ticket,
    resumeFilePath: resumeFilePath(ticket),
    coverLetterFilePath: coverLetterFilePath(ticket),
    bravePath: BRAVE_PATH,
    userDataDir,
  });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodeBin, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ error: `Couldn't start the autofill worker: ${e.message}` });
      return;
    }

    let out = "";
    let err = "";
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    child.stdout.on("data", (d) => {
      out += d.toString();
      const idx = out.indexOf(DONE_MARKER);
      if (idx !== -1) {
        try {
          finish(JSON.parse(out.slice(0, idx)));
        } catch (e) {
          finish({ error: `Couldn't parse autofill worker output: ${e.message}` });
        }
      }
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish({ error: `Autofill worker process error: ${e.message}` }));
    child.on("exit", (code) => {
      // Only an unexpected-exit error if we never got a result -- a normal
      // run exits later, on its own, once the user closes the browser
      // window (see autofillWorker.js), well after we've already resolved.
      finish({ error: `Autofill worker exited before finishing (code ${code}). ${err.slice(0, 500)}` });
    });

    // Don't let this child (or, transitively, its browser) keep the parent
    // server process from exiting normally on its own -- it's meant to
    // outlive this one request, not be tracked as a reason to stay alive.
    child.unref();

    child.stdin.write(payload);
    child.stdin.end();
  });
}
