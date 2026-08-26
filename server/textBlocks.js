// Shared parsing for profile.experience/profile.projects: each field is a
// flat string where a line with no leading "-" starts a new entry (a job or
// a project), and subsequent "-"-prefixed lines are that entry's bullets.
// Used by both the tailoring prompt (llm.js) and the resume renderer
// (resume.js) so an entry's title and its bullets can never drift apart.

export function splitLines(text) {
  return (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function parseEntries(text) {
  const entries = [];
  for (const line of splitLines(text)) {
    if (line.startsWith("-")) {
      const bullet = line.replace(/^-\s*/, "");
      if (entries.length) entries[entries.length - 1].bullets.push(bullet);
    } else {
      entries.push({ title: line, bullets: [] });
    }
  }
  return entries;
}
