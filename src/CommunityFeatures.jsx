/* ═══════════════════════════════════════════════════════════════════════
   COMMUNITY FEATURES — Design Sharing, Leaderboard, Real-Time Collab
   Supabase tables needed:
     evtol_public_designs  (id, user_id, share_id, name, params, results,
                            created_at, is_public, view_count, likes)
     evtol_leaderboard     (design_id, user_id, display_name, metric_ld,
                            metric_mtow, metric_payload, metric_efficiency,
                            created_at)
     evtol_collab_sessions (session_id, design_id, host_id, state_json,
                            updated_at)
     evtol_collab_cursors  (session_id, user_id, display_name, param, value,
                            ts)
   ═══════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback } from "react";

/* ── Supabase config (same as AuthSystem) ── */
const SUPABASE_URL = "https://obribjypwwrbhsyjllua.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";

async function sbFetch(path, opts = {}) {
  const { prefer, headers: extraHeaders = {}, body, method = "GET" } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
      ...extraHeaders,
    },
    ...(body ? { body } : {}),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── Realtime subscribe via Supabase Realtime (websocket) ── */
function createRealtimeChannel(table, filter, onEvent) {
  // Supabase Realtime v2 via REST polling fallback
  // (Full WS implementation would need the supabase-js client library)
  // We use polling every 2 seconds as a lightweight real-time substitute
  let active = true;
  let lastTs = Date.now();
  const poll = async () => {
    if (!active) return;
    try {
      const rows = await sbFetch(
        `${table}?updated_at=gt.${new Date(lastTs - 100).toISOString()}&${filter}&select=*&order=updated_at.desc&limit=20`
      );
      if (rows?.length) {
        lastTs = Date.now();
        rows.forEach((r) => onEvent(r));
      }
    } catch (e) {/* silent */ }
    if (active) setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
  return () => { active = false; };
}

/* ─────────────────────────────────────────────────────────────────────
   PUBLIC DESIGN API
   ─────────────────────────────────────────────────────────────────── */
const shareIdCache = {};

export async function publishDesign(userId, displayName, params, results) {
  const shareId = Math.random().toString(36).slice(2, 10);
  const row = {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    user_id: userId,
    share_id: shareId,
    name: `${displayName}'s Design — MTOW ${results.MTOW}kg`,
    params: JSON.stringify(params),
    results: JSON.stringify({
      MTOW: results.MTOW, Etot: results.Etot, Phov: results.Phov,
      LDact: results.LDact, SM_vt: results.SM_vt, Wbat: results.Wbat,
      bWing: results.bWing, Swing: results.Swing,
    }),
    display_name: displayName,
    is_public: true,
    view_count: 0,
    likes: 0,
    created_at: new Date().toISOString(),
  };
  await sbFetch("evtol_public_designs", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(row),
  });
  // Also add to leaderboard
  const efficiency = (results.LDact * results.Etot) / results.MTOW;
  await sbFetch("evtol_leaderboard", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({
      id: row.id,
      design_id: row.id,
      share_id: shareId,
      user_id: userId,
      display_name: displayName,
      name: row.name,
      metric_ld: results.LDact,
      metric_mtow: results.MTOW,
      metric_payload: params.payload,
      metric_efficiency: +efficiency.toFixed(4),
      metric_etot: results.Etot,
      created_at: new Date().toISOString(),
    }),
  });
  return shareId;
}

export async function getPublicDesign(shareId) {
  try {
    const rows = await sbFetch(
      `evtol_public_designs?share_id=eq.${shareId}&is_public=eq.true&select=*`
    );
    if (!rows?.length) return null;
    // Increment view count
    await sbFetch(`evtol_public_designs?share_id=eq.${shareId}`, {
      method: "PATCH",
      body: JSON.stringify({ view_count: (rows[0].view_count || 0) + 1 }),
    });
    return rows[0];
  } catch { return null; }
}

export async function getLeaderboard() {
  try {
    return await sbFetch(
      "evtol_leaderboard?select=*&order=metric_ld.desc&limit=50"
    ) || [];
  } catch { return []; }
}

/* ─────────────────────────────────────────────────────────────────────
   COLLABORATION SESSION API
   ─────────────────────────────────────────────────────────────────── */
export async function createCollabSession(designId, hostId, params) {
  const sessionId = Math.random().toString(36).slice(2, 12);
  await sbFetch("evtol_collab_sessions", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({
      session_id: sessionId, design_id: designId, host_id: hostId,
      state_json: JSON.stringify(params),
      updated_at: new Date().toISOString(),
    }),
  });
  return sessionId;
}

export async function getCollabSession(sessionId) {
  try {
    const rows = await sbFetch(
      `evtol_collab_sessions?session_id=eq.${sessionId}&select=*`
    );
    return rows?.[0] || null;
  } catch { return null; }
}

export async function pushCollabState(sessionId, params) {
  try {
    await sbFetch(`evtol_collab_sessions?session_id=eq.${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        state_json: JSON.stringify(params),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch { /* silent */ }
}

/* ─────────────────────────────────────────────────────────────────────
   SHARE BUTTON COMPONENT
   ─────────────────────────────────────────────────────────────────── */
export function ShareDesignButton({ user, params, results, C }) {
  const [sharing, setSharing] = useState(false);
  const [shareId, setShareId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const handleShare = async () => {
    if (!user) { setErr("Sign in to share your design."); return; }
    setSharing(true); setErr("");
    try {
      const displayName = user.name || user.email?.split("@")[0] || "Anonymous";
      const id = await publishDesign(user.id, displayName, params, results);
      setShareId(id);
    } catch (e) {
      setErr("Share failed: " + e.message);
    }
    setSharing(false);
  };

  const shareUrl = shareId
    ? `${window.location.origin}${window.location.pathname}?design=${shareId}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {!shareId ? (
        <button
          onClick={handleShare}
          disabled={sharing}
          type="button"
          style={{
            padding: "5px 14px",
            background: `linear-gradient(135deg,${C.purple}33,${C.blue}33)`,
            border: `1px solid ${C.purple}66`,
            borderRadius: 4, color: C.purple, fontSize: 9,
            cursor: sharing ? "wait" : "pointer",
            fontFamily: "'DM Mono',monospace", fontWeight: 700,
            letterSpacing: "0.05em", opacity: sharing ? 0.6 : 1,
            display: "flex", alignItems: "center", gap: 5,
          }}
        >
          {!user && <span title="Sign in required" style={{ fontSize: 10 }}>🔒</span>}
          {sharing ? "⏳ Sharing..." : "🔗 Share Design"}
        </button>
      ) : (
        <div style={{
          position: "absolute", right: 0, top: 32, zIndex: 200,
          background: C.panel, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: "12px 14px", width: 320,
          boxShadow: `0 8px 30px rgba(0,0,0,0.4)`,
        }}>
          <div style={{ fontSize: 10, color: C.green, fontFamily: "'DM Mono',monospace", marginBottom: 6, fontWeight: 700 }}>
            ✓ Design published! Share this link:
          </div>
          <div style={{
            display: "flex", gap: 6, alignItems: "center",
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 5, padding: "5px 8px",
          }}>
            <span style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {shareUrl}
            </span>
            <button
              onClick={handleCopy} type="button"
              style={{
                padding: "3px 8px", background: copied ? `${C.green}22` : `${C.amber}22`,
                border: `1px solid ${copied ? C.green : C.amber}44`,
                borderRadius: 3, color: copied ? C.green : C.amber,
                fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace", flexShrink: 0,
              }}
            >
              {copied ? "✓ Copied!" : "Copy"}
            </button>
          </div>
          <div style={{ fontSize: 8, color: C.dim, fontFamily: "'DM Mono',monospace", marginTop: 6 }}>
            Anyone with this link can view your design (read-only).
          </div>
          <button onClick={() => setShareId(null)} type="button"
            style={{ marginTop: 6, background: "none", border: "none", color: C.muted, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
            Close
          </button>
        </div>
      )}
      {err && (
        <div style={{ position: "absolute", right: 0, top: 32, zIndex: 200, background: C.panel, border: `1px solid ${C.red}44`, borderRadius: 6, padding: "8px 12px", fontSize: 10, color: C.red, fontFamily: "'DM Mono',monospace", width: 240 }}>
          {err}
          <button onClick={() => setErr("")} type="button" style={{ marginLeft: 8, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 10 }}>✕</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   LEADERBOARD PANEL
   ─────────────────────────────────────────────────────────────────── */
export function LeaderboardPanel({ C, onLoadDesign }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState("metric_ld");
  const [tab, setTab] = useState("ld");

  const tabs = [
    { key: "ld", label: "Best L/D", field: "metric_ld", unit: "", desc: "Highest aerodynamic efficiency", fmt: v => v?.toFixed(2), col: "#14b8a6", icon: "🏆" },
    { key: "mtow", label: "Lowest MTOW", field: "metric_mtow", unit: "kg", desc: "Lightest design for given payload", fmt: v => v?.toFixed(0), col: "#f59e0b", icon: "⚖️", asc: true },
    { key: "eff", label: "Best Efficiency", field: "metric_efficiency", unit: "", desc: "L/D × E_total / MTOW", fmt: v => v?.toFixed(3), col: "#8b5cf6", icon: "⚡" },
    { key: "etot", label: "Lowest Energy", field: "metric_etot", unit: "kWh", desc: "Least total mission energy", fmt: v => v?.toFixed(1), col: "#3b82f6", icon: "🔋", asc: true },
  ];

  useEffect(() => {
    setLoading(true);
    getLeaderboard().then(rows => {
      setData(rows);
      setLoading(false);
    });
  }, []);

  const activeTab = tabs.find(t => t.key === tab);

  const sorted = [...data].sort((a, b) => {
    const v = activeTab?.asc
      ? (a[activeTab.field] || 0) - (b[activeTab.field] || 0)
      : (b[activeTab.field] || 0) - (a[activeTab.field] || 0);
    return v;
  }).slice(0, 10);

  const rankMedals = ["🥇", "🥈", "🥉"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg,${C.purple}18,${C.teal}18)`, border: `1px solid ${C.purple}33`, borderRadius: 10, padding: "14px 18px" }}>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", letterSpacing: "0.18em", marginBottom: 4 }}>COMMUNITY LEADERBOARD</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
          <span style={{ color: C.purple }}>eVTOL</span> Design Rankings
        </div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>
          Top designs submitted by the community. {data.length} total designs.
        </div>
      </div>

      {/* Category tabs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} type="button"
            style={{
              padding: "6px 12px", borderRadius: 6, fontSize: 10,
              fontFamily: "'DM Mono',monospace", fontWeight: 700, cursor: "pointer",
              background: tab === t.key ? `${t.col}22` : "transparent",
              border: `1px solid ${tab === t.key ? t.col + "66" : C.border}`,
              color: tab === t.key ? t.col : C.muted,
            }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Category description */}
      <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", padding: "6px 10px", background: `${activeTab?.col}11`, border: `1px solid ${activeTab?.col}33`, borderRadius: 6 }}>
        {activeTab?.icon} <strong style={{ color: activeTab?.col }}>{activeTab?.label}</strong> — {activeTab?.desc}
        {activeTab?.asc ? " (lower is better)" : " (higher is better)"}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 24, color: C.muted, fontSize: 12, fontFamily: "'DM Mono',monospace" }}>
          ⏳ Loading leaderboard...
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: 24, color: C.muted, fontSize: 11, fontFamily: "'DM Mono',monospace", background: C.panel, borderRadius: 8, border: `1px solid ${C.border}` }}>
          No designs yet. Be the first to share! 🚁
        </div>
      ) : (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          {/* Table header */}
          <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 100px 80px 80px 80px 60px", gap: 8, padding: "8px 14px", background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: 8, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            <span>#</span><span>Designer / Design</span>
            <span>{activeTab?.label}</span>
            <span>L/D</span><span>MTOW</span><span>Energy</span><span>View</span>
          </div>
          {sorted.map((row, i) => {
            const metVal = row[activeTab?.field];
            const isTop = i < 3;
            return (
              <div
                key={row.id || i}
                style={{
                  display: "grid", gridTemplateColumns: "40px 1fr 100px 80px 80px 80px 60px",
                  gap: 8, padding: "10px 14px",
                  background: isTop ? `${activeTab?.col}08` : "transparent",
                  borderBottom: `1px solid ${C.border}22`,
                  alignItems: "center",
                  cursor: onLoadDesign ? "pointer" : "default",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = `${activeTab?.col}12`}
                onMouseLeave={e => e.currentTarget.style.background = isTop ? `${activeTab?.col}08` : "transparent"}
                onClick={() => onLoadDesign && onLoadDesign(row)}
              >
                <span style={{ fontSize: 14, textAlign: "center" }}>
                  {rankMedals[i] || <span style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{i + 1}</span>}
                </span>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{row.display_name || "Anonymous"}</div>
                  <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{row.name?.slice(0, 40) || "—"}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: activeTab?.col, fontFamily: "'DM Mono',monospace" }}>
                  {activeTab?.fmt(metVal)} {activeTab?.unit}
                </span>
                <span style={{ fontSize: 10, color: C.teal, fontFamily: "'DM Mono',monospace" }}>{row.metric_ld?.toFixed(2) || "—"}</span>
                <span style={{ fontSize: 10, color: C.amber, fontFamily: "'DM Mono',monospace" }}>{row.metric_mtow?.toFixed(0) || "—"} kg</span>
                <span style={{ fontSize: 10, color: C.blue, fontFamily: "'DM Mono',monospace" }}>{row.metric_etot?.toFixed(1) || "—"} kWh</span>
                <button
                  type="button"
                  style={{ padding: "3px 6px", background: `${C.teal}22`, border: `1px solid ${C.teal}44`, borderRadius: 3, color: C.teal, fontSize: 8, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}
                  onClick={e => { e.stopPropagation(); if (row.share_id) window.open(`?design=${row.share_id}`, "_blank"); }}>
                  View
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Personal stats hint */}
      <div style={{ fontSize: 9, color: C.dim, fontFamily: "'DM Mono',monospace", textAlign: "center" }}>
        Use the <strong style={{ color: C.purple }}>🔗 Share Design</strong> button in the header to submit your design to the leaderboard.
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   REAL-TIME COLLABORATION PANEL
   ─────────────────────────────────────────────────────────────────── */
export function CollabPanel({ user, params, onParamChange, C }) {
  const [sessionId, setSessionId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [inSession, setInSession] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [collaborators, setCollaborators] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const stopPoll = useRef(null);
  const lastPush = useRef(0);

  // Push state changes when hosting
  useEffect(() => {
    if (!inSession || !isHost) return;
    const now = Date.now();
    if (now - lastPush.current < 800) return; // throttle 800ms
    lastPush.current = now;
    pushCollabState(sessionId, params);
  }, [params, inSession, isHost, sessionId]);

  const startSession = async () => {
    if (!user) { setErr("Sign in to start a collaboration session."); return; }
    setLoading(true); setErr("");
    try {
      const sid = await createCollabSession(`design_${Date.now()}`, user.id, params);
      setSessionId(sid);
      setInSession(true);
      setIsHost(true);
      addActivity(`Session started by ${user.name || "you"}`);
    } catch (e) { setErr("Failed to start session: " + e.message); }
    setLoading(false);
  };

  const joinSession = async () => {
    if (!joinId.trim()) { setErr("Enter a session ID."); return; }
    setLoading(true); setErr("");
    try {
      const session = await getCollabSession(joinId.trim());
      if (!session) { setErr("Session not found. Check the ID."); setLoading(false); return; }
      setSessionId(joinId.trim());
      setInSession(true);
      setIsHost(false);
      const state = JSON.parse(session.state_json || "{}");
      Object.entries(state).forEach(([k, v]) => onParamChange(k)(v));
      addActivity("Joined session. Design parameters loaded.");
      // Start polling for updates
      stopPoll.current = createRealtimeChannel(
        "evtol_collab_sessions",
        `session_id=eq.${joinId.trim()}`,
        (row) => {
          try {
            const state = JSON.parse(row.state_json || "{}");
            Object.entries(state).forEach(([k, v]) => onParamChange(k)(v));
            addActivity(`Host updated: params synced`);
          } catch { }
        }
      );
    } catch (e) { setErr("Failed to join: " + e.message); }
    setLoading(false);
  };

  const leaveSession = () => {
    if (stopPoll.current) stopPoll.current();
    setInSession(false);
    setIsHost(false);
    setSessionId("");
    setJoinId("");
    setCollaborators([]);
    setActivity([]);
  };

  const addActivity = (msg) => {
    setActivity(prev => [{
      msg,
      time: new Date().toLocaleTimeString(),
      id: Math.random()
    }, ...prev].slice(0, 20));
  };

  const copySessionLink = () => {
    const link = `${window.location.origin}${window.location.pathname}?session=${sessionId}`;
    navigator.clipboard.writeText(link).catch(() => { });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg,${C.teal}18,${C.blue}18)`, border: `1px solid ${C.teal}33`, borderRadius: 10, padding: "14px 18px" }}>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", letterSpacing: "0.18em", marginBottom: 4 }}>REAL-TIME COLLABORATION</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
          <span style={{ color: C.teal }}>Live</span> Design Sessions
        </div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>
          Host a session and share the link — collaborators see parameter changes in real-time.
        </div>
      </div>

      {!inSession ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Start session */}
          <div style={{ background: C.panel, border: `1px solid ${C.teal}33`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.teal, fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>🏠 Host a Session</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 12, lineHeight: 1.6 }}>
              Start a live session with your current design. Share the session ID with teammates.
            </div>
            <button onClick={startSession} disabled={loading} type="button"
              style={{
                width: "100%", padding: "8px 0", background: `linear-gradient(135deg,${C.teal}33,${C.blue}33)`,
                border: `1px solid ${C.teal}66`, borderRadius: 6, color: C.teal,
                fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono',monospace",
                cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
              }}>
              {loading ? "Starting..." : "Start Session →"}
            </button>
            {!user && <div style={{ fontSize: 9, color: C.amber, fontFamily: "'DM Mono',monospace", marginTop: 6 }}>⚠ Sign in required to host</div>}
          </div>

          {/* Join session */}
          <div style={{ background: C.panel, border: `1px solid ${C.blue}33`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>🔗 Join a Session</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 8, lineHeight: 1.6 }}>
              Enter a session ID from a teammate to join their live design.
            </div>
            <input
              value={joinId} onChange={e => setJoinId(e.target.value)}
              placeholder="Session ID..."
              style={{
                width: "100%", boxSizing: "border-box", background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 4,
                color: C.text, fontSize: 11, padding: "7px 10px",
                fontFamily: "'DM Mono',monospace", outline: "none", marginBottom: 8,
              }}
            />
            <button onClick={joinSession} disabled={loading} type="button"
              style={{
                width: "100%", padding: "8px 0", background: `linear-gradient(135deg,${C.blue}33,${C.purple}33)`,
                border: `1px solid ${C.blue}66`, borderRadius: 6, color: C.blue,
                fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono',monospace",
                cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
              }}>
              {loading ? "Joining..." : "Join Session →"}
            </button>
          </div>
        </div>
      ) : (
        /* Active session UI */
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Session status bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
            background: `${C.green}11`, border: `1px solid ${C.green}44`, borderRadius: 8,
          }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, animation: "pulse 2s infinite" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.green, fontFamily: "'DM Mono',monospace" }}>
                {isHost ? "🏠 Hosting Session" : "👥 Joined Session"}
              </div>
              <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>
                Session ID: <span style={{ color: C.amber, fontWeight: 700 }}>{sessionId}</span>
              </div>
            </div>
            <button onClick={copySessionLink} type="button"
              style={{ padding: "4px 10px", background: `${C.amber}22`, border: `1px solid ${C.amber}44`, borderRadius: 4, color: C.amber, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
              📋 Copy Link
            </button>
            <button onClick={leaveSession} type="button"
              style={{ padding: "4px 10px", background: `${C.red}11`, border: `1px solid ${C.red}33`, borderRadius: 4, color: C.red, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
              Leave
            </button>
          </div>

          {/* Role info */}
          <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", padding: "8px 12px", background: C.panel, borderRadius: 6, border: `1px solid ${C.border}`, lineHeight: 1.7 }}>
            {isHost
              ? "You are the host. Any slider change is broadcast to all viewers. Share the session ID above."
              : "You are viewing. The host's parameter changes will sync to your screen automatically (every 2s)."}
          </div>

          {/* Activity feed */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Activity Feed</div>
            {activity.length === 0 ? (
              <div style={{ fontSize: 10, color: C.dim, fontFamily: "'DM Mono',monospace" }}>No activity yet…</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                {activity.map(a => (
                  <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 8, color: C.dim, fontFamily: "'DM Mono',monospace", flexShrink: 0, marginTop: 1 }}>{a.time}</span>
                    <span style={{ fontSize: 10, color: C.text, fontFamily: "'DM Mono',monospace" }}>{a.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {err && (
        <div style={{ padding: "8px 12px", background: `${C.red}11`, border: `1px solid ${C.red}44`, borderRadius: 6, fontSize: 10, color: C.red, fontFamily: "'DM Mono',monospace" }}>
          {err}
          <button onClick={() => setErr("")} type="button" style={{ marginLeft: 8, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 10 }}>✕</button>
        </div>
      )}

      {/* How it works */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>How It Works</div>
        {[
          ["🏠", "Host starts session", "Your current design parameters become the shared starting point."],
          ["🔗", "Share the session ID", "Copy the session link and send to collaborators via Slack, email, etc."],
          ["👥", "Collaborators join", "They enter the ID and their design syncs with yours instantly."],
          ["🔄", "Live sync", "Any slider you move as host is broadcast every ~2 seconds to all viewers."],
          ["📊", "Results update", "All physics calculations update live — everyone sees the same numbers."],
        ].map(([icon, title, desc]) => (
          <div key={title} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{title}</div>
              <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", lineHeight: 1.5 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PUBLIC DESIGN VIEWER — read-only view loaded from ?design=shareId
   ─────────────────────────────────────────────────────────────────── */
export function PublicDesignBanner({ shareId, onLoad, C }) {
  const [design, setDesign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!shareId) { setLoading(false); return; }
    getPublicDesign(shareId).then(d => {
      if (d) { setDesign(d); }
      else { setErr("Design not found or no longer public."); }
      setLoading(false);
    });
  }, [shareId]);

  if (!shareId || dismissed) return null;

  if (loading) return (
    <div style={{ padding: "10px 18px", background: `${C.blue}18`, border: `1px solid ${C.blue}44`, borderRadius: 8, marginBottom: 10, fontSize: 10, color: C.blue, fontFamily: "'DM Mono',monospace" }}>
      ⏳ Loading shared design…
    </div>
  );
  if (err) return (
    <div style={{ padding: "10px 18px", background: `${C.red}11`, border: `1px solid ${C.red}33`, borderRadius: 8, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 10, color: C.red, fontFamily: "'DM Mono',monospace" }}>❌ {err}</span>
      <button onClick={() => setDismissed(true)} type="button" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}>✕</button>
    </div>
  );
  if (!design) return null;

  const results = JSON.parse(design.results || "{}");
  const params = JSON.parse(design.params || "{}");

  return (
    <div style={{
      padding: "12px 18px", background: `${C.teal}11`, border: `1px solid ${C.teal}44`,
      borderRadius: 8, marginBottom: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 16 }}>🔗</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 10, color: C.teal, fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>
          Viewing shared design by {design.display_name || "Anonymous"}
        </div>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 2 }}>
          MTOW: {results.MTOW} kg · L/D: {results.LDact} · Energy: {results.Etot} kWh · {design.view_count} views
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => { onLoad(params); setDismissed(true); }}
          type="button"
          style={{
            padding: "6px 14px", background: `linear-gradient(135deg,${C.teal}33,${C.blue}33)`,
            border: `1px solid ${C.teal}66`, borderRadius: 5, color: C.teal,
            fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontWeight: 700,
          }}>
          Load & Explore →
        </button>
        <button onClick={() => setDismissed(true)} type="button"
          style={{ padding: "6px 10px", background: "none", border: `1px solid ${C.border}`, borderRadius: 5, color: C.muted, fontSize: 10, cursor: "pointer" }}>
          ✕
        </button>
      </div>
    </div>
  );
}
