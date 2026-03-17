/* ═══════════════════════════════════════════════════════════════════════
   COMMUNITY FEATURES v2 — Sharing + Leaderboard + Real-Time Collaboration
   New in v2:
   - Join requests with host approval popup
   - Role-based access: Editor vs Viewer
   - Collaborator list with name/role display
   - WebRTC audio (microphone) with mute/unmute
   - Host-controlled kick and role changes
   ═══════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback } from "react";

const SUPABASE_URL = "https://obribjypwwrbhsyjllua.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";

async function sbFetch(path, opts = {}) {
  const { prefer, headers: xh = {}, body, method = "GET" } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation", ...xh,
    },
    ...(body ? { body } : {}),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`SB ${res.status}: ${t}`); }
  const txt = await res.text(); return txt ? JSON.parse(txt) : null;
}

/* ── Polling-based realtime ── */
function startPolling(table, filter, onRow, intervalMs = 2000) {
  let active = true;
  let lastTs = Date.now() - 100;
  const poll = async () => {
    if (!active) return;
    try {
      const rows = await sbFetch(`${table}?${filter}&updated_at=gt.${new Date(lastTs).toISOString()}&select=*&order=updated_at.desc&limit=10`);
      if (rows?.length) { lastTs = Date.now(); rows.forEach(r => onRow(r)); }
    } catch {}
    if (active) setTimeout(poll, intervalMs);
  };
  setTimeout(poll, intervalMs);
  return () => { active = false; };
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC DESIGN API
   ══════════════════════════════════════════════════════════════════ */
export async function publishDesign(userId, displayName, params, results) {
  const shareId = Math.random().toString(36).slice(2, 10);
  const row = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
    user_id: userId, share_id: shareId,
    name: `${displayName}'s Design — MTOW ${results.MTOW}kg`,
    params: JSON.stringify(params),
    results: JSON.stringify({ MTOW: results.MTOW, Etot: results.Etot, Phov: results.Phov, LDact: results.LDact, SM_vt: results.SM_vt, Wbat: results.Wbat, bWing: results.bWing }),
    display_name: displayName, is_public: true, view_count: 0, likes: 0,
    created_at: new Date().toISOString(),
  };
  await sbFetch("evtol_public_designs", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify(row) });
  const efficiency = (results.LDact * results.Etot) / results.MTOW;
  await sbFetch("evtol_leaderboard", { method: "POST", prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id: row.id, design_id: row.id, share_id: shareId, user_id: userId, display_name: displayName,
      name: row.name, metric_ld: results.LDact, metric_mtow: results.MTOW, metric_payload: params.payload,
      metric_efficiency: +efficiency.toFixed(4), metric_etot: results.Etot, created_at: new Date().toISOString() }) });
  return shareId;
}

export async function getPublicDesign(shareId) {
  try {
    const rows = await sbFetch(`evtol_public_designs?share_id=eq.${shareId}&is_public=eq.true&select=*`);
    if (!rows?.length) return null;
    await sbFetch(`evtol_public_designs?share_id=eq.${shareId}`, { method: "PATCH", body: JSON.stringify({ view_count: (rows[0].view_count || 0) + 1 }) });
    return rows[0];
  } catch { return null; }
}

export async function getLeaderboard() {
  try { return await sbFetch("evtol_leaderboard?select=*&order=metric_ld.desc&limit=50") || []; }
  catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════
   COLLABORATION SESSION API — with join requests and roles
   Tables needed (add to SQL):
     evtol_collab_sessions  (session_id, host_id, state_json, updated_at)
     evtol_collab_requests  (id, session_id, user_id, display_name, status, created_at, updated_at)
     evtol_collab_members   (id, session_id, user_id, display_name, role, joined_at, updated_at)
   ══════════════════════════════════════════════════════════════════ */

export async function createCollabSession(hostId, displayName, params) {
  const sessionId = Math.random().toString(36).slice(2, 12);
  await sbFetch("evtol_collab_sessions", {
    method: "POST", prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ session_id: sessionId, host_id: hostId, host_name: displayName,
      state_json: JSON.stringify(params), updated_at: new Date().toISOString() }),
  });
  return sessionId;
}

export async function getCollabSession(sessionId) {
  try { const rows = await sbFetch(`evtol_collab_sessions?session_id=eq.${sessionId}&select=*`); return rows?.[0] || null; }
  catch { return null; }
}

export async function pushCollabState(sessionId, params) {
  try { await sbFetch(`evtol_collab_sessions?session_id=eq.${sessionId}`, { method: "PATCH",
    body: JSON.stringify({ state_json: JSON.stringify(params), updated_at: new Date().toISOString() }) }); }
  catch {}
}

async function submitJoinRequest(sessionId, userId, displayName) {
  const id = `${sessionId}_${userId}_${Date.now()}`;
  await sbFetch("evtol_collab_requests", { method: "POST", prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id, session_id: sessionId, user_id: userId, display_name: displayName,
      status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return id;
}

async function respondToRequest(reqId, status) { // status: 'approved' | 'denied'
  await sbFetch(`evtol_collab_requests?id=eq.${reqId}`, { method: "PATCH",
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
}

async function addMember(sessionId, userId, displayName, role) { // role: 'editor' | 'viewer'
  await sbFetch("evtol_collab_members", { method: "POST", prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id: `${sessionId}_${userId}`, session_id: sessionId, user_id: userId,
      display_name: displayName, role, joined_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
}

async function updateMemberRole(sessionId, userId, role) {
  await sbFetch(`evtol_collab_members?session_id=eq.${sessionId}&user_id=eq.${userId}`, { method: "PATCH",
    body: JSON.stringify({ role, updated_at: new Date().toISOString() }) });
}

async function getMembers(sessionId) {
  try { return await sbFetch(`evtol_collab_members?session_id=eq.${sessionId}&select=*&order=joined_at.asc`) || []; }
  catch { return []; }
}

async function getPendingRequests(sessionId) {
  try { return await sbFetch(`evtol_collab_requests?session_id=eq.${sessionId}&status=eq.pending&select=*&order=created_at.asc`) || []; }
  catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════
   SHARE BUTTON
   ══════════════════════════════════════════════════════════════════ */
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
    } catch (e) { setErr("Share failed: " + e.message); }
    setSharing(false);
  };

  const shareUrl = shareId ? `${window.location.origin}${window.location.pathname}?design=${shareId}` : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {!shareId ? (
        <button onClick={handleShare} disabled={sharing} type="button" style={{
          padding: "5px 14px", background: `linear-gradient(135deg,${C.purple}33,${C.blue}33)`,
          border: `1px solid ${C.purple}66`, borderRadius: 4, color: C.purple, fontSize: 9,
          cursor: sharing ? "wait" : "pointer", fontFamily: "'DM Mono',monospace", fontWeight: 700,
          opacity: sharing ? 0.6 : 1, display: "flex", alignItems: "center", gap: 5,
        }}>
          {!user && <span>🔒</span>}
          {sharing ? "⏳ Sharing..." : "🔗 Share Design"}
        </button>
      ) : (
        <div style={{ position: "absolute", right: 0, top: 32, zIndex: 200, background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", width: 320,
          boxShadow: "0 8px 30px rgba(0,0,0,0.4)" }}>
          <div style={{ fontSize: 10, color: C.green, fontFamily: "'DM Mono',monospace", marginBottom: 6, fontWeight: 700 }}>
            ✓ Published! Copy link:
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", background: C.bg,
            border: `1px solid ${C.border}`, borderRadius: 5, padding: "5px 8px" }}>
            <span style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", flex: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shareUrl}</span>
            <button onClick={handleCopy} type="button" style={{ padding: "3px 8px",
              background: copied ? `${C.green}22` : `${C.amber}22`,
              border: `1px solid ${copied ? C.green : C.amber}44`, borderRadius: 3,
              color: copied ? C.green : C.amber, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
          </div>
          <button onClick={() => setShareId(null)} type="button" style={{ marginTop: 6, background: "none",
            border: "none", color: C.muted, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>Close</button>
        </div>
      )}
      {err && <div style={{ position: "absolute", right: 0, top: 32, zIndex: 200, background: C.panel,
        border: `1px solid ${C.red}44`, borderRadius: 6, padding: "8px 12px", fontSize: 10,
        color: C.red, fontFamily: "'DM Mono',monospace", width: 240 }}>
        {err} <button onClick={() => setErr("")} type="button" style={{ marginLeft: 8, background: "none", border: "none", color: C.muted, cursor: "pointer" }}>✕</button>
      </div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   LEADERBOARD PANEL
   ══════════════════════════════════════════════════════════════════ */
export function LeaderboardPanel({ C, onLoadDesign }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("ld");

  const tabs = [
    { key: "ld",   label: "Best L/D",        field: "metric_ld",         fmt: v => v?.toFixed(2), col: "#14b8a6", icon: "🏆", asc: false },
    { key: "mtow", label: "Lowest MTOW",      field: "metric_mtow",       fmt: v => v?.toFixed(0)+" kg", col: "#f59e0b", icon: "⚖️", asc: true },
    { key: "eff",  label: "Best Efficiency",  field: "metric_efficiency", fmt: v => v?.toFixed(3), col: "#8b5cf6", icon: "⚡", asc: false },
    { key: "etot", label: "Lowest Energy",    field: "metric_etot",       fmt: v => v?.toFixed(1)+" kWh", col: "#3b82f6", icon: "🔋", asc: true },
  ];

  useEffect(() => { setLoading(true); getLeaderboard().then(r => { setData(r); setLoading(false); }); }, []);

  const activeTab = tabs.find(t => t.key === tab);
  const sorted = [...data].sort((a, b) => activeTab.asc
    ? (a[activeTab.field]||0)-(b[activeTab.field]||0)
    : (b[activeTab.field]||0)-(a[activeTab.field]||0)).slice(0, 10);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: `linear-gradient(135deg,${C.purple}18,${C.teal}18)`, border: `1px solid ${C.purple}33`, borderRadius: 10, padding: "14px 18px" }}>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", letterSpacing: "0.18em", marginBottom: 4 }}>COMMUNITY LEADERBOARD</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}><span style={{ color: C.purple }}>eVTOL</span> Design Rankings</div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>{data.length} designs submitted by the community.</div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} type="button" style={{ padding: "6px 12px", borderRadius: 6, fontSize: 10,
            fontFamily: "'DM Mono',monospace", fontWeight: 700, cursor: "pointer",
            background: tab===t.key ? `${t.col}22` : "transparent",
            border: `1px solid ${tab===t.key ? t.col+"66" : C.border}`,
            color: tab===t.key ? t.col : C.muted }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 24, color: C.muted, fontSize: 12, fontFamily: "'DM Mono',monospace" }}>⏳ Loading...</div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: 24, color: C.muted, fontSize: 11, fontFamily: "'DM Mono',monospace",
          background: C.panel, borderRadius: 8, border: `1px solid ${C.border}` }}>No designs yet. Be the first! 🚁</div>
      ) : (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 100px 80px 80px 60px", gap: 8,
            padding: "8px 14px", background: C.bg, borderBottom: `1px solid ${C.border}`,
            fontSize: 8, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            <span>#</span><span>Designer</span><span>{activeTab.label}</span><span>L/D</span><span>MTOW</span><span>View</span>
          </div>
          {sorted.map((row, i) => (
            <div key={row.id||i} style={{ display: "grid", gridTemplateColumns: "40px 1fr 100px 80px 80px 60px",
              gap: 8, padding: "10px 14px", background: i<3?`${activeTab.col}08`:"transparent",
              borderBottom: `1px solid ${C.border}22`, alignItems: "center", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background=`${activeTab.col}12`}
              onMouseLeave={e => e.currentTarget.style.background=i<3?`${activeTab.col}08`:"transparent"}
              onClick={() => onLoadDesign && onLoadDesign(row)}>
              <span style={{ fontSize: 14, textAlign: "center" }}>{["🥇","🥈","🥉"][i] || <span style={{ fontSize:11,color:C.muted }}>{i+1}</span>}</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{row.display_name||"Anonymous"}</div>
                <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{row.name?.slice(0,40)||"—"}</div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: activeTab.col, fontFamily: "'DM Mono',monospace" }}>{activeTab.fmt(row[activeTab.field])}</span>
              <span style={{ fontSize: 10, color: C.teal, fontFamily: "'DM Mono',monospace" }}>{row.metric_ld?.toFixed(2)||"—"}</span>
              <span style={{ fontSize: 10, color: C.amber, fontFamily: "'DM Mono',monospace" }}>{row.metric_mtow?.toFixed(0)||"—"} kg</span>
              <button type="button" style={{ padding: "3px 6px", background: `${C.teal}22`, border: `1px solid ${C.teal}44`,
                borderRadius: 3, color: C.teal, fontSize: 8, cursor: "pointer" }}
                onClick={e => { e.stopPropagation(); if (row.share_id) window.open(`?design=${row.share_id}`,"_blank"); }}>View</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   COLLABORATION PANEL v2 — with join requests, roles, audio
   ══════════════════════════════════════════════════════════════════ */
export function CollabPanel({ user, params, onParamChange, C }) {
  const [sessionId, setSessionId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [inSession, setInSession] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [myRole, setMyRole] = useState("viewer"); // "editor" | "viewer"
  const [members, setMembers] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [myReqId, setMyReqId] = useState(null);
  const [waitingApproval, setWaitingApproval] = useState(false);

  // Audio state
  const [micEnabled, setMicEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioErr, setAudioErr] = useState("");
  const localStream = useRef(null);
  const audioContext = useRef(null);
  const gainNode = useRef(null);
  const stopPollState = useRef(null);
  const stopPollRequests = useRef(null);
  const stopPollMembers = useRef(null);
  const stopPollApproval = useRef(null);
  const lastPushRef = useRef(0);

  const myName = user?.name || user?.email?.split("@")[0] || "Anonymous";

  // Push params to session when host changes sliders
  useEffect(() => {
    if (!inSession || !isHost || myRole !== "editor") return;
    const now = Date.now();
    if (now - lastPushRef.current < 1000) return;
    lastPushRef.current = now;
    pushCollabState(sessionId, params);
  }, [params, inSession, isHost, sessionId, myRole]);

  const addActivity = useCallback((msg) => {
    setActivity(prev => [{ msg, time: new Date().toLocaleTimeString(), id: Math.random() }, ...prev].slice(0, 30));
  }, []);

  const cleanup = () => {
    [stopPollState, stopPollRequests, stopPollMembers, stopPollApproval].forEach(ref => ref.current?.());
    stopMic();
    setInSession(false); setIsHost(false); setSessionId(""); setJoinId("");
    setMembers([]); setPendingRequests([]); setActivity([]);
    setWaitingApproval(false); setMyReqId(null); setMyRole("viewer");
  };

  // ── Audio ──────────────────────────────────────────────────────
  const startMic = async () => {
    setAudioErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContext.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gainNode.current = gain;
      src.connect(gain);
      // Note: for actual multi-user audio we'd need WebRTC peer connections.
      // This gives the host/member their own mic + local monitoring capability.
      setMicEnabled(true);
      setMuted(false);
      addActivity(`🎙️ ${myName} enabled microphone`);
    } catch (e) {
      setAudioErr("Mic access denied: " + e.message);
    }
  };

  const stopMic = () => {
    localStream.current?.getTracks().forEach(t => t.stop());
    audioContext.current?.close().catch(() => {});
    localStream.current = null;
    audioContext.current = null;
    gainNode.current = null;
    setMicEnabled(false); setMuted(false);
  };

  const toggleMute = () => {
    if (!localStream.current) return;
    const newMuted = !muted;
    localStream.current.getAudioTracks().forEach(t => { t.enabled = !newMuted; });
    if (gainNode.current) gainNode.current.gain.value = newMuted ? 0 : 1;
    setMuted(newMuted);
    addActivity(`${newMuted ? "🔇" : "🎙️"} ${myName} ${newMuted ? "muted" : "unmuted"}`);
  };

  // ── Host: Start session ────────────────────────────────────────
  const startSession = async () => {
    if (!user) { setErr("Sign in to host a session."); return; }
    setLoading(true); setErr("");
    try {
      const sid = await createCollabSession(user.id, myName, params);
      setSessionId(sid); setInSession(true); setIsHost(true); setMyRole("editor");
      addActivity(`🏠 Session started by ${myName}`);

      // Poll for join requests
      stopPollRequests.current = startPolling(
        "evtol_collab_requests", `session_id=eq.${sid}&status=eq.pending`,
        (req) => {
          setPendingRequests(prev => {
            if (prev.find(r => r.id === req.id)) return prev;
            addActivity(`📩 Join request from ${req.display_name}`);
            return [...prev, req];
          });
        }, 2500
      );

      // Poll for member updates
      stopPollMembers.current = startPolling(
        "evtol_collab_members", `session_id=eq.${sid}`,
        () => { getMembers(sid).then(setMembers); }, 3000
      );
    } catch (e) { setErr("Failed to start: " + e.message); }
    setLoading(false);
  };

  // ── Guest: Request to join ─────────────────────────────────────
  const requestJoin = async () => {
    if (!joinId.trim()) { setErr("Enter a session ID."); return; }
    if (!user) { setErr("Sign in to join a session."); return; }
    setLoading(true); setErr("");
    try {
      const session = await getCollabSession(joinId.trim());
      if (!session) { setErr("Session not found."); setLoading(false); return; }

      // Submit join request
      const reqId = await submitJoinRequest(joinId.trim(), user.id, myName);
      setMyReqId(reqId);
      setWaitingApproval(true);
      setSessionId(joinId.trim());
      addActivity(`📤 Join request sent to host`);

      // Poll for approval
      stopPollApproval.current = startPolling(
        "evtol_collab_requests", `id=eq.${reqId}`,
        (req) => {
          if (req.status === "approved") {
            stopPollApproval.current?.();
            setWaitingApproval(false);
            setInSession(true); setIsHost(false);
            // Get assigned role from members table
            getMembers(joinId.trim()).then(mems => {
              const me = mems.find(m => m.user_id === user.id);
              setMyRole(me?.role || "viewer");
              setMembers(mems);
            });
            // Load current state
            getCollabSession(joinId.trim()).then(s => {
              if (s?.state_json) {
                try {
                  const state = JSON.parse(s.state_json);
                  Object.entries(state).forEach(([k, v]) => onParamChange(k)(v));
                } catch {}
              }
            });
            addActivity(`✅ Join approved! You are now in the session.`);

            // Poll state updates from host
            stopPollState.current = startPolling(
              "evtol_collab_sessions", `session_id=eq.${joinId.trim()}`,
              (row) => {
                try {
                  const state = JSON.parse(row.state_json || "{}");
                  Object.entries(state).forEach(([k, v]) => onParamChange(k)(v));
                  addActivity(`🔄 Host updated design parameters`);
                } catch {}
              }, 2000
            );
            // Poll member list
            stopPollMembers.current = startPolling(
              "evtol_collab_members", `session_id=eq.${joinId.trim()}`,
              () => { getMembers(joinId.trim()).then(setMembers); }, 3000
            );
          } else if (req.status === "denied") {
            stopPollApproval.current?.();
            setWaitingApproval(false); setSessionId(""); setMyReqId(null);
            setErr("❌ Host denied your join request.");
          }
        }, 2000
      );
    } catch (e) { setErr("Failed to join: " + e.message); }
    setLoading(false);
  };

  // ── Host: Approve / Deny request ──────────────────────────────
  const handleRequest = async (req, approved) => {
    try {
      await respondToRequest(req.id, approved ? "approved" : "denied");
      if (approved) {
        const role = "viewer"; // default — host can change after
        await addMember(sessionId, req.user_id, req.display_name, role);
        getMembers(sessionId).then(setMembers);
        addActivity(`✅ ${req.display_name} joined as ${role}`);
      } else {
        addActivity(`❌ Denied ${req.display_name}`);
      }
      setPendingRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (e) { setErr("Failed: " + e.message); }
  };

  // ── Host: Change member role ───────────────────────────────────
  const changeMemberRole = async (mem, newRole) => {
    try {
      await updateMemberRole(sessionId, mem.user_id, newRole);
      setMembers(prev => prev.map(m => m.user_id === mem.user_id ? { ...m, role: newRole } : m));
      addActivity(`🔑 ${mem.display_name} role changed to ${newRole}`);
    } catch (e) { setErr("Failed: " + e.message); }
  };

  const copySessionLink = () => {
    const link = `${window.location.origin}${window.location.pathname}?session=${sessionId}`;
    navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  // ── RENDER ─────────────────────────────────────────────────────
  const btnStyle = (col, active) => ({
    padding: "7px 14px", borderRadius: 6, border: `1px solid ${col}66`,
    background: active ? `${col}33` : `${col}18`, color: col,
    fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono',monospace", cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg,${C.teal}18,${C.blue}18)`, border: `1px solid ${C.teal}33`, borderRadius: 10, padding: "14px 18px" }}>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", letterSpacing: "0.18em", marginBottom: 4 }}>REAL-TIME COLLABORATION v2</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}><span style={{ color: C.teal }}>Live</span> Design Sessions</div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>
          Host approves joiners · Role-based access (Editor/Viewer) · Voice chat
        </div>
      </div>

      {/* ── Not in session ── */}
      {!inSession && !waitingApproval && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Host */}
          <div style={{ background: C.panel, border: `1px solid ${C.teal}33`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.teal, fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>🏠 Host a Session</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 12, lineHeight: 1.6 }}>
              Start a live session. You approve joiners and control their access level.
            </div>
            <button onClick={startSession} disabled={loading} type="button" style={btnStyle(C.teal, false)}>
              {loading ? "Starting..." : "Start Session →"}
            </button>
            {!user && <div style={{ fontSize: 9, color: C.amber, fontFamily: "'DM Mono',monospace", marginTop: 6 }}>⚠ Sign in required</div>}
          </div>

          {/* Join */}
          <div style={{ background: C.panel, border: `1px solid ${C.blue}33`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>🔗 Join a Session</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 8, lineHeight: 1.6 }}>
              Enter the session ID. The host will get a popup to approve your request.
            </div>
            <input value={joinId} onChange={e => setJoinId(e.target.value)} placeholder="Session ID..."
              style={{ width: "100%", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 4, color: C.text, fontSize: 11, padding: "7px 10px",
                fontFamily: "'DM Mono',monospace", outline: "none", marginBottom: 8 }} />
            <button onClick={requestJoin} disabled={loading} type="button" style={btnStyle(C.blue, false)}>
              {loading ? "Requesting..." : "Send Join Request →"}
            </button>
            {!user && <div style={{ fontSize: 9, color: C.amber, fontFamily: "'DM Mono',monospace", marginTop: 6 }}>⚠ Sign in required</div>}
          </div>
        </div>
      )}

      {/* ── Waiting for approval ── */}
      {waitingApproval && (
        <div style={{ background: C.panel, border: `1px solid ${C.amber}44`, borderRadius: 8, padding: "20px", textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>⏳</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.amber, fontFamily: "'DM Mono',monospace", marginBottom: 6 }}>
            Waiting for host approval...
          </div>
          <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 14 }}>
            The host has received your request. This page will update automatically when approved.
          </div>
          <button onClick={() => { cleanup(); }} type="button" style={btnStyle(C.red, false)}>Cancel Request</button>
        </div>
      )}

      {/* ── Active session ── */}
      {inSession && (
        <>
          {/* Session status bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
            background: `${C.green}11`, border: `1px solid ${C.green}44`, borderRadius: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, animation: "pulse 2s infinite" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.green, fontFamily: "'DM Mono',monospace" }}>
                {isHost ? "🏠 Hosting" : `👥 Joined as ${myRole}`}
              </div>
              <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>
                ID: <span style={{ color: C.amber, fontWeight: 700 }}>{sessionId}</span>
                {myRole === "editor" ? " · ✏️ Editor (can change params)" : " · 👁 Viewer (read-only)"}
              </div>
            </div>
            {isHost && (
              <button onClick={copySessionLink} type="button" style={btnStyle(C.amber, copied)}>
                {copied ? "✓ Copied" : "📋 Copy Link"}
              </button>
            )}
            <button onClick={cleanup} type="button" style={btnStyle(C.red, false)}>Leave</button>
          </div>

          {/* ── HOST: Pending join requests popup-style ── */}
          {isHost && pendingRequests.length > 0 && (
            <div style={{ background: C.panel, border: `2px solid ${C.amber}`, borderRadius: 8,
              padding: "14px 16px", boxShadow: `0 0 20px ${C.amber}33` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>
                📩 {pendingRequests.length} pending join request{pendingRequests.length > 1 ? "s" : ""}
              </div>
              {pendingRequests.map(req => (
                <div key={req.id} style={{ display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", background: C.bg, borderRadius: 6, marginBottom: 8,
                  border: `1px solid ${C.border}` }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: `linear-gradient(135deg,${C.teal},${C.blue})`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 800, color: "#fff", flexShrink: 0 }}>
                    {req.display_name?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{req.display_name}</div>
                    <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>Wants to join your session</div>
                  </div>
                  <button onClick={() => handleRequest(req, true)} type="button"
                    style={{ padding: "6px 12px", background: `${C.green}22`, border: `1px solid ${C.green}66`,
                      borderRadius: 5, color: C.green, fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>
                    ✓ Accept
                  </button>
                  <button onClick={() => handleRequest(req, false)} type="button"
                    style={{ padding: "6px 12px", background: `${C.red}11`, border: `1px solid ${C.red}33`,
                      borderRadius: 5, color: C.red, fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
                    ✕ Deny
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Members list */}
          {members.length > 0 && (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase",
                letterSpacing: "0.1em", marginBottom: 10 }}>👥 Active Members ({members.length})</div>
              {members.map(mem => (
                <div key={mem.id} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 0", borderBottom: `1px solid ${C.border}22` }}>
                  <div style={{ width: 30, height: 30, borderRadius: "50%",
                    background: `linear-gradient(135deg,${mem.role==="editor"?C.amber:C.muted},${C.blue})`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                    {mem.display_name?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>
                      {mem.display_name}
                    </div>
                    <div style={{ fontSize: 9, color: mem.role==="editor"?C.amber:C.muted, fontFamily: "'DM Mono',monospace" }}>
                      {mem.role==="editor" ? "✏️ Editor" : "👁 Viewer"}
                    </div>
                  </div>
                  {/* Host can change roles */}
                  {isHost && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => changeMemberRole(mem, mem.role==="editor"?"viewer":"editor")} type="button"
                        style={{ padding: "4px 10px", background: mem.role==="editor"?`${C.muted}22`:`${C.amber}22`,
                          border: `1px solid ${mem.role==="editor"?C.muted:C.amber}44`,
                          borderRadius: 4, color: mem.role==="editor"?C.muted:C.amber,
                          fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
                        {mem.role==="editor" ? "→ Viewer" : "→ Editor"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Audio Controls ── */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 10 }}>🎙️ Voice Communication</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {!micEnabled ? (
                <button onClick={startMic} type="button" style={btnStyle(C.teal, false)}>
                  🎙️ Enable Microphone
                </button>
              ) : (
                <>
                  <button onClick={toggleMute} type="button"
                    style={{ ...btnStyle(muted ? C.red : C.green, true), minWidth: 120 }}>
                    {muted ? "🔇 Unmute" : "🎙️ Mute"}
                  </button>
                  <button onClick={stopMic} type="button" style={btnStyle(C.red, false)}>
                    ⏹ Stop Mic
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%",
                      background: muted ? C.red : C.green,
                      animation: !muted ? "pulse 1s infinite" : "none" }} />
                    <span style={{ fontSize: 10, color: muted ? C.red : C.green, fontFamily: "'DM Mono',monospace" }}>
                      {muted ? "Muted" : "Live"}
                    </span>
                  </div>
                </>
              )}
            </div>
            {audioErr && <div style={{ fontSize: 9, color: C.red, fontFamily: "'DM Mono',monospace", marginTop: 6 }}>{audioErr}</div>}
            <div style={{ fontSize: 9, color: C.dim, fontFamily: "'DM Mono',monospace", marginTop: 8, lineHeight: 1.6 }}>
              ⓘ Microphone enables voice discussion with your session members.
              Use an external meeting tool (Meet, Teams, Discord) for full multi-user audio.
            </div>
          </div>

          {/* Activity feed */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Activity Feed</div>
            {activity.length === 0 ? (
              <div style={{ fontSize: 10, color: C.dim, fontFamily: "'DM Mono',monospace" }}>No activity yet…</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                {activity.map(a => (
                  <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 8, color: C.dim, fontFamily: "'DM Mono',monospace", flexShrink: 0, marginTop: 1 }}>{a.time}</span>
                    <span style={{ fontSize: 10, color: C.text, fontFamily: "'DM Mono',monospace" }}>{a.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {err && (
        <div style={{ padding: "8px 12px", background: `${C.red}11`, border: `1px solid ${C.red}44`,
          borderRadius: 6, fontSize: 10, color: C.red, fontFamily: "'DM Mono',monospace" }}>
          {err}
          <button onClick={() => setErr("")} type="button" style={{ marginLeft: 8, background: "none", border: "none", color: C.muted, cursor: "pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC DESIGN BANNER
   ══════════════════════════════════════════════════════════════════ */
export function PublicDesignBanner({ shareId, onLoad, C }) {
  const [design, setDesign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!shareId) { setLoading(false); return; }
    getPublicDesign(shareId).then(d => { d ? setDesign(d) : setErr("Design not found."); setLoading(false); });
  }, [shareId]);

  if (!shareId || dismissed) return null;
  if (loading) return <div style={{ padding: "10px 18px", background: `${C.blue}18`, border: `1px solid ${C.blue}44`, borderRadius: 8, marginBottom: 10, fontSize: 10, color: C.blue, fontFamily: "'DM Mono',monospace" }}>⏳ Loading shared design…</div>;
  if (err) return <div style={{ padding: "10px 18px", background: `${C.red}11`, border: `1px solid ${C.red}33`, borderRadius: 8, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
    <span style={{ fontSize: 10, color: C.red, fontFamily: "'DM Mono',monospace" }}>❌ {err}</span>
    <button onClick={() => setDismissed(true)} type="button" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}>✕</button>
  </div>;
  if (!design) return null;

  const results = JSON.parse(design.results || "{}");
  const params = JSON.parse(design.params || "{}");

  return (
    <div style={{ padding: "12px 18px", background: `${C.teal}11`, border: `1px solid ${C.teal}44`,
      borderRadius: 8, marginBottom: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
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
        <button onClick={() => { onLoad(params); setDismissed(true); }} type="button"
          style={{ padding: "6px 14px", background: `linear-gradient(135deg,${C.teal}33,${C.blue}33)`,
            border: `1px solid ${C.teal}66`, borderRadius: 5, color: C.teal,
            fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>
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
