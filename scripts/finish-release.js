import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const release = path.join(root, "release");

fs.cpSync(path.join(root, "dist"), path.join(release, "dist"), { recursive: true });

// Real Arial TTFs, copied as plain files next to the exe (not via pkg's
// asset-embedding, which silently drops everything -- see the comment in
// pdfShared.js). Read at runtime via baseDir, same as dist/.env/data.
fs.cpSync(path.join(root, "fonts"), path.join(release, "fonts"), { recursive: true });

// server/autofillWorker.js runs the actual Playwright automation in its own
// real Node process (see its header comment and server/autofill.js -- short
// version: playwright needs node:inspector, which pkg's packaged exe
// doesn't support). It needs three things next to the exe to do that:
// 1. Its own source file plus the local modules it transitively imports
//    (llm.js, and llm.js's own tavily.js/textBlocks.js), copied as plain
//    scripts -- NOT bundled, so `require("playwright")` inside
//    playwright-core's own files can still find real files relative to its
//    own real __dirname at runtime.
//    verifyWorker.js is a second Playwright worker (spawned by verify.js during
//    a search run to render each candidate posting and read its real
//    location/date/company from JSON-LD) -- referenced by path and run as its
//    own process, same as autofillWorker.js. verify.js + paths.js are copied
//    too because the standalone llm.js above now imports verify.js (which
//    imports paths.js), so the worker-side llm.js module graph resolves on disk.
fs.mkdirSync(path.join(release, "server"), { recursive: true });
for (const f of ["autofillWorker.js", "verifyWorker.js", "verify.js", "llm.js", "tavily.js", "textBlocks.js", "paths.js"]) {
  fs.cpSync(path.join(root, "server", f), path.join(release, "server", f));
}

// 2. Real playwright/playwright-core package folders (a normal npm package,
//    not something pkg's snapshot can host the way it hosts plain data --
//    same class of problem as the fonts above, worse in playwright's case
//    since it also spawns/talks to a real external browser process).
//    Skipped with a clear warning (rather than a silently broken release)
//    if `npm install` hasn't been run.
for (const pkgName of ["playwright", "playwright-core"]) {
  const src = path.join(root, "node_modules", pkgName);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(release, "node_modules", pkgName), { recursive: true });
  } else {
    console.warn(`WARNING: node_modules/${pkgName} not found -- run "npm install" first. Autofill won't work in this release build.`);
  }
}

// 3. A real, portable node.exe to actually run the worker script as (the
//    packaged exe's own process.execPath isn't a usable plain Node runtime
//    -- see above). Windows Node builds are a single self-contained binary,
//    so copying just the exe is sufficient; sourced from wherever `node` is
//    currently running this build script.
{
  const portableNode = path.join(release, "node", "node.exe");
  if (!fs.existsSync(portableNode)) {
    fs.mkdirSync(path.join(release, "node"), { recursive: true });
    fs.cpSync(process.execPath, portableNode);
  }
}

if (!fs.existsSync(path.join(release, ".env")) && fs.existsSync(path.join(root, ".env"))) {
  fs.cpSync(path.join(root, ".env"), path.join(release, ".env"));
} else if (!fs.existsSync(path.join(release, ".env.example"))) {
  fs.cpSync(path.join(root, ".env.example"), path.join(release, ".env.example"));
}

const launcher = `@echo off
cd /d "%~dp0"
echo Application Control Room starting...
echo Leave this window open - it keeps the daily auto-search/tailor job running.
ApplicationControlRoom.exe
pause
`;
fs.writeFileSync(path.join(release, "Start Application Control Room.bat"), launcher);

console.log("\nRelease folder ready: " + release);
console.log("Copy your real TAVILY_API_KEY into release/.env (see .env.example), make sure `ollama serve`");
console.log("is running with the qwen3:8b model pulled, then double-click");
console.log('"Start Application Control Room.bat", or run ApplicationControlRoom.exe directly.');
console.log("Open http://localhost:3001 in a browser while it's running.");
