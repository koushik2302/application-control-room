// Parent-side plumbing for the posting-verification worker (verifyWorker.js).
// Spawns it in its own real Node process (see that file + autofill.js for why
// the packaged exe can't run Playwright in-process), hands it the candidate
// URLs over stdin, and returns a { url -> info } map. Mirrors autofill.js's
// node-binary / worker-path resolution and marker protocol. Never throws -- on
// any failure it resolves to an empty map, and the caller treats an
// unverifiable posting as "drop", so a broken verifier fails safe (fewer
// tickets) rather than storing unverified junk.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { baseDir } from "./paths.js";

const BRAVE_PATH = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const DONE_MARKER = "__ACR_VERIFY_DONE__";

function resolveNodeBinary() {
  if (process.pkg) return path.join(baseDir, "node", "node.exe");
  return process.execPath;
}

function resolveWorkerScriptPath() {
  // import.meta resolved lazily on the dev branch only (esbuild empties it under
  // the packaged CJS build) -- same guard as autofill.js.
  if (process.pkg) return path.join(baseDir, "server", "verifyWorker.js");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "verifyWorker.js");
}

export async function verifyPostings(urls, { timeoutMs = 120000 } = {}) {
  if (!urls || urls.length === 0) return {};

  const nodeBin = resolveNodeBinary();
  const workerPath = resolveWorkerScriptPath();
  if (!fs.existsSync(nodeBin) || !fs.existsSync(workerPath)) return {};

  const payload = JSON.stringify({ urls, bravePath: BRAVE_PATH });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodeBin, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({});
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({});
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      out += d.toString();
      const idx = out.indexOf(DONE_MARKER);
      if (idx !== -1) {
        clearTimeout(killTimer);
        try {
          const parsed = JSON.parse(out.slice(0, idx));
          finish(parsed.results && typeof parsed.results === "object" ? parsed.results : {});
        } catch {
          finish({});
        }
      }
    });
    child.on("error", () => {
      clearTimeout(killTimer);
      finish({});
    });
    child.on("exit", () => {
      clearTimeout(killTimer);
      finish({});
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}
