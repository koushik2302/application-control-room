import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Note on fonts: PDFKit's standard-14 fonts (Helvetica, Times-Roman, ...)
// load their .afm metrics from a "data" folder resolved via __dirname,
// which breaks once esbuild bundles everything into a single server.cjs
// (and pkg's asset-embedding doesn't reliably pick up extra files either --
// confirmed empty matches, likely due to this project path containing
// literal parentheses that break its glob matching). server/resume.js
// sidesteps this entirely by registering the real Times New Roman TTFs
// from fonts/ (copied next to the exe by finish-release.js) instead of
// depending on PDFKit's standard fonts at all.
await build({
  entryPoints: [path.join(root, "server", "index.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(root, "server-bundle", "server.cjs"),
  logLevel: "info",
});

// server/autofillWorker.js is NOT part of this bundle, deliberately -- it
// runs in its own separate, real Node process (spawned by server/autofill.js)
// because `playwright` needs node:inspector, which isn't available inside
// pkg's packaged exe (confirmed directly: ERR_INSPECTOR_NOT_AVAILABLE at
// runtime). It's copied as a plain script next to the exe by
// finish-release.js, alongside a real node_modules/playwright(-core) and a
// portable node.exe, so it runs as an ordinary standalone Node script.
