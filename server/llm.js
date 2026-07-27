import { tavilySearch } from "./tavily.js";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

async function callOllama({ system, userMsg }) {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        stream: false,
        format: "json",
        think: false,
        // Keep the model resident between calls so it doesn't have to reload
        // from disk into VRAM on every request (that reload, not inference
        // itself, is what was causing multi-minute stalls).
        keep_alive: "30m",
        options: { num_ctx: 8192 },
      }),
      // Fail with a clear message well before Node's own opaque ~5min default
      // headers timeout, instead of the request silently hanging.
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.cause?.code === "UND_ERR_HEADERS_TIMEOUT") {
      throw new Error(
        `Ollama didn't respond within 2 minutes. It may still be loading the "${MODEL}" model into memory — wait a few seconds and try again.`
      );
    }
    throw new Error(`Couldn't reach Ollama at ${OLLAMA_URL} — is \`ollama serve\` running? (${e.message})`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama error ${response.status}: ${body.slice(0, 300)} — is Ollama running (\`ollama serve\`) with the "${MODEL}" model pulled?`
    );
  }
  const data = await response.json();
  const text = (data.message?.content || "").trim();
  return JSON.parse(text);
}

export async function tailor({ profile, company, role, jd }) {
  const sys = `You are a resume-tailoring analyst for a strict, no-fabrication process. You will be given a candidate's real resume content and a job description. Your job:
1. Extract the 10-15 most important keywords/skills/requirements from the JD.
2. Classify each as MATCHED (clearly present in candidate's content), PARTIAL (related/adjacent experience exists), or MISSING (no real basis in candidate's content).
3. For MATCHED and PARTIAL items only, suggest 2-4 rewritten resume bullets that reuse the candidate's real experience but mirror the JD's language/keywords. NEVER invent metrics, tools, or responsibilities the candidate did not state.
4. Give an honest ATS match score 0-100 based on overlap, not optimism.
5. List MISSING items plainly so the candidate knows the real gap — do not paper over it.

Respond ONLY with valid JSON, in this exact shape:
{"matchScore": number, "matched": string[], "partial": string[], "missing": string[], "tailoredBullets": string[], "notes": string}`;

  const userMsg = `CANDIDATE RESUME CONTENT:
Summary: ${profile.summary || "(none provided)"}
Experience: ${profile.experience || "(none provided)"}
Projects: ${profile.projects || "(none provided)"}
Skills: ${profile.skills || "(none provided)"}

JOB DESCRIPTION (${role || "role"} at ${company || "company"}):
${jd}`;

  return callOllama({ system: sys, userMsg });
}

export async function search({ profile, query, location }) {
  const resumeKeywords = `${profile.skills || ""} ${profile.experience || ""} ${profile.projects || ""}`.slice(0, 1500);

  const rawResults = await tavilySearch(`${query} internship ${location || ""}`.trim(), { maxResults: 8 });
  const rawUrls = new Set(rawResults.map((r) => r.url));

  const sys = `You are an internship-posting scout. You will be given RAW WEB SEARCH RESULTS (title, url, content snippet, published date if known) already fetched for a candidate's query. Your job is to turn them into a clean, ranked list of genuine, currently-open internship postings.

STRICT RULES:
- Only use the "url" field EXACTLY as given in a raw result below. Never alter, guess, or construct a URL.
- Only include a result if it is a specific internship posting (identifiable company + role), not a generic listing/aggregator page (e.g. "1000+ internships in India", a search-results page, a category index) or an article/listicle.
- If none of the raw results are genuine specific postings, return an empty "results" array and say why in "searchNotes". An empty list is correct and expected sometimes — never invent a posting, company, or URL to avoid returning empty.

For each qualifying result, extract: company, role title, platform/source, the direct URL (copied verbatim from the raw result), how recently it was posted (use the given date if present, else "recent" or "unknown"), a short snippet of the actual role description, and a matchScore 0-100 estimating fit against the candidate's background below.

Candidate background (skills/experience/projects, for match scoring only — do not fabricate anything about the postings):
${resumeKeywords}

Respond ONLY with valid JSON, in this exact shape:
{"results": [{"company": string, "role": string, "platform": string, "url": string, "postedRecency": string, "matchScore": number, "snippet": string}], "searchNotes": string}`;

  const userMsg = `Query: "${query}" in/around ${location || "any location"}.

RAW SEARCH RESULTS:
${JSON.stringify(
  rawResults.map((r) => ({
    title: r.title,
    url: r.url,
    content: (r.content || "").slice(0, 500),
    published_date: r.published_date,
  })),
  null,
  2
)}

Return up to 8 of the best genuine postings, or fewer/none if the raw results don't contain genuine specific postings.`;

  const parsed = await callOllama({ system: sys, userMsg });

  // Hard guardrail, independent of the model following instructions: drop
  // anything whose URL wasn't actually in the search results we gave it.
  // A local model is more prone to filling gaps with plausible-looking
  // invented postings than a frontier one, so don't just trust the prompt.
  const before = parsed.results?.length || 0;
  parsed.results = (parsed.results || []).filter((r) => rawUrls.has(r.url));
  const dropped = before - parsed.results.length;
  if (dropped > 0) {
    parsed.searchNotes = `${parsed.searchNotes || ""} (${dropped} result(s) removed — URL didn't match a genuine search result.)`.trim();
  }

  return parsed;
}
