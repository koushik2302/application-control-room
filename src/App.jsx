import { useState, useEffect, useCallback } from "react";

// ---------- Design tokens ----------
// Palette: operations/incident-desk feel — nods to L1/L2 queue background
const FONT_LINK_ID = "acr-fonts";

function useFonts() {
  useEffect(() => {
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500&display=swap";
    document.head.appendChild(link);
  }, []);
}

const emptyProfile = {
  name: "",
  tagline: "",
  email: "",
  phone: "",
  location: "",
  address: "",
  city: "",
  pincode: "",
  linkedin: "",
  github: "",
  portfolio: "",
  summary: "",
  education: "",
  experience: "",
  projects: "",
  skills: "",
  certifications: "",
};

function statusColor(status) {
  switch (status) {
    case "Offer":
      return "#0E6E6A";
    case "Interview":
      return "#B8860B";
    case "Rejected":
      return "#B23A2E";
    case "Applied":
      return "#3D5A80";
    default:
      return "#8A8578"; // Draft
  }
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function App() {
  useFonts();
  const [tab, setTab] = useState("tailor");
  const [profile, setProfile] = useState(emptyProfile);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [runLog, setRunLog] = useState([]);

  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLocation, setSearchLocation] = useState("India");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState(null);

  const [wlQuery, setWlQuery] = useState("");
  const [wlLocation, setWlLocation] = useState("India");
  const [runTriggering, setRunTriggering] = useState(false);
  const [runError, setRunError] = useState("");

  const [autofillingId, setAutofillingId] = useState(null);
  const [autofillResults, setAutofillResults] = useState({}); // ticket id -> summary or {error}

  // ---- load persisted data from the local backend ----
  useEffect(() => {
    api("/profile")
      .then(setProfile)
      .catch(() => {})
      .finally(() => setProfileLoaded(true));
    api("/tickets").then(setTickets).catch(() => {});
    api("/watchlist").then(setWatchlist).catch(() => {});
    api("/run-log").then(setRunLog).catch(() => {});
  }, []);

  // First-run gate: a brand-new install (empty profile) forces the Profile
  // tab until real experience/projects are entered, so a new user can't end
  // up tailoring or tracking against a blank resume.
  const needsOnboarding = profileLoaded && !profile.experience && !profile.projects;
  useEffect(() => {
    if (needsOnboarding) setTab("profile");
  }, [needsOnboarding]);

  const saveProfile = useCallback(async (next) => {
    setProfile(next);
    try {
      await api("/profile", { method: "PUT", body: JSON.stringify(next) });
    } catch (e) {
      console.error("profile save failed", e);
    }
  }, []);

  const saveTickets = useCallback(async (next) => {
    setTickets(next);
    try {
      await api("/tickets", { method: "PUT", body: JSON.stringify(next) });
    } catch (e) {
      console.error("tickets save failed", e);
    }
  }, []);

  const saveWatchlist = useCallback(async (next) => {
    setWatchlist(next);
    try {
      await api("/watchlist", { method: "PUT", body: JSON.stringify(next) });
    } catch (e) {
      console.error("watchlist save failed", e);
    }
  }, []);

  async function runTailor() {
    setError("");
    setResult(null);
    if (!jd.trim()) {
      setError("Paste the job description first.");
      return;
    }
    if (!profile.experience && !profile.projects) {
      setError("Fill in your resume base (Profile tab) before tailoring.");
      return;
    }
    setLoading(true);
    try {
      const parsed = await api("/tailor", {
        method: "POST",
        body: JSON.stringify({ company, role, jd }),
      });
      setResult(parsed);
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't complete the analysis. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function runSearch() {
    setSearchError("");
    setSearchResults(null);
    if (!searchQuery.trim()) {
      setSearchError("Enter a role or keywords to search for.");
      return;
    }
    setSearchLoading(true);
    try {
      const parsed = await api("/search", {
        method: "POST",
        body: JSON.stringify({ query: searchQuery, location: searchLocation }),
      });
      setSearchResults(parsed);
    } catch (e) {
      console.error(e);
      setSearchError(e.message || "Couldn't complete the search. Try again, or narrow the keywords.");
    } finally {
      setSearchLoading(false);
    }
  }

  function pushToTailor(r) {
    setCompany(r.company || "");
    setRole(r.role || "");
    setJd(
      `${r.snippet || ""}${r.url ? `\n\nSource: ${r.url}` : ""}\n\n(Paste the full job description above this line if available — this is a scouted snippet, not the complete JD.)`
    );
    setResult(null);
    setTab("tailor");
  }

  async function logTicket() {
    if (!result) return;
    try {
      const next = await api("/tickets/log", {
        method: "POST",
        body: JSON.stringify({ company, role, jd, tailored: result }),
      });
      setTickets(next);
      setTab("tracker");
    } catch (e) {
      console.error("log ticket failed", e);
      setError(e.message || "Couldn't log the ticket. Try again.");
    }
  }

  async function updateStatus(id, status) {
    const next = tickets.map((t) => (t.id === id ? { ...t, status } : t));
    await saveTickets(next);
  }

  async function removeTicket(id) {
    const next = tickets.filter((t) => t.id !== id);
    await saveTickets(next);
  }

  // Opens the real posting in a visible browser window and fills in what it
  // can from the profile -- see server/autofill.js for the full guardrails.
  // Never submits anything; the window is left open for manual review.
  async function autofill(id) {
    setAutofillingId(id);
    setAutofillResults((prev) => ({ ...prev, [id]: null }));
    try {
      const summary = await api(`/tickets/${id}/autofill`, { method: "POST" });
      setAutofillResults((prev) => ({ ...prev, [id]: summary }));
    } catch (e) {
      setAutofillResults((prev) => ({ ...prev, [id]: { error: e.message || "Autofill failed." } }));
    } finally {
      setAutofillingId(null);
    }
  }

  function addWatch() {
    if (!wlQuery.trim()) return;
    saveWatchlist([...watchlist, { query: wlQuery.trim(), location: wlLocation.trim() || "India" }]);
    setWlQuery("");
  }

  function removeWatch(i) {
    saveWatchlist(watchlist.filter((_, idx) => idx !== i));
  }

  async function triggerRunNow() {
    setRunError("");
    setRunTriggering(true);
    try {
      const summary = await api("/daily-run/trigger", { method: "POST" });
      setRunLog([summary, ...runLog]);
      api("/tickets").then(setTickets).catch(() => {});
    } catch (e) {
      setRunError(e.message || "Run failed.");
    } finally {
      setRunTriggering(false);
    }
  }

  const styles = {
    page: {
      minHeight: "100vh",
      background: "#F5F3EE",
      color: "#22262B",
      fontFamily: "'Inter', sans-serif",
      padding: "0 0 48px",
    },
    header: {
      borderBottom: "1px solid #D8D3C8",
      padding: "28px 20px 20px",
      background: "#FFFFFF",
    },
    eyebrow: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      letterSpacing: "0.12em",
      color: "#8A8578",
      textTransform: "uppercase",
      marginBottom: 6,
    },
    h1: {
      fontFamily: "'IBM Plex Sans', sans-serif",
      fontWeight: 700,
      fontSize: 22,
      margin: 0,
      lineHeight: 1.25,
    },
    tabs: {
      display: "flex",
      gap: 4,
      marginTop: 18,
      flexWrap: "wrap",
    },
    tabBtn: (active) => ({
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12,
      letterSpacing: "0.04em",
      padding: "8px 14px",
      border: "1px solid #D8D3C8",
      borderBottom: active ? "1px solid #FFFFFF" : "1px solid #D8D3C8",
      background: active ? "#FFFFFF" : "transparent",
      color: active ? "#0E6E6A" : "#8A8578",
      cursor: "pointer",
      borderRadius: "4px 4px 0 0",
      fontWeight: active ? 600 : 400,
    }),
    body: { padding: "20px", maxWidth: 720, margin: "0 auto" },
    card: {
      background: "#FFFFFF",
      border: "1px solid #D8D3C8",
      borderRadius: 6,
      padding: 18,
      marginBottom: 16,
    },
    label: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "#8A8578",
      display: "block",
      marginBottom: 6,
    },
    input: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 10px",
      border: "1px solid #D8D3C8",
      borderRadius: 4,
      fontSize: 14,
      fontFamily: "'Inter', sans-serif",
      marginBottom: 14,
      background: "#FBFAF7",
      color: "#22262B",
      colorScheme: "light",
    },
    textarea: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 10px",
      border: "1px solid #D8D3C8",
      borderRadius: 4,
      fontSize: 14,
      fontFamily: "'Inter', sans-serif",
      marginBottom: 14,
      background: "#FBFAF7",
      color: "#22262B",
      colorScheme: "light",
      minHeight: 70,
      resize: "vertical",
    },
    btn: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      padding: "11px 18px",
      background: "#0E6E6A",
      color: "#FFFFFF",
      border: "none",
      borderRadius: 4,
      cursor: "pointer",
      fontWeight: 600,
    },
    btnGhost: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      letterSpacing: "0.04em",
      padding: "7px 12px",
      background: "transparent",
      color: "#8A8578",
      border: "1px solid #D8D3C8",
      borderRadius: 4,
      cursor: "pointer",
    },
    errorBox: {
      color: "#B23A2E",
      fontSize: 13,
      marginBottom: 10,
      fontFamily: "'IBM Plex Mono', monospace",
    },
    scoreWrap: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 },
    scoreNum: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 34,
      fontWeight: 500,
      color: "#0E6E6A",
    },
    tag: (kind) => ({
      display: "inline-block",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      padding: "3px 8px",
      borderRadius: 3,
      marginRight: 6,
      marginBottom: 6,
      background:
        kind === "matched" ? "#E6F2F1" : kind === "partial" ? "#FBF1DC" : "#F7E7E4",
      color:
        kind === "matched" ? "#0E6E6A" : kind === "partial" ? "#8A6A0B" : "#B23A2E",
    }),
    ticketRow: {
      border: "1px solid #D8D3C8",
      borderRadius: 6,
      padding: 14,
      marginBottom: 10,
      background: "#FFFFFF",
    },
    ticketHead: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8,
    },
    ticketId: {
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12,
      color: "#8A8578",
    },
    statusPill: (s) => ({
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      padding: "3px 9px",
      borderRadius: 20,
      color: "#FFFFFF",
      background: statusColor(s),
    }),
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.eyebrow}>Application Control Room — local</div>
        <h1 style={styles.h1}>Ticket every application like an incident — tailored, tracked, resolved.</h1>
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tabBtn(tab === "search"), opacity: needsOnboarding ? 0.4 : 1 }}
            onClick={() => !needsOnboarding && setTab("search")}
            disabled={needsOnboarding}
          >
            Search
          </button>
          <button
            style={{ ...styles.tabBtn(tab === "tailor"), opacity: needsOnboarding ? 0.4 : 1 }}
            onClick={() => !needsOnboarding && setTab("tailor")}
            disabled={needsOnboarding}
          >
            Tailor
          </button>
          <button
            style={{ ...styles.tabBtn(tab === "tracker"), opacity: needsOnboarding ? 0.4 : 1 }}
            onClick={() => !needsOnboarding && setTab("tracker")}
            disabled={needsOnboarding}
          >
            Tracker ({tickets.length})
          </button>
          <button
            style={{ ...styles.tabBtn(tab === "watchlist"), opacity: needsOnboarding ? 0.4 : 1 }}
            onClick={() => !needsOnboarding && setTab("watchlist")}
            disabled={needsOnboarding}
          >
            Watchlist ({watchlist.length})
          </button>
          <button style={styles.tabBtn(tab === "profile")} onClick={() => setTab("profile")}>
            Profile
          </button>
        </div>
      </div>

      <div style={styles.body}>
        {tab === "profile" && (
          <div style={styles.card}>
            {needsOnboarding && (
              <div
                style={{
                  background: "#FBF1DC",
                  border: "1px solid #E0C88A",
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 16,
                  fontSize: 13,
                  color: "#6B5417",
                }}
              >
                Welcome — fill in your real Experience and Projects below before anything else unlocks. Nothing gets
                tailored, searched, or tracked against a blank resume.
              </div>
            )}
            <label style={styles.label}>Name</label>
            <input
              style={styles.input}
              value={profile.name}
              onChange={(e) => saveProfile({ ...profile, name: e.target.value })}
              placeholder="Your name"
            />
            <label style={styles.label}>Tagline (shown under your name on the resume)</label>
            <input
              style={styles.input}
              value={profile.tagline}
              onChange={(e) => saveProfile({ ...profile, tagline: e.target.value })}
              placeholder='e.g. "MBA (Operations), Business Analytics Minor — Targeting Operations & Analyst Roles"'
            />
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              value={profile.email}
              onChange={(e) => saveProfile({ ...profile, email: e.target.value })}
              placeholder="you@email.com"
            />
            <label style={styles.label}>Phone</label>
            <input
              style={styles.input}
              value={profile.phone}
              onChange={(e) => saveProfile({ ...profile, phone: e.target.value })}
              placeholder="+91 ..."
            />
            <label style={styles.label}>Location</label>
            <input
              style={styles.input}
              value={profile.location}
              onChange={(e) => saveProfile({ ...profile, location: e.target.value })}
              placeholder="e.g. Bengaluru, India"
            />
            <label style={styles.label}>Address (street, for autofill address fields)</label>
            <input
              style={styles.input}
              value={profile.address}
              onChange={(e) => saveProfile({ ...profile, address: e.target.value })}
              placeholder="e.g. 105, Central Excise Revenue Layout-2, near Anjaneya Temple, S.K.Nagar post"
            />
            <label style={styles.label}>City (for autofill city fields)</label>
            <input
              style={styles.input}
              value={profile.city}
              onChange={(e) => saveProfile({ ...profile, city: e.target.value })}
              placeholder="e.g. Bangalore"
            />
            <label style={styles.label}>Pincode (for autofill PIN/postal fields)</label>
            <input
              style={styles.input}
              value={profile.pincode}
              onChange={(e) => saveProfile({ ...profile, pincode: e.target.value })}
              placeholder="e.g. 560077"
            />
            <label style={styles.label}>LinkedIn</label>
            <input
              style={styles.input}
              value={profile.linkedin}
              onChange={(e) => saveProfile({ ...profile, linkedin: e.target.value })}
              placeholder="linkedin.com/in/..."
            />
            <label style={styles.label}>GitHub</label>
            <input
              style={styles.input}
              value={profile.github}
              onChange={(e) => saveProfile({ ...profile, github: e.target.value })}
              placeholder="github.com/..."
            />
            <label style={styles.label}>Portfolio</label>
            <input
              style={styles.input}
              value={profile.portfolio}
              onChange={(e) => saveProfile({ ...profile, portfolio: e.target.value })}
              placeholder="yourportfolio.com"
            />
            <label style={styles.label}>Summary</label>
            <textarea
              style={styles.textarea}
              value={profile.summary}
              onChange={(e) => saveProfile({ ...profile, summary: e.target.value })}
              placeholder="2-3 line professional summary"
            />
            <label style={styles.label}>Education (one per line, e.g. "PES University — MBA, Operations & Business Analytics — Class of 2027")</label>
            <textarea
              style={{ ...styles.textarea, minHeight: 60 }}
              value={profile.education}
              onChange={(e) => saveProfile({ ...profile, education: e.target.value })}
              placeholder="School — Degree — Year"
            />
            <label style={styles.label}>Experience (real bullets, one per line)</label>
            <textarea
              style={{ ...styles.textarea, minHeight: 120 }}
              value={profile.experience}
              onChange={(e) => saveProfile({ ...profile, experience: e.target.value })}
              placeholder="e.g. Managed L1/L2 incident queues for 50+ enterprise customers..."
            />
            <label style={styles.label}>Projects (real bullets, one per line)</label>
            <textarea
              style={{ ...styles.textarea, minHeight: 100 }}
              value={profile.projects}
              onChange={(e) => saveProfile({ ...profile, projects: e.target.value })}
              placeholder="e.g. Built a discrete-event queue simulation in Python/SimPy..."
            />
            <label style={styles.label}>Skills (one category per line: "Category: comma, separated, items")</label>
            <textarea
              style={styles.textarea}
              value={profile.skills}
              onChange={(e) => saveProfile({ ...profile, skills: e.target.value })}
              placeholder="Operations: Process improvement, root-cause analysis...&#10;Technical: Python, SQL, ..."
            />
            <label style={styles.label}>Certifications (one per line, e.g. "Name — Issuer, Year")</label>
            <textarea
              style={{ ...styles.textarea, minHeight: 60 }}
              value={profile.certifications}
              onChange={(e) => saveProfile({ ...profile, certifications: e.target.value })}
              placeholder="Lean Six Sigma: Green Belt Fundamentals — Alison, 2026"
            />
            <div style={{ fontSize: 12, color: "#8A8578" }}>
              Saved locally to server/data.json on this machine. This is your real resume content — the tailoring step only rewrites phrasing, never invents facts.
            </div>
          </div>
        )}

        {tab === "search" && (
          <div>
            <div style={styles.card}>
              <label style={styles.label}>Role / keywords</label>
              <input
                style={styles.input}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g. operations analyst intern, supply chain intern"
              />
              <label style={styles.label}>Location</label>
              <input
                style={styles.input}
                value={searchLocation}
                onChange={(e) => setSearchLocation(e.target.value)}
                placeholder="e.g. India, Bengaluru, remote"
              />
              {searchError && <div style={styles.errorBox}>{searchError}</div>}
              <button style={styles.btn} onClick={runSearch} disabled={searchLoading}>
                {searchLoading ? "Scouting…" : "Search for postings"}
              </button>
              <div style={{ fontSize: 12, color: "#8A8578", marginTop: 10 }}>
                Scouts LinkedIn, Internshala, Naukri, and company career pages, ranked by recency and fit together. You still apply yourself — this just finds and prioritizes the postings.
              </div>
            </div>

            {searchResults?.results?.length > 0 && (
              <div>
                {searchResults.results.map((r, i) => (
                  <div key={i} style={styles.ticketRow}>
                    <div style={styles.ticketHead}>
                      <span style={styles.ticketId}>{r.platform} · {r.postedRecency}</span>
                      <span style={{ ...styles.tag("matched"), marginRight: 0 }}>{r.matchScore}/100</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{r.role}</div>
                    <div style={{ fontSize: 13, color: "#8A8578", marginBottom: 8 }}>{r.company}</div>
                    <div style={{ fontSize: 13, marginBottom: 10 }}>{r.snippet}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button style={styles.btn} onClick={() => pushToTailor(r)}>
                        Tailor for this
                      </button>
                      {r.url && (
                        <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#0E6E6A" }}>
                          Open posting ↗
                        </a>
                      )}
                    </div>
                  </div>
                ))}
                {searchResults.searchNotes && (
                  <div style={{ fontSize: 12, color: "#8A6A0B", marginTop: 4 }}>{searchResults.searchNotes}</div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "tailor" && (
          <div>
            <div style={styles.card}>
              <label style={styles.label}>Company</label>
              <input style={styles.input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Flipkart" />
              <label style={styles.label}>Role</label>
              <input style={styles.input} value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Operations Analyst Intern" />
              <label style={styles.label}>Job description</label>
              <textarea
                style={{ ...styles.textarea, minHeight: 140 }}
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder="Paste the full JD here"
              />
              {error && <div style={styles.errorBox}>{error}</div>}
              <button style={styles.btn} onClick={runTailor} disabled={loading}>
                {loading ? "Analyzing…" : "Tailor for this posting"}
              </button>
            </div>

            {result && (
              <div style={styles.card}>
                <div style={styles.scoreWrap}>
                  <span style={styles.scoreNum}>{result.matchScore}</span>
                  <span style={{ color: "#8A8578", fontSize: 12 }}>/ 100 ATS match</span>
                </div>

                {result.matched?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    {result.matched.map((m, i) => (
                      <span key={i} style={styles.tag("matched")}>✓ {m}</span>
                    ))}
                  </div>
                )}
                {result.partial?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    {result.partial.map((m, i) => (
                      <span key={i} style={styles.tag("partial")}>~ {m}</span>
                    ))}
                  </div>
                )}
                {result.missing?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    {result.missing.map((m, i) => (
                      <span key={i} style={styles.tag("missing")}>✕ {m}</span>
                    ))}
                  </div>
                )}

                <label style={styles.label}>Tailored bullets to use</label>
                <ul style={{ paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
                  {result.tailoredBullets?.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>

                {result.notes && (
                  <div style={{ fontSize: 13, color: "#8A6A0B", marginTop: 8 }}>{result.notes}</div>
                )}

                <div style={{ marginTop: 14 }}>
                  <button style={styles.btn} onClick={logTicket}>
                    Log to tracker
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "watchlist" && (
          <div>
            <div style={styles.card}>
              <label style={styles.label}>Role / keywords to watch</label>
              <input
                style={styles.input}
                value={wlQuery}
                onChange={(e) => setWlQuery(e.target.value)}
                placeholder="e.g. operations analyst intern"
              />
              <label style={styles.label}>Location</label>
              <input
                style={styles.input}
                value={wlLocation}
                onChange={(e) => setWlLocation(e.target.value)}
                placeholder="e.g. India, Bengaluru, remote"
              />
              <button style={styles.btn} onClick={addWatch}>
                Add to watchlist
              </button>
              <div style={{ fontSize: 12, color: "#8A8578", marginTop: 10 }}>
                Once a day, while this app is running, every query here gets searched automatically. New postings that score {" "}
                {"≥"} 60 get tailored against your Profile and logged to the Tracker as <strong>Draft</strong> tickets — nothing
                is ever submitted for you. Run stops there; you still click Apply yourself.
              </div>
            </div>

            {watchlist.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {watchlist.map((w, i) => (
                  <div key={i} style={{ ...styles.ticketRow, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{w.query}</div>
                      <div style={{ fontSize: 12, color: "#8A8578" }}>{w.location}</div>
                    </div>
                    <button style={styles.btnGhost} onClick={() => removeWatch(i)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <label style={{ ...styles.label, marginBottom: 0 }}>Automation log</label>
                <button style={styles.btnGhost} onClick={triggerRunNow} disabled={runTriggering}>
                  {runTriggering ? "Running…" : "Run now"}
                </button>
              </div>
              {runError && <div style={styles.errorBox}>{runError}</div>}
              {runLog.length === 0 && (
                <div style={{ fontSize: 13, color: "#8A8578" }}>No runs yet. Add a watchlist query and hit "Run now" to test, or wait for the next scheduled run.</div>
              )}
              {runLog.map((r, i) => (
                <div key={i} style={{ fontSize: 12, borderTop: i > 0 ? "1px solid #D8D3C8" : "none", paddingTop: i > 0 ? 8 : 0, marginTop: i > 0 ? 8 : 0 }}>
                  <span style={{ color: "#8A8578" }}>{new Date(r.started).toLocaleString()} · {r.trigger}</span>
                  {" — "}
                  <span style={{ color: "#0E6E6A", fontWeight: 600 }}>{r.added} new draft ticket(s)</span>
                  {r.errors?.length > 0 && (
                    <div style={{ color: "#B23A2E", marginTop: 4 }}>{r.errors.join(" · ")}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "tracker" && (
          <div>
            {tickets.length === 0 && (
              <div style={{ color: "#8A8578", fontSize: 14 }}>
                No tickets yet. Tailor an application to open your first one.
              </div>
            )}
            {tickets.map((t) => (
              <div key={t.id} style={styles.ticketRow}>
                <div style={styles.ticketHead}>
                  <span style={styles.ticketId}>
                    {t.id} · {t.date}
                    {t.auto ? " · auto" : ""}
                  </span>
                  <span style={styles.statusPill(t.status)}>{t.status}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{t.role}</div>
                  {t.resumeUrl && (
                    <a
                      href={t.resumeUrl}
                      target="_blank"
                      rel="noreferrer"
                      download
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 11,
                        color: "#0E6E6A",
                        border: "1px solid #0E6E6A",
                        borderRadius: 4,
                        padding: "2px 8px",
                        textDecoration: "none",
                      }}
                    >
                      ↓ Resume PDF
                    </a>
                  )}
                  {t.coverLetterUrl && (
                    <a
                      href={t.coverLetterUrl}
                      target="_blank"
                      rel="noreferrer"
                      download
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 11,
                        color: "#0E6E6A",
                        border: "1px solid #0E6E6A",
                        borderRadius: 4,
                        padding: "2px 8px",
                        textDecoration: "none",
                      }}
                    >
                      ↓ Cover Letter
                    </a>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "#8A8578", marginBottom: 10 }}>{t.company} · match {t.matchScore}/100</div>
                {t.sourceUrl && (
                  <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <a href={t.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#0E6E6A" }}>
                      Open posting ↗
                    </a>
                    <button
                      style={styles.btnGhost}
                      disabled={autofillingId === t.id}
                      onClick={() => autofill(t.id)}
                    >
                      {autofillingId === t.id ? "Filling form…" : "Autofill application"}
                    </button>
                  </div>
                )}
                {autofillResults[t.id] && (
                  <div
                    style={{
                      fontSize: 12,
                      marginBottom: 10,
                      padding: "8px 10px",
                      borderRadius: 4,
                      background: autofillResults[t.id].error ? "#FBEAEA" : "#F0F5F0",
                      color: autofillResults[t.id].error ? "#B23A2E" : "#3D5A45",
                    }}
                  >
                    {autofillResults[t.id].error ? (
                      autofillResults[t.id].error
                    ) : (
                      <>
                        Filled {autofillResults[t.id].filled?.length || 0} field(s), uploaded{" "}
                        {autofillResults[t.id].fileUploads?.length || 0} file(s), drafted{" "}
                        {autofillResults[t.id].drafted?.length || 0} answer(s) for review, skipped{" "}
                        {autofillResults[t.id].skipped?.length || 0} — check the browser window and review before
                        submitting.
                      </>
                    )}
                  </div>
                )}
                {t.missing?.length > 0 && (
                  <div style={{ fontSize: 12, color: "#B23A2E", marginBottom: 10 }}>
                    Gaps: {t.missing.join(", ")}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["Draft", "Applied", "Interview", "Offer", "Rejected"].map((s) => (
                    <button
                      key={s}
                      style={{
                        ...styles.btnGhost,
                        borderColor: t.status === s ? statusColor(s) : "#D8D3C8",
                        color: t.status === s ? statusColor(s) : "#8A8578",
                      }}
                      onClick={() => updateStatus(t.id, s)}
                    >
                      {s}
                    </button>
                  ))}
                  <button style={{ ...styles.btnGhost, marginLeft: "auto" }} onClick={() => removeTicket(t.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
