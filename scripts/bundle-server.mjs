import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

await build({
  entryPoints: [path.join(root, "server", "index.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(root, "server-bundle", "server.cjs"),
  logLevel: "info",
});
