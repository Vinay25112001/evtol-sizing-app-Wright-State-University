/* ═══════════════════════════════════════════════════════════════════════
   COMMUNITY FEATURES v3 — Real WebRTC Audio
   WebRTC peer connections via Supabase signaling (SDP offer/answer + ICE)
   Tables needed:
     evtol_webrtc_signals (id, session_id, from_user, to_user, type, payload, created_at)
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

function startPolling(table, filter, onRow, ms = 2000) {
  let active = true;
  let lastTs = new Date(Date.now() - 500).toISOString();
  const poll = async () => {
    if (!active) return;
    try {
      const rows = await sbFetch(`${table}?${filter}&created_at=gt.${lastTs}&select=*&order=created_at.asc&limit=20`);
      if (rows?.length) { lastTs = rows[rows.length - 1].created_at; rows.forEach(r => onRow(r)); }
    } catch {}
    if (active) setTimeout(poll, ms);
  };
  setTimeout(poll, ms);
  return () => { active = false; };
}

/* ── WebRTC signaling via Supabase ── */
async function sendSignal(sessionId, fromUser, toUser, type, payload) {
  await sbFetch("evtol_webrtc_signals", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({
      id: `${sessionId}_${fromUser}_${toUser}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      session_id: sessionId, from_user: fromUser, to_user: toUser,
      type, payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    }),
  });
}

/* STUN servers for NAT traversal */
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

/* ══════════════════════════════════════════════════════════════════
   PUBLIC DESIGN API (unchanged)
   ══════════════════════════════════════════════════════════════════ */
export async function publishDesign(userId, displayName, params, results) {
  const shareId = Math.random().toString(36).slice(2, 10);
  const row = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
    user_id: userId, share_id: shareId,
    name: `${displayName}'s Design — MTOW ${results.MTOW}kg`,
    params: JSON.stringify(params),
    results: JSON.stringify({ MTOW: results.MTOW, Etot: results.Etot, Phov: results.Phov,
      LDact: results.LDact, SM_vt: results.SM_vt, Wbat: results.Wbat, bWing: results.bWing }),
    display_name: displayName, is_public: true, view_count: 0, likes: 0,
    created_at: new Date().toISOString(),
  };
  await sbFetch("evtol_public_designs", { method: "POST",
    prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify(row) });
  const efficiency = (results.LDact * results.Etot) / results.MTOW;
  await sbFetch("evtol_leaderboard", { method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id: row.id, design_id: row.id, share_id: shareId, user_id: userId,
      display_name: displayName, name: row.name, metric_ld: results.LDact, metric_mtow: results.MTOW,
      metric_payload: params.payload, metric_efficiency: +efficiency.toFixed(4),
      metric_etot: results.Etot, created_at: new Date().toISOString() }) });
  return shareId;
}

export async function getPublicDesign(shareId) {
  try {
    const rows = await sbFetch(`evtol_public_designs?share_id=eq.${shareId}&is_public=eq.true&select=*`);
    if (!rows?.length) return null;
    await sbFetch(`evtol_public_designs?share_id=eq.${shareId}`, { method: "PATCH",
      body: JSON.stringify({ view_count: (rows[0].view_count || 0) + 1 }) });
    return rows[0];
  } catch { return null; }
}

export async function getLeaderboard() {
  try { return await sbFetch("evtol_leaderboard?select=*&order=metric_ld.desc&limit=50") || []; }
  catch { return []; }
}

/* ── Session API ── */
export async function createCollabSession(hostId, displayName, params) {
  const sessionId = Math.random().toString(36).slice(2, 12);
  await sbFetch("evtol_collab_sessions", { method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ session_id: sessionId, host_id: hostId, host_name: displayName,
      state_json: JSON.stringify(params), updated_at: new Date().toISOString() }) });
  return sessionId;
}

export async function getCollabSession(sessionId) {
  try { const rows = await sbFetch(`evtol_collab_sessions?session_id=eq.${sessionId}&select=*`);
    return rows?.[0] || null; } catch { return null; }
}

export async function pushCollabState(sessionId, params) {
  try { await sbFetch(`evtol_collab_sessions?session_id=eq.${sessionId}`, { method: "PATCH",
    body: JSON.stringify({ state_json: JSON.stringify(params), updated_at: new Date().toISOString() }) }); }
  catch {}
}

async function submitJoinRequest(sessionId, userId, displayName) {
  const id = `${sessionId}_${userId}_${Date.now()}`;
  await sbFetch("evtol_collab_requests", { method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id, session_id: sessionId, user_id: userId, display_name: displayName,
      status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return id;
}

async function respondToRequest(reqId, status) {
  await sbFetch(`evtol_collab_requests?id=eq.${reqId}`, { method: "PATCH",
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
}

async function addMember(sessionId, userId, displayName, role) {
  await sbFetch("evtol_collab_members", { method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify({ id: `${sessionId}_${userId}`, session_id: sessionId, user_id: userId,
      display_name: displayName, role, joined_at: new Date().toISOString(),
      updated_at: new Date().toISOString() }) });
}

async function updateMemberRole(sessionId, userId, role) {
  await sbFetch(`evtol_collab_members?session_id=eq.${sessionId}&user_id=eq.${userId}`, { method: "PATCH",
    body: JSON.stringify({ role, updated_at: new Date().toISOString() }) });
}

async function getMembers(sessionId) {
  try { return await sbFetch(`evtol_collab_members?session_id=eq.${sessionId}&select=*&order=joined_at.asc`) || []; }
  catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════
   WEBRTC AUDIO MANAGER
   Handles peer connections for every member in the session
   ══════════════════════════════════════════════════════════════════ */
function useWebRTCVoice(sessionId, myUserId, myName) {
  const [micEnabled, setMicEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioErr, setAudioErr] = useState("");
  const [peerAudios, setPeerAudios] = useState({}); // userId -> speaking state
  const [peerNames, setPeerNames] = useState({});

  const localStream   = useRef(null);
  const peers         = useRef({});   // userId -> RTCPeerConnection
  const stopSignaling = useRef(null);
  const audioRefs     = useRef({});   // userId -> <audio> element

  const cleanup = useCallback(() => {
    localStream.current?.getTracks().forEach(t => t.stop());
    localStream.current = null;
    Object.values(peers.current).forEach(pc => pc.close());
    peers.current = {};
    stopSignaling.current?.();
    stopSignaling.current = null;
    setMicEnabled(false); setMuted(false); setPeerAudios({});
  }, []);

  /* Create or get peer connection for a remote user */
  const getOrCreatePeer = useCallback((remoteUserId, remoteName, isInitiator) => {
    if (peers.current[remoteUserId]) return peers.current[remoteUserId];

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peers.current[remoteUserId] = pc;
    setPeerNames(prev => ({ ...prev, [remoteUserId]: remoteName || remoteUserId }));

    /* Add local tracks to the connection */
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => pc.addTrack(track, localStream.current));
    }

    /* Receive remote audio */
    pc.ontrack = (evt) => {
      const stream = evt.streams[0];
      if (!stream) return;
      // Create audio element to play remote stream
      let audioEl = audioRefs.current[remoteUserId];
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        audioRefs.current[remoteUserId] = audioEl;
      }
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {});
      setPeerAudios(prev => ({ ...prev, [remoteUserId]: true }));
    };

    /* Send ICE candidates via Supabase */
    pc.onicecandidate = (evt) => {
      if (evt.candidate && sessionId && myUserId) {
        sendSignal(sessionId, myUserId, remoteUserId, "ice-candidate", evt.candidate).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        setPeerAudios(prev => { const n = { ...prev }; delete n[remoteUserId]; return n; });
      }
    };

    /* Initiator creates the offer */
    if (isInitiator) {
      pc.createOffer({ offerToReceiveAudio: true })
        .then(offer => pc.setLocalDescription(offer))
        .then(() => sendSignal(sessionId, myUserId, remoteUserId, "offer", pc.localDescription))
        .catch(e => setAudioErr("Offer failed: " + e.message));
    }

    return pc;
  }, [sessionId, myUserId]);

  /* Handle incoming signals */
  const handleSignal = useCallback(async (sig) => {
    if (sig.to_user !== myUserId) return;
    const from = sig.from_user;
    const payload = JSON.parse(sig.payload || "{}");

    if (sig.type === "offer") {
      const pc = getOrCreatePeer(from, null, false);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(sessionId, myUserId, from, "answer", pc.localDescription);

    } else if (sig.type === "answer") {
      const pc = peers.current[from];
      if (pc && pc.signalingState !== "stable") {
        await pc.setRemoteDescription(new RTCSessionDescription(payload)).catch(() => {});
      }

    } else if (sig.type === "ice-candidate") {
      const pc = peers.current[from];
      if (pc) { await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {}); }

    } else if (sig.type === "join-announce") {
      // New peer joined — if we already have mic open, initiate connection to them
      if (localStream.current && from !== myUserId) {
        getOrCreatePeer(from, payload.name, true);
      }
      setPeerNames(prev => ({ ...prev, [from]: payload.name || from }));
    }
  }, [myUserId, sessionId, getOrCreatePeer]);

  /* Start mic and begin signaling */
  const enableMic = useCallback(async (existingMembers = []) => {
    setAudioErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }, video: false });
      localStream.current = stream;
      setMicEnabled(true); setMuted(false);

      /* Announce presence to all existing members */
      if (sessionId && myUserId) {
        await sendSignal(sessionId, myUserId, "all", "join-announce", { name: myName });

        /* Create offers to all existing members */
        existingMembers.forEach(mem => {
          if (mem.user_id !== myUserId) {
            getOrCreatePeer(mem.user_id, mem.display_name, true);
          }
        });
      }

      /* Start polling for signals directed to me */
      stopSignaling.current = startPolling(
        "evtol_webrtc_signals",
        `session_id=eq.${sessionId}`,
        (sig) => {
          if (sig.to_user === myUserId || sig.to_user === "all") {
            handleSignal(sig).catch(() => {});
          }
        },
        800  // 800ms poll for low-latency signaling
      );

    } catch (e) {
      setAudioErr(
        e.name === "NotAllowedError"
          ? "Microphone access denied. Please allow mic access in your browser settings."
          : e.name === "NotFoundError"
          ? "No microphone found. Please connect a microphone."
          : "Mic error: " + e.message
      );
    }
  }, [sessionId, myUserId, myName, getOrCreatePeer, handleSignal]);

  const toggleMute = useCallback(() => {
    if (!localStream.current) return;
    const newMuted = !muted;
    localStream.current.getAudioTracks().forEach(t => { t.enabled = !newMuted; });
    setMuted(newMuted);
  }, [muted]);

  const disableMic = useCallback(() => {
    cleanup();
  }, [cleanup]);

  /* Cleanup on unmount */
  useEffect(() => () => {
    cleanup();
    Object.values(audioRefs.current).forEach(el => { el.srcObject = null; el.remove(); });
    audioRefs.current = {};
  }, [cleanup]);

  return { micEnabled, muted, audioErr, peerAudios, peerNames, enableMic, toggleMute, disableMic };
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
    if (!user) { setErr("Sign in to share."); return; }
    setSharing(true); setErr("");
    try {
      const n = user.name || user.email?.split("@")[0] || "Anonymous";
      setShareId(await publishDesign(user.id, n, params, results));
    } catch (e) { setErr("Failed: " + e.message); }
    setSharing(false);
  };

  const url = shareId ? `${location.origin}${location.pathname}?design=${shareId}` : "";
  const copy = () => navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {!shareId ? (
        <button onClick={handleShare} disabled={sharing} type="button"
          style={{ padding: "5px 14px", background: `${C.purple}22`, border: `1px solid ${C.purple}66`,
            borderRadius: 4, color: C.purple, fontSize: 9, cursor: sharing ? "wait" : "pointer",
            fontFamily: "'DM Mono',monospace", fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
          {!user && "🔒"}{sharing ? "⏳ Sharing..." : "🔗 Share Design"}
        </button>
      ) : (
        <div style={{ position: "absolute", right: 0, top: 32, zIndex: 200, background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", width: 320,
          boxShadow: "0 8px 30px rgba(0,0,0,0.4)" }}>
          <div style={{ fontSize: 10, color: C.green, fontFamily: "'DM Mono',monospace", marginBottom: 6, fontWeight: 700 }}>✓ Published! Share this link:</div>
          <div style={{ display: "flex", gap: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 5, padding: "5px 8px" }}>
            <span style={{ fontSize: 9, color: C.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "'DM Mono',monospace" }}>{url}</span>
            <button onClick={copy} type="button" style={{ padding: "3px 8px", background: copied ? `${C.green}22` : `${C.amber}22`,
              border: `1px solid ${copied ? C.green : C.amber}44`, borderRadius: 3, color: copied ? C.green : C.amber, fontSize: 9, cursor: "pointer" }}>
              {copied ? "✓" : "Copy"}
            </button>
          </div>
          <button onClick={() => setShareId(null)} type="button" style={{ marginTop: 6, background: "none", border: "none", color: C.muted, fontSize: 9, cursor: "pointer" }}>Close</button>
        </div>
      )}
      {err && <div style={{ position: "absolute", right: 0, top: 32, zIndex: 200, background: C.panel,
        border: `1px solid ${C.red}44`, borderRadius: 6, padding: "8px 12px", fontSize: 10, color: C.red, width: 220, fontFamily: "'DM Mono',monospace" }}>
        {err}<button onClick={() => setErr("")} type="button" style={{ marginLeft: 6, background: "none", border: "none", color: C.muted, cursor: "pointer" }}>✕</button>
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
    { key:"ld",   label:"Best L/D",       field:"metric_ld",         fmt:v=>v?.toFixed(2),         col:"#14b8a6", icon:"🏆", asc:false },
    { key:"mtow", label:"Lowest MTOW",     field:"metric_mtow",       fmt:v=>v?.toFixed(0)+" kg",   col:"#f59e0b", icon:"⚖️", asc:true  },
    { key:"eff",  label:"Best Efficiency", field:"metric_efficiency", fmt:v=>v?.toFixed(3),         col:"#8b5cf6", icon:"⚡", asc:false },
    { key:"etot", label:"Lowest Energy",   field:"metric_etot",       fmt:v=>v?.toFixed(1)+" kWh",  col:"#3b82f6", icon:"🔋", asc:true  },
  ];

  useEffect(() => { setLoading(true); getLeaderboard().then(r => { setData(r); setLoading(false); }); }, []);
  const at = tabs.find(t => t.key === tab);
  const sorted = [...data].sort((a,b) => at.asc?(a[at.field]||0)-(b[at.field]||0):(b[at.field]||0)-(a[at.field]||0)).slice(0,10);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ background:`linear-gradient(135deg,${C.purple}18,${C.teal}18)`, border:`1px solid ${C.purple}33`, borderRadius:10, padding:"14px 18px" }}>
        <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:"0.18em", marginBottom:4 }}>COMMUNITY LEADERBOARD</div>
        <div style={{ fontSize:16, fontWeight:800, color:C.text }}><span style={{ color:C.purple }}>eVTOL</span> Design Rankings</div>
        <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:4 }}>{data.length} designs submitted.</div>
      </div>
      <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
        {tabs.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} type="button" style={{ padding:"6px 12px", borderRadius:6, fontSize:10,
            fontFamily:"'DM Mono',monospace", fontWeight:700, cursor:"pointer",
            background:tab===t.key?`${t.col}22`:"transparent", border:`1px solid ${tab===t.key?t.col+"66":C.border}`, color:tab===t.key?t.col:C.muted }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      {loading ? <div style={{ textAlign:"center", padding:24, color:C.muted, fontSize:12, fontFamily:"'DM Mono',monospace" }}>⏳ Loading...</div>
      : sorted.length===0 ? <div style={{ textAlign:"center", padding:24, color:C.muted, fontSize:11, fontFamily:"'DM Mono',monospace", background:C.panel, borderRadius:8, border:`1px solid ${C.border}` }}>No designs yet. Be the first! 🚁</div>
      : (
        <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>
          <div style={{ display:"grid", gridTemplateColumns:"40px 1fr 110px 80px 80px 60px", gap:8, padding:"8px 14px",
            background:C.bg, borderBottom:`1px solid ${C.border}`, fontSize:8, color:C.muted, fontFamily:"'DM Mono',monospace", textTransform:"uppercase" }}>
            <span>#</span><span>Designer</span><span>{at.label}</span><span>L/D</span><span>MTOW</span><span>View</span>
          </div>
          {sorted.map((row,i)=>(
            <div key={row.id||i} style={{ display:"grid", gridTemplateColumns:"40px 1fr 110px 80px 80px 60px", gap:8,
              padding:"10px 14px", background:i<3?`${at.col}08`:"transparent", borderBottom:`1px solid ${C.border}22`,
              alignItems:"center", cursor:"pointer" }}
              onMouseEnter={e=>e.currentTarget.style.background=`${at.col}12`}
              onMouseLeave={e=>e.currentTarget.style.background=i<3?`${at.col}08`:"transparent"}
              onClick={()=>onLoadDesign&&onLoadDesign(row)}>
              <span style={{ fontSize:14, textAlign:"center" }}>{["🥇","🥈","🥉"][i]||<span style={{ fontSize:11,color:C.muted }}>{i+1}</span>}</span>
              <div>
                <div style={{ fontSize:10, fontWeight:700, color:C.text, fontFamily:"'DM Mono',monospace" }}>{row.display_name||"Anonymous"}</div>
                <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{row.name?.slice(0,40)||"—"}</div>
              </div>
              <span style={{ fontSize:12, fontWeight:700, color:at.col, fontFamily:"'DM Mono',monospace" }}>{at.fmt(row[at.field])}</span>
              <span style={{ fontSize:10, color:C.teal, fontFamily:"'DM Mono',monospace" }}>{row.metric_ld?.toFixed(2)||"—"}</span>
              <span style={{ fontSize:10, color:C.amber, fontFamily:"'DM Mono',monospace" }}>{row.metric_mtow?.toFixed(0)||"—"} kg</span>
              <button type="button" style={{ padding:"3px 6px", background:`${C.teal}22`, border:`1px solid ${C.teal}44`, borderRadius:3, color:C.teal, fontSize:8, cursor:"pointer" }}
                onClick={e=>{e.stopPropagation();if(row.share_id)window.open(`?design=${row.share_id}`,"_blank");}}>View</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   COLLABORATION PANEL v3 — Real WebRTC Voice
   ══════════════════════════════════════════════════════════════════ */
export function CollabPanel({ user, params, onParamChange, C }) {
  const [sessionId, setSessionId]       = useState("");
  const [joinId, setJoinId]             = useState("");
  const [inSession, setInSession]       = useState(false);
  const [isHost, setIsHost]             = useState(false);
  const [myRole, setMyRole]             = useState("viewer");
  const [members, setMembers]           = useState([]);
  const [pendingReqs, setPendingReqs]   = useState([]);
  const [activity, setActivity]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [err, setErr]                   = useState("");
  const [copied, setCopied]             = useState(false);
  const [waitingApproval, setWaiting]   = useState(false);
  const [myReqId, setMyReqId]           = useState(null);

  const myId   = user?.id   || "anon_" + Math.random().toString(36).slice(2,8);
  const myName = user?.name || user?.email?.split("@")[0] || "Anonymous";

  const { micEnabled, muted, audioErr, peerAudios, peerNames,
          enableMic, toggleMute, disableMic } = useWebRTCVoice(sessionId, myId, myName);

  const stopPollState   = useRef(null);
  const stopPollReqs    = useRef(null);
  const stopPollMembers = useRef(null);
  const stopPollApproval= useRef(null);
  const lastPush        = useRef(0);

  const addLog = useCallback((msg) => {
    setActivity(prev => [{ msg, time: new Date().toLocaleTimeString(), id: Math.random() }, ...prev].slice(0,30));
  }, []);

  /* Push params as host */
  useEffect(() => {
    if (!inSession || !isHost || myRole !== "editor") return;
    const now = Date.now();
    if (now - lastPush.current < 1000) return;
    lastPush.current = now;
    pushCollabState(sessionId, params);
  }, [params, inSession, isHost, sessionId, myRole]);

  const leaveSession = () => {
    [stopPollState, stopPollReqs, stopPollMembers, stopPollApproval].forEach(r=>r.current?.());
    disableMic();
    setInSession(false); setIsHost(false); setSessionId(""); setJoinId("");
    setMembers([]); setPendingReqs([]); setActivity([]);
    setWaiting(false); setMyReqId(null); setMyRole("viewer");
  };

  /* ── Host: Start ── */
  const startSession = async () => {
    if (!user) { setErr("Sign in to host."); return; }
    setLoading(true); setErr("");
    try {
      const sid = await createCollabSession(myId, myName, params);
      setSessionId(sid); setInSession(true); setIsHost(true); setMyRole("editor");
      addLog("🏠 Session started. Share the ID above.");

      stopPollReqs.current = startPolling("evtol_collab_requests", `session_id=eq.${sid}&status=eq.pending`,
        req => setPendingReqs(prev => prev.find(r=>r.id===req.id)?prev:[...prev,req].slice(0,20)), 2500);

      stopPollMembers.current = startPolling("evtol_collab_members", `session_id=eq.${sid}`,
        () => getMembers(sid).then(setMembers), 4000);
    } catch(e) { setErr("Failed: " + e.message); }
    setLoading(false);
  };

  /* ── Guest: Request join ── */
  const requestJoin = async () => {
    if (!joinId.trim()) { setErr("Enter session ID."); return; }
    if (!user) { setErr("Sign in to join."); return; }
    setLoading(true); setErr("");
    try {
      const session = await getCollabSession(joinId.trim());
      if (!session) { setErr("Session not found."); setLoading(false); return; }
      const reqId = await submitJoinRequest(joinId.trim(), myId, myName);
      setMyReqId(reqId); setWaiting(true); setSessionId(joinId.trim());
      addLog("📤 Join request sent. Waiting for host approval...");

      stopPollApproval.current = startPolling("evtol_collab_requests", `id=eq.${reqId}`,
        req => {
          if (req.status === "approved") {
            stopPollApproval.current?.();
            setWaiting(false); setInSession(true); setIsHost(false);
            getMembers(joinId.trim()).then(mems => {
              const me = mems.find(m=>m.user_id===myId);
              setMyRole(me?.role||"viewer"); setMembers(mems);
            });
            getCollabSession(joinId.trim()).then(s => {
              if (s?.state_json) { try { const st=JSON.parse(s.state_json); Object.entries(st).forEach(([k,v])=>onParamChange(k)(v)); } catch{} }
            });
            addLog("✅ Approved! You are now in the session.");
            stopPollState.current = startPolling("evtol_collab_sessions", `session_id=eq.${joinId.trim()}`,
              row => { try { const st=JSON.parse(row.state_json||"{}"); Object.entries(st).forEach(([k,v])=>onParamChange(k)(v)); addLog("🔄 Host updated params"); } catch{} }, 2000);
            stopPollMembers.current = startPolling("evtol_collab_members", `session_id=eq.${joinId.trim()}`,
              () => getMembers(joinId.trim()).then(setMembers), 4000);
          } else if (req.status === "denied") {
            stopPollApproval.current?.();
            setWaiting(false); setSessionId(""); setMyReqId(null);
            setErr("❌ Host denied your request.");
          }
        }, 2000);
    } catch(e) { setErr("Failed: " + e.message); }
    setLoading(false);
  };

  /* ── Host: Approve/Deny ── */
  const handleRequest = async (req, approved) => {
    try {
      await respondToRequest(req.id, approved ? "approved" : "denied");
      if (approved) {
        await addMember(sessionId, req.user_id, req.display_name, "viewer");
        getMembers(sessionId).then(setMembers);
        addLog(`✅ ${req.display_name} joined as viewer`);
      } else {
        addLog(`❌ Denied ${req.display_name}`);
      }
      setPendingReqs(prev => prev.filter(r=>r.id!==req.id));
    } catch(e) { setErr("Failed: " + e.message); }
  };

  const changeMemberRole = async (mem, newRole) => {
    try {
      await updateMemberRole(sessionId, mem.user_id, newRole);
      setMembers(prev => prev.map(m=>m.user_id===mem.user_id?{...m,role:newRole}:m));
      addLog(`🔑 ${mem.display_name} → ${newRole}`);
    } catch(e) { setErr("Failed: " + e.message); }
  };

  const handleEnableMic = () => enableMic(members);
  const copyLink = () => {
    navigator.clipboard.writeText(`${location.origin}${location.pathname}?session=${sessionId}`)
      .then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
  };

  const btn = (col, active=false) => ({
    padding:"7px 14px", borderRadius:6, border:`1px solid ${col}66`,
    background:active?`${col}33`:`${col}18`, color:col,
    fontSize:11, fontWeight:700, fontFamily:"'DM Mono',monospace", cursor:"pointer",
  });

  const connectedPeers = Object.keys(peerAudios);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {/* Header */}
      <div style={{ background:`linear-gradient(135deg,${C.teal}18,${C.blue}18)`, border:`1px solid ${C.teal}33`, borderRadius:10, padding:"14px 18px" }}>
        <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:"0.18em", marginBottom:4 }}>REAL-TIME COLLABORATION v3</div>
        <div style={{ fontSize:16, fontWeight:800, color:C.text }}><span style={{ color:C.teal }}>Live</span> Design Sessions</div>
        <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:4 }}>
          Host approval · Role-based access · <strong style={{color:C.teal}}>WebRTC peer-to-peer voice</strong>
        </div>
      </div>

      {/* ── Not in session ── */}
      {!inSession && !waitingApproval && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <div style={{ background:C.panel, border:`1px solid ${C.teal}33`, borderRadius:8, padding:"14px 16px" }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.teal, fontFamily:"'DM Mono',monospace", marginBottom:8 }}>🏠 Host a Session</div>
            <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginBottom:12, lineHeight:1.6 }}>
              Start a live session. You approve joiners and control access.
            </div>
            <button onClick={startSession} disabled={loading} type="button" style={btn(C.teal)}>
              {loading ? "Starting..." : "Start Session →"}
            </button>
            {!user && <div style={{ fontSize:9, color:C.amber, fontFamily:"'DM Mono',monospace", marginTop:6 }}>⚠ Sign in required</div>}
          </div>
          <div style={{ background:C.panel, border:`1px solid ${C.blue}33`, borderRadius:8, padding:"14px 16px" }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.blue, fontFamily:"'DM Mono',monospace", marginBottom:8 }}>🔗 Join a Session</div>
            <input value={joinId} onChange={e=>setJoinId(e.target.value)} placeholder="Session ID..."
              style={{ width:"100%", boxSizing:"border-box", background:C.bg, border:`1px solid ${C.border}`,
                borderRadius:4, color:C.text, fontSize:11, padding:"7px 10px", fontFamily:"'DM Mono',monospace", outline:"none", marginBottom:8 }}/>
            <button onClick={requestJoin} disabled={loading} type="button" style={btn(C.blue)}>
              {loading ? "Requesting..." : "Send Join Request →"}
            </button>
            {!user && <div style={{ fontSize:9, color:C.amber, fontFamily:"'DM Mono',monospace", marginTop:6 }}>⚠ Sign in required</div>}
          </div>
        </div>
      )}

      {/* ── Waiting for approval ── */}
      {waitingApproval && (
        <div style={{ background:C.panel, border:`1px solid ${C.amber}44`, borderRadius:8, padding:20, textAlign:"center" }}>
          <div style={{ fontSize:24, marginBottom:10 }}>⏳</div>
          <div style={{ fontSize:13, fontWeight:700, color:C.amber, fontFamily:"'DM Mono',monospace", marginBottom:6 }}>Waiting for host approval…</div>
          <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginBottom:14 }}>This page updates automatically when approved.</div>
          <button onClick={leaveSession} type="button" style={btn(C.red)}>Cancel</button>
        </div>
      )}

      {/* ── Active session ── */}
      {inSession && (
        <>
          {/* Status bar */}
          <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px",
            background:`${C.green}11`, border:`1px solid ${C.green}44`, borderRadius:8 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:C.green, animation:"pulse 2s infinite" }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, fontWeight:700, color:C.green, fontFamily:"'DM Mono',monospace" }}>
                {isHost ? "🏠 Hosting" : `👥 Joined as ${myRole}`}
              </div>
              <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace" }}>
                ID: <span style={{ color:C.amber, fontWeight:700 }}>{sessionId}</span>
                {" · "}{myRole==="editor" ? "✏️ Editor" : "👁 Viewer (read-only)"}
              </div>
            </div>
            {isHost && <button onClick={copyLink} type="button" style={btn(C.amber, copied)}>{copied?"✓ Copied":"📋 Copy Link"}</button>}
            <button onClick={leaveSession} type="button" style={btn(C.red)}>Leave</button>
          </div>

          {/* Pending requests (host) */}
          {isHost && pendingReqs.length > 0 && (
            <div style={{ background:C.panel, border:`2px solid ${C.amber}`, borderRadius:8, padding:"14px 16px", boxShadow:`0 0 20px ${C.amber}33` }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.amber, fontFamily:"'DM Mono',monospace", marginBottom:10 }}>
                📩 {pendingReqs.length} pending join request{pendingReqs.length>1?"s":""}
              </div>
              {pendingReqs.map(req=>(
                <div key={req.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px",
                  background:C.bg, borderRadius:6, marginBottom:8, border:`1px solid ${C.border}` }}>
                  <div style={{ width:36, height:36, borderRadius:"50%", background:`linear-gradient(135deg,${C.teal},${C.blue})`,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:800, color:"#fff", flexShrink:0 }}>
                    {req.display_name?.[0]?.toUpperCase()||"?"}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:C.text, fontFamily:"'DM Mono',monospace" }}>{req.display_name}</div>
                    <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace" }}>Wants to join</div>
                  </div>
                  <button onClick={()=>handleRequest(req,true)} type="button" style={{ padding:"6px 12px", background:`${C.green}22`, border:`1px solid ${C.green}66`, borderRadius:5, color:C.green, fontSize:10, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontWeight:700 }}>✓ Accept</button>
                  <button onClick={()=>handleRequest(req,false)} type="button" style={{ padding:"6px 12px", background:`${C.red}11`, border:`1px solid ${C.red}33`, borderRadius:5, color:C.red, fontSize:10, cursor:"pointer", fontFamily:"'DM Mono',monospace" }}>✕ Deny</button>
                </div>
              ))}
            </div>
          )}

          {/* Members list */}
          {members.length > 0 && (
            <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:"12px 14px" }}>
              <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10 }}>
                👥 Members ({members.length})
              </div>
              {members.map(mem=>{
                const speaking = connectedPeers.includes(mem.user_id);
                return (
                  <div key={mem.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:`1px solid ${C.border}22` }}>
                    <div style={{ position:"relative" }}>
                      <div style={{ width:32, height:32, borderRadius:"50%",
                        background:`linear-gradient(135deg,${mem.role==="editor"?C.amber:C.blue},${C.teal})`,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:13, fontWeight:800, color:"#fff", boxShadow: speaking?`0 0 8px ${C.green}`:"none" }}>
                        {mem.display_name?.[0]?.toUpperCase()||"?"}
                      </div>
                      {speaking && <div style={{ position:"absolute", bottom:-2, right:-2, width:10, height:10,
                        borderRadius:"50%", background:C.green, border:`2px solid ${C.panel}`,
                        animation:"pulse 1s infinite" }}/>}
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:C.text, fontFamily:"'DM Mono',monospace" }}>{mem.display_name}</div>
                      <div style={{ fontSize:9, color:mem.role==="editor"?C.amber:C.muted, fontFamily:"'DM Mono',monospace" }}>
                        {mem.role==="editor"?"✏️ Editor":"👁 Viewer"}
                        {speaking ? <span style={{ color:C.green, marginLeft:6 }}>🎙 Speaking</span> : ""}
                      </div>
                    </div>
                    {isHost && (
                      <button onClick={()=>changeMemberRole(mem, mem.role==="editor"?"viewer":"editor")} type="button"
                        style={{ padding:"4px 10px", background:mem.role==="editor"?`${C.muted}22`:`${C.amber}22`,
                          border:`1px solid ${mem.role==="editor"?C.muted:C.amber}44`,
                          borderRadius:4, color:mem.role==="editor"?C.muted:C.amber,
                          fontSize:9, cursor:"pointer", fontFamily:"'DM Mono',monospace" }}>
                        {mem.role==="editor"?"→ Viewer":"→ Editor"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── WebRTC Voice Controls ── */}
          <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:"14px 16px" }}>
            <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:12 }}>
              🎙️ Voice Chat — WebRTC peer-to-peer
            </div>

            {!micEnabled ? (
              <div>
                <button onClick={handleEnableMic} type="button"
                  style={{ ...btn(C.teal), display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  🎙️ Enable Microphone & Join Voice
                </button>
                <div style={{ fontSize:9, color:C.dim, fontFamily:"'DM Mono',monospace", lineHeight:1.6 }}>
                  Click to enable your mic. When others also enable theirs, you will hear each other directly via WebRTC (peer-to-peer, no server).
                  Your browser will ask for mic permission — please allow it.
                </div>
              </div>
            ) : (
              <div>
                {/* Main voice controls */}
                <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginBottom:12 }}>
                  <button onClick={toggleMute} type="button"
                    style={{ ...btn(muted?C.red:C.green, true), minWidth:130, display:"flex", alignItems:"center", gap:8 }}>
                    {muted ? "🔇 Unmute" : "🎙️ Mute"}
                  </button>
                  <button onClick={disableMic} type="button" style={{ ...btn(C.red), display:"flex", alignItems:"center", gap:6 }}>
                    ⏹ Leave Voice
                  </button>
                  {/* Live indicator */}
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:10, height:10, borderRadius:"50%", background:muted?C.red:C.green,
                      animation:!muted?"pulse 1s infinite":"none" }}/>
                    <span style={{ fontSize:11, color:muted?C.red:C.green, fontFamily:"'DM Mono',monospace", fontWeight:700 }}>
                      {muted ? "Muted" : "Live"}
                    </span>
                  </div>
                </div>

                {/* Connected peers */}
                {connectedPeers.length > 0 ? (
                  <div style={{ background:C.bg, border:`1px solid ${C.green}33`, borderRadius:6, padding:"8px 12px" }}>
                    <div style={{ fontSize:9, color:C.green, fontFamily:"'DM Mono',monospace", marginBottom:6 }}>
                      🔗 Voice connected with {connectedPeers.length} peer{connectedPeers.length>1?"s":""}:
                    </div>
                    {connectedPeers.map(uid=>(
                      <div key={uid} style={{ display:"flex", alignItems:"center", gap:6, padding:"3px 0" }}>
                        <div style={{ width:6, height:6, borderRadius:"50%", background:C.green, animation:"pulse 1s infinite" }}/>
                        <span style={{ fontSize:10, color:C.text, fontFamily:"'DM Mono',monospace" }}>{peerNames[uid]||uid}</span>
                        <span style={{ fontSize:9, color:C.green, fontFamily:"'DM Mono',monospace" }}>🎙 live</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", padding:"8px 0" }}>
                    Waiting for other members to enable their mic…
                  </div>
                )}

                <div style={{ fontSize:9, color:C.dim, fontFamily:"'DM Mono',monospace", marginTop:8, lineHeight:1.6 }}>
                  ⓘ Audio is direct peer-to-peer (WebRTC). Requires both users to click "Enable Microphone".
                  Works best on Chrome/Edge. STUN servers: Google + Cloudflare.
                </div>
              </div>
            )}

            {audioErr && (
              <div style={{ marginTop:8, padding:"8px 12px", background:`${C.red}11`, border:`1px solid ${C.red}44`,
                borderRadius:6, fontSize:10, color:C.red, fontFamily:"'DM Mono',monospace" }}>
                ⚠ {audioErr}
                <div style={{ fontSize:9, color:C.muted, marginTop:4 }}>
                  Check that your browser allows microphone access (look for the 🔒 icon in the URL bar).
                </div>
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 14px" }}>
            <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:8 }}>Activity</div>
            {activity.length===0 ? <div style={{ fontSize:10, color:C.dim, fontFamily:"'DM Mono',monospace" }}>No activity yet…</div> : (
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:160, overflowY:"auto" }}>
                {activity.map(a=>(
                  <div key={a.id} style={{ display:"flex", gap:8 }}>
                    <span style={{ fontSize:8, color:C.dim, fontFamily:"'DM Mono',monospace", flexShrink:0 }}>{a.time}</span>
                    <span style={{ fontSize:10, color:C.text, fontFamily:"'DM Mono',monospace" }}>{a.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {err && (
        <div style={{ padding:"8px 12px", background:`${C.red}11`, border:`1px solid ${C.red}44`,
          borderRadius:6, fontSize:10, color:C.red, fontFamily:"'DM Mono',monospace" }}>
          {err}<button onClick={()=>setErr("")} type="button" style={{ marginLeft:8, background:"none", border:"none", color:C.muted, cursor:"pointer" }}>✕</button>
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
    getPublicDesign(shareId).then(d => { d?setDesign(d):setErr("Design not found."); setLoading(false); });
  }, [shareId]);

  if (!shareId||dismissed) return null;
  if (loading) return <div style={{ padding:"10px 18px", background:`${C.blue}18`, border:`1px solid ${C.blue}44`, borderRadius:8, marginBottom:10, fontSize:10, color:C.blue, fontFamily:"'DM Mono',monospace" }}>⏳ Loading shared design…</div>;
  if (err) return <div style={{ padding:"10px 18px", background:`${C.red}11`, border:`1px solid ${C.red}33`, borderRadius:8, marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
    <span style={{ fontSize:10, color:C.red, fontFamily:"'DM Mono',monospace" }}>❌ {err}</span>
    <button onClick={()=>setDismissed(true)} type="button" style={{ background:"none", border:"none", color:C.muted, cursor:"pointer" }}>✕</button>
  </div>;
  if (!design) return null;

  const results = JSON.parse(design.results||"{}");
  const params  = JSON.parse(design.params||"{}");

  return (
    <div style={{ padding:"12px 18px", background:`${C.teal}11`, border:`1px solid ${C.teal}44`, borderRadius:8, marginBottom:10, display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
      <span style={{ fontSize:16 }}>🔗</span>
      <div style={{ flex:1, minWidth:200 }}>
        <div style={{ fontSize:10, color:C.teal, fontFamily:"'DM Mono',monospace", fontWeight:700 }}>Viewing design by {design.display_name||"Anonymous"}</div>
        <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>MTOW:{results.MTOW}kg · L/D:{results.LDact} · {results.Etot}kWh · {design.view_count} views</div>
      </div>
      <button onClick={()=>{onLoad(params);setDismissed(true);}} type="button"
        style={{ padding:"6px 14px", background:`linear-gradient(135deg,${C.teal}33,${C.blue}33)`,
          border:`1px solid ${C.teal}66`, borderRadius:5, color:C.teal, fontSize:10, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontWeight:700 }}>
        Load & Explore →
      </button>
      <button onClick={()=>setDismissed(true)} type="button" style={{ padding:"6px 10px", background:"none", border:`1px solid ${C.border}`, borderRadius:5, color:C.muted, fontSize:10, cursor:"pointer" }}>✕</button>
    </div>
  );
}
