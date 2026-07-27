import path from "path";

// When bundled with pkg into a single .exe, everything required by the code
// lives in a read-only virtual snapshot — so data/dist/.env must be resolved
// relative to the real executable on disk. Otherwise (dev/server scripts,
// always launched from the project root via npm) the current working
// directory is the project root.
export const baseDir = process.pkg ? path.dirname(process.execPath) : process.cwd();
