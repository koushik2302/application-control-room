import path from "path";
import dotenv from "dotenv";
import { baseDir } from "./paths.js";

// Must be imported first, before any module that reads process.env at its own
// top level (e.g. store.js's DATA_DIR) — ES modules evaluate every imported
// module's top-level code before the importing file's own code runs, so a
// dotenv.config() call placed inline further down in index.js runs too late.
dotenv.config({ path: path.join(baseDir, ".env") });
