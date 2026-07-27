const TAVILY_URL = "https://api.tavily.com/search";

function apiKey() {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set (see .env.example)");
  return key;
}

// Returns raw web results ({title, url, content, published_date}); ranking
// and extraction into our posting schema happens separately via the LLM.
// Tavily doesn't support Google-style "site:" operators in the query string
// (they get silently stripped) — use includeDomains instead for real
// domain restriction.
export async function tavilySearch(query, { maxResults = 10, includeDomains } = {}) {
  const response = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey(),
      query,
      max_results: maxResults,
      search_depth: "advanced",
      ...(includeDomains ? { include_domains: includeDomains } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Tavily API error ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.results || [];
}
