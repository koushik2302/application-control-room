import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const release = path.join(root, "release");

fs.cpSync(path.join(root, "dist"), path.join(release, "dist"), { recursive: true });

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
