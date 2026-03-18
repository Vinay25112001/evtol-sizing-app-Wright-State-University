/* ═══════════════════════════════════════════════════════════════════
   COMMUNITY FEATURES v6 — Complete rewrite with all fixes

   PARAM SYNC FIXES:
   - Replaced poll() for state with setInterval+dbGet() tracking updated_at
   - Both host AND guest editor changes sync in real-time, both directions
   - Echo prevention: skip rows where updated_by === myId

   WEBRTC VOICE FIXES:
   - Added FREE TURN server (openrelay.metered.ca) for NAT traversal
   - ontrack: use evt.track + MediaStream() fallback (not streams[0])
   - Signal polling uses dbGet() not poll() — no created_at filter issue
   - Cleaner offer/answer: explicit createOffer with offerToReceiveAudio
   - Only initiator (lower userId) creates offer — no collision possible
   ═══════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback } from "react";

const SB_URL = "https://obribjypwwrbhsyjllua.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";

/* ── HTTP helpers ── */
const baseHdrs = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function dbGet(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: baseHdrs });
    if (!r.ok) return [];
    const t = await r.text();
    const d = t ? JSON.parse(t) : [];
    return Array.isArray(d) ? d : (d ? [d] : []);
  } catch { return []; }
}

async function dbPost(path, body, prefer = "return=representation") {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...baseHdrs, "Prefer": prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`POST ${r.status}: ${t.slice(0,100)}`); }
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

async function dbPatch(path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...baseHdrs, "Prefer": "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`PATCH ${r.status}: ${t.slice(0,100)}`); }
  return null;
}

/* ── Interval-based state sync ──
   Polls a single row by primary key every `ms` ms.
   Calls cb(row) whenever updated_at changes.
   Returns a stop function. */
function syncRow(path, ms, cb) {
  let active = true;
  let lastUpdated = "";
  const tick = async () => {
    if (!active) return;
    const rows = await dbGet(path);
    const row = rows[0];
    if (row && row.updated_at !== lastUpdated) {
      lastUpdated = row.updated_at;
      cb(row);
    }
    if (active) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
  return () => { active = false; };
}

/* ── New-row polling ── polls for rows with created_at > since ── */
function pollNew(table, filter, cb, ms = 1500) {
  let active = true;
  let since = new Date().toISOString();
  const tick = async () => {
    if (!active) return;
    const enc = encodeURIComponent(since);
    const rows = await dbGet(`${table}?${filter}&created_at=gt.${enc}&order=created_at.asc&limit=50`);
    if (rows.length) { since = rows[rows.length-1].created_at; rows.forEach(cb); }
    if (active) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
  return () => { active = false; };
}

/* ══════════════════════════════════════════════════════
   WEBRTC VOICE — v7
   Fixes for intermittent audio:
   1. All callbacks use refs — no stale closure ever
   2. offerSent ref prevents duplicate offer sending
   3. Single offer-sending path (hello handler only)
   4. Auto-reconnect on ICE failure
   5. handleSignal stored in ref, poll always uses latest
   ══════════════════════════════════════════════════════ */

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

async function sendSignal(sessionId, fromId, toId, type, payload) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  await dbPost("evtol_webrtc_signals", {
    id, session_id: sessionId, from_user: fromId, to_user: toId,
    type, payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
}

function useVoice(sessionId, myId) {
  const [micOn,    setMicOn]   = useState(false);
  const [muted,    setMuted]   = useState(false);
  const [audioErr, setAudioErr]= useState("");
  const [peers,    setPeers]   = useState({});

  // All mutable state in refs so callbacks never go stale
  const localStream  = useRef(null);
  const pcs          = useRef({});    // remoteId → RTCPeerConnection
  const iceBuf       = useRef({});    // remoteId → candidate[]
  const audioEls     = useRef({});    // remoteId → HTMLAudioElement
  const offerSent    = useRef({});    // remoteId → bool  (prevent duplicate offers)
  const stopSig      = useRef(null);
  const sessionRef   = useRef(sessionId);
  const myIdRef      = useRef(myId);
  sessionRef.current = sessionId;
  myIdRef.current    = myId;

  // Stored in a ref so the poll callback always calls the latest version
  const handleSignalRef = useRef(null);

  /* Deterministic: lower userId is caller */
  const isInitiator = (remoteId) => myIdRef.current < remoteId;

  /* ── Create peer connection ── */
  const makePeer = useCallback((remoteId, remoteName) => {
    // Close and recreate if in a broken state
    const existing = pcs.current[remoteId];
    if (existing && !["failed","closed","disconnected"].includes(existing.connectionState)) {
      return existing;
    }
    if (existing) { try { existing.close(); } catch {} }

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcs.current[remoteId]  = pc;
    iceBuf.current[remoteId] = [];
    offerSent.current[remoteId] = false;

    // Attach local tracks
    if (localStream.current) {
      localStream.current.getTracks().forEach(t => pc.addTrack(t, localStream.current));
    }

    // Play remote audio
    pc.ontrack = (evt) => {
      const stream = (evt.streams && evt.streams[0])
        ? evt.streams[0]
        : new MediaStream([evt.track]);

      let el = audioEls.current[remoteId];
      if (!el) {
        el = document.createElement("audio");
        el.autoplay = true;
        el.playsInline = true;
        document.body.appendChild(el);
        audioEls.current[remoteId] = el;
      }
      el.srcObject = stream;
      el.volume = 1.0;
      el.play().catch(() => {
        const unlock = () => { el.play().catch(()=>{}); };
        document.addEventListener("click",    unlock, { once: true });
        document.addEventListener("keydown",  unlock, { once: true });
        document.addEventListener("touchend", unlock, { once: true });
      });
      setPeers(p => ({ ...p, [remoteId]: { name: remoteName || remoteId, state: "connected" } }));
    };

    // Relay ICE via Supabase
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignal(sessionRef.current, myIdRef.current, remoteId, "ice", candidate.toJSON()).catch(()=>{});
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setPeers(p => ({ ...p, [remoteId]: { ...(p[remoteId]||{}), state } }));

      if (state === "failed") {
        // Fully recreate — iceRestart needs both sides to cooperate which is fragile.
        // Easier: close this pc, clear offerSent, re-announce with a fresh hello.
        pc.close();
        delete pcs.current[remoteId];
        delete offerSent.current[remoteId];
        setPeers(p => { const n={...p}; delete n[remoteId]; return n; });
        // Re-announce so the other peer also restarts
        if (localStream.current) {
          const myName = myIdRef.current;
          sendSignal(sessionRef.current, myIdRef.current, "all", "hello", { name: myName }).catch(()=>{});
        }
      }

      // "disconnected" is transient — WebRTC will try to recover automatically.
      // Only clean up on permanent "closed".
      if (state === "closed") {
        const el = audioEls.current[remoteId];
        if (el) { el.srcObject = null; el.remove(); delete audioEls.current[remoteId]; }
        delete pcs.current[remoteId];
        delete offerSent.current[remoteId];
        setPeers(p => { const n={...p}; delete n[remoteId]; return n; });
      }
    };

    return pc;
  }, []);

  /* ── Send offer — safe, idempotent ── */
  const sendOffer = useCallback(async (remoteId, remoteName) => {
    // Guard: only initiator sends, and only once per connection
    if (!isInitiator(remoteId)) return;
    if (offerSent.current[remoteId]) return;
    offerSent.current[remoteId] = true;

    const pc = makePeer(remoteId, remoteName);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await sendSignal(sessionRef.current, myIdRef.current, remoteId, "offer", pc.localDescription.toJSON());
    } catch(e) {
      offerSent.current[remoteId] = false; // allow retry
      console.warn("sendOffer failed:", e);
    }
  }, [makePeer]);

  /* ── Signal handler — stored in ref so poll always has latest ── */
  const handleSignal = useCallback(async (row) => {
    if (row.from_user === myIdRef.current) return;
    if (row.to_user !== myIdRef.current && row.to_user !== "all") return;

    const from = row.from_user;
    let payload;
    try { payload = JSON.parse(row.payload || "{}"); } catch { return; }

    // ── hello: peer announced they have mic on ──
    if (row.type === "hello") {
      setPeers(p => ({ ...p, [from]: { name: payload.name || from, state: "connecting" } }));
      if (localStream.current) {
        // Initiator sends offer; non-initiator just waits
        await sendOffer(from, payload.name);
      }
      return;
    }

    // ── offer: create answer ──
    if (row.type === "offer") {
      const pc = makePeer(from, payload.name);
      // Skip if already stable (duplicate offer)
      if (pc.signalingState === "stable" && pc.remoteDescription) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // Flush buffered ICE
        for (const c of (iceBuf.current[from] || [])) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
        }
        iceBuf.current[from] = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(sessionRef.current, myIdRef.current, from, "answer", pc.localDescription.toJSON());
      } catch(e) { console.warn("answer failed:", e); }
      return;
    }

    // ── answer: complete the offer/answer exchange ──
    if (row.type === "answer") {
      const pc = pcs.current[from];
      if (!pc || pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        for (const c of (iceBuf.current[from] || [])) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
        }
        iceBuf.current[from] = [];
      } catch(e) { console.warn("set answer failed:", e); }
      return;
    }

    // ── ice: add candidate (or buffer if remote desc not ready) ──
    if (row.type === "ice") {
      const pc = pcs.current[from];
      if (!pc) return;
      if (!pc.remoteDescription?.type) {
        iceBuf.current[from] = [...(iceBuf.current[from] || []), payload];
      } else {
        await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(()=>{});
      }
      return;
    }
  }, [makePeer, sendOffer]);

  // Always keep the ref pointing to the latest handleSignal
  handleSignalRef.current = handleSignal;

  /* ── Enable mic ── */
  const enableMic = useCallback(async (members = []) => {
    setAudioErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      localStream.current = stream;
      setMicOn(true);
      setMuted(false);

      const myName = members.find(m => m.user_id === myIdRef.current)?.display_name || myIdRef.current;

      // Use setInterval+dbGet instead of pollNew — dbGet has no created_at filter
      // so it catches ALL signals including ones sent before we started.
      // Track which signal IDs we've already processed to avoid duplicates.
      stopSig.current?.();
      const processedIds = new Set();
      // Seed with signals older than 60s so we don't replay ancient history
      const seedCutoff = new Date(Date.now() - 60000).toISOString();
      const seedRows = await dbGet(
        `evtol_webrtc_signals?session_id=eq.${sessionRef.current}&created_at=lt.${encodeURIComponent(seedCutoff)}&select=id`
      );
      seedRows.forEach(r => processedIds.add(r.id));

      const sigTimer = setInterval(async () => {
        const rows = await dbGet(
          `evtol_webrtc_signals?session_id=eq.${sessionRef.current}&order=created_at.asc&limit=100`
        );
        for (const row of rows) {
          if (processedIds.has(row.id)) continue;
          processedIds.add(row.id);
          handleSignalRef.current(row).catch(() => {});
        }
      }, 600);
      stopSig.current = () => clearInterval(sigTimer);

      // Small pause then announce — interval is already running so response will be caught
      await new Promise(r => setTimeout(r, 300));
      await sendSignal(sessionRef.current, myIdRef.current, "all", "hello", { name: myName }).catch(()=>{});

      // Proactively send offers to members who already have mic on
      for (const m of members.filter(m => m.user_id !== myIdRef.current)) {
        await sendOffer(m.user_id, m.display_name);
        await new Promise(r => setTimeout(r, 50));
      }

    } catch(e) {
      setAudioErr(
        e.name === "NotAllowedError" ? "❌ Mic blocked — click 🔒 in address bar → allow microphone → try again." :
        e.name === "NotFoundError"   ? "❌ No microphone found — connect one and try again." :
        "❌ Mic error: " + e.message
      );
    }
  }, [sendOffer]);

  const toggleMute = useCallback(() => {
    if (!localStream.current) return;
    const nowMuted = !muted;
    localStream.current.getAudioTracks().forEach(t => { t.enabled = !nowMuted; });
    setMuted(nowMuted);
  }, [muted]);

  const stopMic = useCallback(() => {
    localStream.current?.getTracks().forEach(t => t.stop());
    localStream.current = null;
    Object.values(pcs.current).forEach(pc => { try { pc.close(); } catch {} });
    pcs.current = {};
    iceBuf.current = {};
    offerSent.current = {};
    Object.values(audioEls.current).forEach(el => { try { el.srcObject = null; el.remove(); } catch {} });
    audioEls.current = {};
    stopSig.current?.();
    stopSig.current = null;
    setMicOn(false);
    setMuted(false);
    setPeers({});
  }, []);

  useEffect(() => () => stopMic(), [stopMic]);

  return { micOn, muted, audioErr, peers, enableMic, toggleMute, stopMic };
}

/* ══════════════════════════════════════════════════════
   SESSION / DESIGN API
   ══════════════════════════════════════════════════════ */
export async function publishDesign(userId, displayName, params, results) {
  const shareId = Math.random().toString(36).slice(2, 10);
  const id = crypto.randomUUID ? crypto.randomUUID() : shareId + Date.now();
  await dbPost("evtol_public_designs", {
    id, user_id: userId, share_id: shareId,
    name: `${displayName}'s Design — MTOW ${results.MTOW}kg`,
    params: JSON.stringify(params),
    results: JSON.stringify({ MTOW:results.MTOW, Etot:results.Etot, Phov:results.Phov,
      LDact:results.LDact, SM_vt:results.SM_vt, Wbat:results.Wbat, bWing:results.bWing }),
    display_name: displayName, is_public: true, view_count: 0,
    created_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
  const eff = (results.LDact * results.Etot) / results.MTOW;
  await dbPost("evtol_leaderboard", {
    id, design_id: id, share_id: shareId, user_id: userId, display_name: displayName,
    name: `${displayName}'s Design`, metric_ld: results.LDact, metric_mtow: results.MTOW,
    metric_payload: params.payload, metric_efficiency: +eff.toFixed(4),
    metric_etot: results.Etot, created_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
  return shareId;
}

export async function getPublicDesign(shareId) {
  try {
    const rows = await dbGet(`evtol_public_designs?share_id=eq.${shareId}&is_public=eq.true`);
    if (!rows?.length) return null;
    await dbPatch(`evtol_public_designs?share_id=eq.${shareId}`, { view_count: (rows[0].view_count||0)+1 });
    return rows[0];
  } catch { return null; }
}

export async function getLeaderboard() {
  try { return await dbGet("evtol_leaderboard?order=metric_ld.desc&limit=50"); }
  catch { return []; }
}

export async function createCollabSession(hostId, hostName, params) {
  const sid = Math.random().toString(36).slice(2, 12);
  await dbPost("evtol_collab_sessions", {
    session_id: sid, host_id: hostId, host_name: hostName,
    state_json: JSON.stringify(params),
    updated_by: hostId,
    updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
  return sid;
}

export async function getCollabSession(sid) {
  const rows = await dbGet(`evtol_collab_sessions?session_id=eq.${sid}`);
  return rows[0] || null;
}

export async function pushCollabState(sid, params, editorId) {
  try {
    await dbPatch(`evtol_collab_sessions?session_id=eq.${sid}`, {
      state_json: JSON.stringify(params),
      updated_by: editorId || "unknown",
      updated_at: new Date().toISOString(),
    });
  } catch {}
}

async function reqJoin(sid, uid, name) {
  const id = `${sid}_${uid}_${Date.now()}`;
  await dbPost("evtol_collab_requests", {
    id, session_id: sid, user_id: uid, display_name: name,
    status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
  return id;
}

async function replyReq(id, status) {
  await dbPatch(`evtol_collab_requests?id=eq.${id}`, { status, updated_at: new Date().toISOString() });
}

async function addMember(sid, uid, name, role) {
  await dbPost("evtol_collab_members", {
    id: `${sid}_${uid}`, session_id: sid, user_id: uid, display_name: name, role,
    joined_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
}

async function setMemberRole(sid, uid, role) {
  await dbPatch(`evtol_collab_members?session_id=eq.${sid}&user_id=eq.${uid}`, {
    role, updated_at: new Date().toISOString(),
  });
}

async function getMembers(sid) {
  return await dbGet(`evtol_collab_members?session_id=eq.${sid}&order=joined_at.asc`);
}

/* ══════════════════════════════════════════════════════
   SHARE BUTTON
   ══════════════════════════════════════════════════════ */
export function ShareDesignButton({ user, params, results, C }) {
  const [phase, setPhase] = useState("idle");
  const [shareId, setShareId] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const doShare = async () => {
    if (!user) { setErr("Sign in to share."); return; }
    setPhase("busy"); setErr("");
    try {
      const name = user.name || user.email?.split("@")[0] || "Anonymous";
      setShareId(await publishDesign(user.id, name, params, results));
      setPhase("done");
    } catch(e) { setErr("Share failed: " + e.message); setPhase("idle"); }
  };
  const url = `${location.origin}${location.pathname}?design=${shareId}`;
  const copy = () => navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(()=>setCopied(false), 2000); });

  return (
    <div style={{position:"relative",display:"inline-block"}}>
      <button onClick={doShare} disabled={phase==="busy"} type="button"
        style={{padding:"5px 14px",background:`${phase==="done"?C.green:C.purple}22`,
          border:`1px solid ${phase==="done"?C.green:C.purple}55`,borderRadius:4,
          color:phase==="done"?C.green:C.purple,fontSize:9,cursor:phase==="busy"?"wait":"pointer",
          fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        {!user&&"🔒 "}{phase==="busy"?"Sharing…":phase==="done"?"✓ Shared":"🔗 Share Design"}
      </button>
      {phase==="done" && (
        <div style={{position:"absolute",right:0,top:34,zIndex:999,background:C.panel,
          border:`1px solid ${C.green}44`,borderRadius:8,padding:"12px 14px",width:320,
          boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
          <div style={{fontSize:10,color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:8}}>✓ Published! Share this link:</div>
          <div style={{display:"flex",gap:6,background:C.bg,border:`1px solid ${C.border}`,borderRadius:5,padding:"5px 8px",marginBottom:8}}>
            <span style={{fontSize:9,color:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'DM Mono',monospace"}}>{url}</span>
            <button onClick={copy} type="button" style={{padding:"2px 8px",background:copied?`${C.green}22`:`${C.amber}22`,border:`1px solid ${copied?C.green:C.amber}55`,borderRadius:3,color:copied?C.green:C.amber,fontSize:9,cursor:"pointer"}}>
              {copied?"✓":"Copy"}
            </button>
          </div>
          <button onClick={()=>setPhase("idle")} type="button" style={{background:"none",border:"none",color:C.muted,fontSize:9,cursor:"pointer"}}>Close</button>
        </div>
      )}
      {err && <div style={{position:"absolute",right:0,top:34,zIndex:999,background:C.panel,border:`1px solid ${C.red}44`,borderRadius:6,padding:"8px 12px",fontSize:10,color:C.red,width:220,fontFamily:"'DM Mono',monospace"}}>
        {err} <button onClick={()=>setErr("")} type="button" style={{marginLeft:6,background:"none",border:"none",color:C.muted,cursor:"pointer"}}>✕</button>
      </div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   LEADERBOARD
   ══════════════════════════════════════════════════════ */
export function LeaderboardPanel({ C, onLoadDesign }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActive]= useState("ld");

  const tabs = [
    {k:"ld",  label:"Best L/D",       f:"metric_ld",         fmt:v=>v?.toFixed(2),       col:"#14b8a6",icon:"🏆",asc:false},
    {k:"mtow",label:"Lowest MTOW",    f:"metric_mtow",       fmt:v=>v?.toFixed(0)+" kg", col:"#f59e0b",icon:"⚖️",asc:true},
    {k:"eff", label:"Best Efficiency",f:"metric_efficiency", fmt:v=>v?.toFixed(3),       col:"#8b5cf6",icon:"⚡",asc:false},
    {k:"etot",label:"Lowest Energy",  f:"metric_etot",       fmt:v=>v?.toFixed(1)+" kWh",col:"#3b82f6",icon:"🔋",asc:true},
  ];
  useEffect(()=>{ setLoading(true); getLeaderboard().then(r=>{ setData(r); setLoading(false); }); },[]);
  const at = tabs.find(t=>t.k===activeTab);
  const sorted = [...data].sort((a,b)=>at.asc?(a[at.f]||0)-(b[at.f]||0):(b[at.f]||0)-(a[at.f]||0)).slice(0,10);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <div style={{background:`linear-gradient(135deg,${C.purple}18,${C.teal}18)`,border:`1px solid ${C.purple}33`,borderRadius:10,padding:"14px 18px"}}>
        <div style={{fontSize:9,color:C.muted,letterSpacing:"0.18em",fontFamily:"'DM Mono',monospace",marginBottom:4}}>COMMUNITY LEADERBOARD</div>
        <div style={{fontSize:16,fontWeight:800,color:C.text}}><span style={{color:C.purple}}>eVTOL</span> Design Rankings</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:4}}>{data.length} community designs</div>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.k} onClick={()=>setActive(t.k)} type="button"
            style={{padding:"6px 12px",borderRadius:6,fontSize:10,fontFamily:"'DM Mono',monospace",fontWeight:700,cursor:"pointer",
              background:activeTab===t.k?`${t.col}22`:"transparent",border:`1px solid ${activeTab===t.k?t.col+"66":C.border}`,color:activeTab===t.k?t.col:C.muted}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      {loading
        ? <div style={{textAlign:"center",padding:24,color:C.muted,fontFamily:"'DM Mono',monospace"}}>⏳ Loading…</div>
        : sorted.length===0
          ? <div style={{textAlign:"center",padding:24,color:C.muted,background:C.panel,borderRadius:8,border:`1px solid ${C.border}`,fontFamily:"'DM Mono',monospace"}}>No designs yet — be the first! 🚁</div>
          : (
            <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"36px 1fr 100px 66px 70px 50px",gap:6,padding:"7px 14px",background:C.bg,borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase"}}>
                {["#","Designer",at.label,"L/D","MTOW",""].map((h,i)=><span key={i}>{h}</span>)}
              </div>
              {sorted.map((row,i)=>(
                <div key={row.id||i} style={{display:"grid",gridTemplateColumns:"36px 1fr 100px 66px 70px 50px",gap:6,padding:"9px 14px",borderBottom:`1px solid ${C.border}22`,alignItems:"center",cursor:"pointer",background:i<3?`${at.col}08`:"transparent"}}
                  onMouseEnter={e=>e.currentTarget.style.background=`${at.col}14`}
                  onMouseLeave={e=>e.currentTarget.style.background=i<3?`${at.col}08`:"transparent"}
                  onClick={()=>onLoadDesign?.(row)}>
                  <span style={{textAlign:"center",fontSize:14}}>{["🥇","🥈","🥉"][i]||<span style={{fontSize:10,color:C.muted}}>{i+1}</span>}</span>
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{row.display_name||"Anon"}</div>
                    <div style={{fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{row.name?.slice(0,36)||"—"}</div>
                  </div>
                  <span style={{fontSize:11,fontWeight:700,color:at.col,fontFamily:"'DM Mono',monospace"}}>{at.fmt(row[at.f])}</span>
                  <span style={{fontSize:10,color:C.teal,fontFamily:"'DM Mono',monospace"}}>{row.metric_ld?.toFixed(2)||"—"}</span>
                  <span style={{fontSize:10,color:C.amber,fontFamily:"'DM Mono',monospace"}}>{row.metric_mtow?.toFixed(0)||"—"} kg</span>
                  <button type="button" onClick={e=>{e.stopPropagation();row.share_id&&window.open(`?design=${row.share_id}`,"_blank");}}
                    style={{padding:"2px 6px",background:`${C.teal}22`,border:`1px solid ${C.teal}44`,borderRadius:3,color:C.teal,fontSize:8,cursor:"pointer"}}>
                    View
                  </button>
                </div>
              ))}
            </div>
          )
      }
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   COLLABORATION PANEL v6
   ══════════════════════════════════════════════════════ */
export function CollabPanel({ user, params, onParamChange, C }) {
  const [sid,      setSid]      = useState("");
  const [joinId,   setJoinId]   = useState("");
  const [inSession,setIn]       = useState(false);
  const [isHost,   setHost]     = useState(false);
  const [role,     setRole]     = useState("viewer");
  const [members,  setMembers]  = useState([]);
  const [pending,  setPending]  = useState([]);
  const [log,      setLog]      = useState([]);
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState("");
  const [copied,   setCopied]   = useState(false);
  const [waiting,  setWaiting]  = useState(false);

  // Stable user ID
  const myId   = useRef(user?.id || ("anon_" + Math.random().toString(36).slice(2,10)));
  const myName = user?.name || user?.email?.split("@")[0] || "Anonymous";
  const sidRef = useRef(""); // ref copy so intervals always have latest sid

  const voice = useVoice(sid, myId.current);

  // Cleanup fns stored in a plain object (not state)
  const cleanups = useRef({});
  const lastPushAt = useRef(0);
  const pushDebounceRef = useRef(null);
  const lastSeenUpdatedAt = useRef(""); // track last state_json update we applied
  const roleRef = useRef("viewer"); // always-live mirror of role — avoids stale closure

  const addLog = useCallback(msg =>
    setLog(p => [{ msg, t: new Date().toLocaleTimeString(), id: Math.random() }, ...p].slice(0, 30))
  , []);

  // Syncs both roleRef (for effects) and role state (for UI)
  const setRoleBoth = useCallback((r) => { roleRef.current = r; setRole(r); }, []);

  // ── LOCAL EDIT TRACKING — record which keys we changed and when ──
  // This prevents remote updates from overwriting our own recent local edits
  const localEdits = useRef({});   // { paramKey: timestamp }
  const LOCAL_EDIT_TTL = 4000;     // ms — protect local edits for 4 seconds

  // Track which params changed vs previous render
  const prevParams = useRef(params);
  useEffect(() => {
    if (!inSession || roleRef.current !== "editor") {
      prevParams.current = params;
      return;
    }
    // Detect which keys actually changed this render
    const now = Date.now();
    let changed = false;
    Object.keys(params).forEach(k => {
      if (params[k] !== prevParams.current[k]) {
        localEdits.current[k] = now;   // mark this key as locally modified
        changed = true;
      }
    });
    prevParams.current = params;

    if (!changed) return;
    // Debounce push — wait 800ms after last change before pushing
    if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(() => {
      if (sidRef.current) {
        pushCollabState(sidRef.current, params, myId.current);
        lastPushAt.current = Date.now();
      }
    }, 800);
  }, [params, inSession]);

  // ── STATE SYNC — poll session row every 1.5s, apply when updated_at changed ──
  // Uses syncRow() which checks updated_at, not created_at
  const startStateSync = useCallback((sessionId) => {
    cleanups.current.state?.();
    cleanups.current.state = syncRow(
      `evtol_collab_sessions?session_id=eq.${sessionId}`,
      1500,
      (row) => {
        // Skip if this is our own push or same update we already applied
        if (row.updated_by === myId.current) return;
        if (row.updated_at === lastSeenUpdatedAt.current) return;
        lastSeenUpdatedAt.current = row.updated_at;
        try {
          const st = JSON.parse(row.state_json || "{}");
          const now = Date.now();
          let appliedCount = 0;
          Object.entries(st).forEach(([k, v]) => {
            // Skip keys we edited recently — protect local changes
            const editedAt = localEdits.current[k] || 0;
            if (now - editedAt < LOCAL_EDIT_TTL) return;  // skip — we own this key
            onParamChange(k)(v);
            appliedCount++;
          });
          // Expire old local edit timestamps
          Object.keys(localEdits.current).forEach(k => {
            if (now - localEdits.current[k] > LOCAL_EDIT_TTL) delete localEdits.current[k];
          });
          if (appliedCount > 0) addLog(`🔄 ${row.updated_by ? "Collaborator" : "Session"} updated ${appliedCount} param(s)`);
        } catch {}
      }
    );
  }, [onParamChange, addLog]);

  const startMemberSync = useCallback((sessionId) => {
    cleanups.current.members?.();
    const fetchAndApply = async () => {
      const mems = await getMembers(sessionId);
      if (!mems.length) return;
      setMembers(mems);
      // Update this user's own role if host promoted/demoted them
      const me = mems.find(m => m.user_id === myId.current);
      if (me && me.role !== roleRef.current) {
        setRoleBoth(me.role);
      }
    };
    fetchAndApply(); // immediate
    const timer = setInterval(fetchAndApply, 2000);
    cleanups.current.members = () => clearInterval(timer);
  }, [setRoleBoth]);

  const stopAll = useCallback(() => {
    Object.values(cleanups.current).forEach(fn => { try { fn?.(); } catch {} });
    cleanups.current = {};
  }, []);

  const leave = useCallback(() => {
    stopAll(); voice.stopMic();
    setIn(false); setHost(false); setSid(""); sidRef.current = "";
    setJoinId(""); setMembers([]); setPending([]); setLog([]);
    setWaiting(false); setRoleBoth("viewer");
    lastSeenUpdatedAt.current = "";
  }, [stopAll, voice]);

  // ── HOST: start session ──
  const hostSession = async () => {
    if (!user) { setErr("Sign in to host."); return; }
    setBusy(true); setErr("");
    try {
      const newSid = await createCollabSession(myId.current, myName, params);
      setSid(newSid); sidRef.current = newSid;
      setIn(true); setHost(true); setRoleBoth("editor");
      addLog("🏠 Session started. Share the session ID with collaborators.");

      // Poll for pending join requests (new rows — created_at filter is correct here)
      cleanups.current.reqPoll = pollNew(
        "evtol_collab_requests", `session_id=eq.${newSid}&status=eq.pending`,
        req => setPending(p => p.find(r => r.id === req.id) ? p : [...p, req]),
        2000
      );
      // Backup direct fetch every 3s
      const reqTimer = setInterval(async () => {
        const rows = await dbGet(`evtol_collab_requests?session_id=eq.${newSid}&status=eq.pending`);
        if (rows.length) setPending(p => {
          const newOnes = rows.filter(r => !p.find(x => x.id === r.id));
          return newOnes.length ? [...p, ...newOnes] : p;
        });
      }, 3000);
      cleanups.current.reqTimer = () => clearInterval(reqTimer);

      startStateSync(newSid);
      startMemberSync(newSid);
    } catch(e) { setErr("Failed: " + e.message); }
    setBusy(false);
  };

  // ── GUEST: send join request ──
  const sendJoinRequest = async () => {
    if (!joinId.trim()) { setErr("Enter a session ID."); return; }
    if (!user) { setErr("Sign in to join."); return; }
    setBusy(true); setErr("");
    try {
      const session = await getCollabSession(joinId.trim());
      if (!session) { setErr("Session not found — check the ID."); setBusy(false); return; }

      const reqId = await reqJoin(joinId.trim(), myId.current, myName);
      setSid(joinId.trim()); sidRef.current = joinId.trim();
      setWaiting(true);
      addLog("📤 Request sent — waiting for host approval…");

      // Poll the request row directly every 1.5s (status is updated via PATCH)
      const approvalTimer = setInterval(async () => {
        const rows = await dbGet(`evtol_collab_requests?id=eq.${reqId}`);
        const req = rows[0];
        if (!req) return;

        if (req.status === "approved") {
          clearInterval(approvalTimer);
          setWaiting(false);
          setIn(true);
          setHost(false);

          // Load role and members
          const mems = await getMembers(joinId.trim());
          const me = mems.find(m => m.user_id === myId.current);
          setRoleBoth(me?.role || "viewer");
          setMembers(mems);

          // Load current params
          const sess = await getCollabSession(joinId.trim());
          if (sess?.state_json) {
            try {
              const initSt = JSON.parse(sess.state_json);
              Object.entries(initSt).forEach(([k,v]) => onParamChange(k)(v));
              lastSeenUpdatedAt.current = sess.updated_at || "";
              // Clear local edits on fresh join — start clean
              localEdits.current = {};
            } catch {}
          }
          addLog("✅ Approved! You joined the session.");
          startStateSync(joinId.trim());
          startMemberSync(joinId.trim());

        } else if (req.status === "denied") {
          clearInterval(approvalTimer);
          setWaiting(false);
          setSid(""); sidRef.current = "";
          setErr("❌ Host denied your join request.");
        }
      }, 1500);
      cleanups.current.approvalTimer = () => clearInterval(approvalTimer);

    } catch(e) { setErr("Failed: " + e.message); }
    setBusy(false);
  };

  // ── HOST: approve or deny request ──
  const handleApproval = async (req, approved) => {
    try {
      await replyReq(req.id, approved ? "approved" : "denied");
      if (approved) {
        await addMember(sid, req.user_id, req.display_name, "viewer");
        getMembers(sid).then(setMembers);
        addLog(`✅ ${req.display_name} joined as Viewer`);
      } else {
        addLog(`❌ Denied ${req.display_name}`);
      }
      setPending(p => p.filter(r => r.id !== req.id));
    } catch(e) { setErr(e.message); }
  };

  // ── HOST: change a member's role ──
  const handleRoleChange = async (mem, newRole) => {
    try {
      await setMemberRole(sid, mem.user_id, newRole);
      setMembers(p => p.map(m => m.user_id === mem.user_id ? { ...m, role: newRole } : m));
      addLog(`🔑 ${mem.display_name} → ${newRole}`);
    } catch(e) { setErr(e.message); }
  };

  const copyLink = () =>
    navigator.clipboard.writeText(`${location.origin}${location.pathname}?session=${sid}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });

  const B = (col, active = false) => ({
    padding: "7px 16px", borderRadius: 6, border: `1px solid ${col}66`,
    background: active ? `${col}33` : `${col}18`, color: col,
    fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono',monospace", cursor: "pointer",
  });

  const connectedPeerIds = Object.keys(voice.peers).filter(id => voice.peers[id]?.state === "connected");

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>

      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${C.teal}18,${C.blue}18)`,border:`1px solid ${C.teal}33`,borderRadius:10,padding:"14px 18px"}}>
        <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:4}}>REAL-TIME COLLABORATION v6</div>
        <div style={{fontSize:16,fontWeight:800,color:C.text}}><span style={{color:C.teal}}>Live</span> Design Sessions</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:4,lineHeight:1.7}}>
          Host approval · Editor/Viewer roles · Bidirectional param sync · WebRTC voice<br/>
          <strong style={{color:C.amber}}>Session persists across tabs — click Leave to end.</strong>
        </div>
      </div>

      {/* ── Idle state ── */}
      {!inSession && !waiting && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{background:C.panel,border:`1px solid ${C.teal}33`,borderRadius:8,padding:"14px 16px"}}>
            <div style={{fontSize:10,fontWeight:700,color:C.teal,fontFamily:"'DM Mono',monospace",marginBottom:8}}>🏠 Host a Session</div>
            <div style={{fontSize:10,color:C.muted,lineHeight:1.6,fontFamily:"'DM Mono',monospace",marginBottom:12}}>
              Start a session. You approve joiners and can set them as Editor or Viewer.
              Editors can change design params — changes sync both ways in real-time.
            </div>
            <button onClick={hostSession} disabled={busy} type="button" style={B(C.teal)}>
              {busy ? "Starting…" : "Start Session →"}
            </button>
            {!user && <div style={{fontSize:9,color:C.amber,marginTop:6,fontFamily:"'DM Mono',monospace"}}>⚠ Sign in required</div>}
          </div>
          <div style={{background:C.panel,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"14px 16px"}}>
            <div style={{fontSize:10,fontWeight:700,color:C.blue,fontFamily:"'DM Mono',monospace",marginBottom:8}}>🔗 Join a Session</div>
            <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:8,lineHeight:1.6}}>
              Paste the session ID. The host sees a popup to Accept or Deny your request.
            </div>
            <input value={joinId} onChange={e=>setJoinId(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&sendJoinRequest()}
              placeholder="e.g. abc123xyz…"
              style={{width:"100%",boxSizing:"border-box",background:C.bg,border:`1px solid ${C.border}`,
                borderRadius:4,color:C.text,fontSize:11,padding:"7px 10px",
                fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:8}}/>
            <button onClick={sendJoinRequest} disabled={busy} type="button" style={B(C.blue)}>
              {busy ? "Requesting…" : "Send Join Request →"}
            </button>
            {!user && <div style={{fontSize:9,color:C.amber,marginTop:6,fontFamily:"'DM Mono',monospace"}}>⚠ Sign in required</div>}
          </div>
        </div>
      )}

      {/* ── Waiting for approval ── */}
      {waiting && (
        <div style={{background:C.panel,border:`1px solid ${C.amber}55`,borderRadius:8,padding:24,textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:8}}>⏳</div>
          <div style={{fontSize:13,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:6}}>
            Waiting for host approval…
          </div>
          <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:16,lineHeight:1.6}}>
            The host will see a popup notification. This page updates automatically when approved.
          </div>
          <button onClick={leave} type="button" style={B(C.red)}>Cancel Request</button>
        </div>
      )}

      {/* ── Active session ── */}
      {inSession && (
        <>
          {/* Status bar */}
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",background:`${C.green}11`,border:`1px solid ${C.green}44`,borderRadius:8,flexWrap:"wrap"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite",flexShrink:0}}/>
            <div style={{flex:1,minWidth:180}}>
              <div style={{fontSize:11,fontWeight:700,color:C.green,fontFamily:"'DM Mono',monospace"}}>
                {isHost ? "🏠 Hosting" : `👥 Joined as ${role}`}
              </div>
              <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2}}>
                ID: <strong style={{color:C.amber}}>{sid}</strong>
                {"  ·  "}{role==="editor"
                  ? "✏️ Editor — your changes sync to all participants"
                  : "👁 Viewer — params update when editors make changes"}
              </div>
            </div>
            {isHost && (
              <button onClick={copyLink} type="button" style={B(C.amber, copied)}>
                {copied ? "✓ Copied!" : "📋 Copy Session Link"}
              </button>
            )}
            <button onClick={leave} type="button" style={B(C.red)}>Leave Session</button>
          </div>

          {/* ── Pending join requests (host only) ── */}
          {isHost && pending.length > 0 && (
            <div style={{background:C.panel,border:`2px solid ${C.amber}`,borderRadius:8,padding:"14px 16px",boxShadow:`0 0 24px ${C.amber}33`}}>
              <div style={{fontSize:11,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:10}}>
                📩 {pending.length} join request{pending.length > 1 ? "s" : ""}
              </div>
              {pending.map(req => (
                <div key={req.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:C.bg,borderRadius:6,marginBottom:8,border:`1px solid ${C.border}`}}>
                  <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${C.teal},${C.blue})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#fff",flexShrink:0}}>
                    {(req.display_name||"?")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{req.display_name}</div>
                    <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace"}}>Wants to join your session</div>
                  </div>
                  <button onClick={()=>handleApproval(req,true)} type="button"
                    style={{padding:"7px 16px",background:`${C.green}22`,border:`1px solid ${C.green}66`,borderRadius:5,color:C.green,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                    ✓ Accept
                  </button>
                  <button onClick={()=>handleApproval(req,false)} type="button"
                    style={{padding:"7px 16px",background:`${C.red}11`,border:`1px solid ${C.red}33`,borderRadius:5,color:C.red,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                    ✕ Deny
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Members list */}
          {members.length > 0 && (
            <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
              <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>
                👥 Session Members ({members.length})
              </div>
              {members.map(mem => {
                const isVoiceOn = connectedPeerIds.includes(mem.user_id);
                return (
                  <div key={mem.id||mem.user_id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}22`}}>
                    <div style={{position:"relative",flexShrink:0}}>
                      <div style={{width:34,height:34,borderRadius:"50%",
                        background:`linear-gradient(135deg,${mem.role==="editor"?C.amber:C.blue}aa,${C.teal}aa)`,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        fontSize:14,fontWeight:800,color:"#fff",
                        boxShadow:isVoiceOn?`0 0 10px ${C.green}99`:"none"}}>
                        {(mem.display_name||"?")[0].toUpperCase()}
                      </div>
                      {isVoiceOn && <div style={{position:"absolute",bottom:-2,right:-2,width:11,height:11,borderRadius:"50%",background:C.green,border:`2px solid ${C.panel}`,animation:"pulse 1s infinite"}}/>}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{mem.display_name}</div>
                      <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:mem.role==="editor"?C.amber:C.muted}}>
                        {mem.role==="editor" ? "✏️ Editor" : "👁 Viewer"}
                        {isVoiceOn && <span style={{color:C.green,marginLeft:8}}>🎙 Voice on</span>}
                      </div>
                    </div>
                    {isHost && (
                      <button onClick={()=>handleRoleChange(mem, mem.role==="editor"?"viewer":"editor")} type="button"
                        style={{padding:"4px 12px",background:mem.role==="editor"?`${C.muted}18`:`${C.amber}18`,border:`1px solid ${mem.role==="editor"?C.muted:C.amber}55`,borderRadius:4,color:mem.role==="editor"?C.muted:C.amber,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                        {mem.role==="editor" ? "→ Viewer" : "→ Editor"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Voice Chat ── */}
          <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px"}}>
            <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12}}>
              🎙️ Voice Chat (WebRTC + TURN relay)
            </div>

            {!voice.micOn ? (
              <div>
                <button onClick={()=>voice.enableMic(members)} type="button"
                  style={{...B(C.teal),display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  🎙️ Enable Microphone
                </button>
                <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.8,background:C.bg,borderRadius:6,padding:"10px 12px",border:`1px solid ${C.border}`}}>
                  <strong style={{color:C.text}}>How voice works:</strong><br/>
                  1. <strong>Both</strong> people click "Enable Microphone"<br/>
                  2. Allow mic access when the browser asks<br/>
                  3. Connection establishes automatically (uses TURN relay if needed)<br/>
                  4. You will hear each other directly
                </div>
              </div>
            ) : (
              <div>
                <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
                  <button onClick={voice.toggleMute} type="button"
                    style={{...B(voice.muted?C.red:C.green,true),display:"flex",alignItems:"center",gap:8,minWidth:130}}>
                    {voice.muted ? "🔇 Unmute" : "🎙️ Mute"}
                  </button>
                  <button onClick={voice.stopMic} type="button" style={{...B(C.red),display:"flex",alignItems:"center",gap:6}}>
                    ⏹ Leave Voice
                  </button>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:voice.muted?C.red:C.green,animation:voice.muted?"none":"pulse 1s infinite"}}/>
                    <span style={{fontSize:11,fontWeight:700,color:voice.muted?C.red:C.green,fontFamily:"'DM Mono',monospace"}}>
                      {voice.muted ? "Muted" : "Transmitting"}
                    </span>
                  </div>
                </div>

                {connectedPeerIds.length > 0 ? (
                  <div style={{background:`${C.green}0e`,border:`1px solid ${C.green}33`,borderRadius:6,padding:"10px 14px"}}>
                    <div style={{fontSize:9,color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:6}}>
                      🔗 Voice connected with {connectedPeerIds.length} peer{connectedPeerIds.length>1?"s":""}
                    </div>
                    {connectedPeerIds.map(id => (
                      <div key={id} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0"}}>
                        <div style={{width:7,height:7,borderRadius:"50%",background:C.green,animation:"pulse 1s infinite"}}/>
                        <span style={{fontSize:11,color:C.text,fontFamily:"'DM Mono',monospace"}}>
                          {voice.peers[id]?.name || id}
                        </span>
                        <span style={{fontSize:9,color:C.green,fontFamily:"'DM Mono',monospace"}}>● live audio</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{background:`${C.amber}0e`,border:`1px solid ${C.amber}33`,borderRadius:6,padding:"10px 14px"}}>
                    <div style={{fontSize:10,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                      ⏳ Mic is on — waiting for the other person
                    </div>
                    <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.6}}>
                      Tell the other person to open the <strong style={{color:C.text}}>Collaboration tab</strong> and click <strong style={{color:C.teal}}>"Enable Microphone"</strong>.
                      Connection will establish automatically within a few seconds.
                    </div>
                  </div>
                )}
              </div>
            )}

            {voice.audioErr && (
              <div style={{marginTop:10,padding:"10px 14px",background:`${C.red}0e`,border:`1px solid ${C.red}44`,borderRadius:6,fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                {voice.audioErr}
              </div>
            )}
          </div>

          {/* Activity log */}
          <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px"}}>
            <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8}}>Activity</div>
            {log.length===0
              ? <div style={{fontSize:10,color:C.dim,fontFamily:"'DM Mono',monospace"}}>No activity yet…</div>
              : (
                <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:160,overflowY:"auto"}}>
                  {log.map(a => (
                    <div key={a.id} style={{display:"flex",gap:10,alignItems:"baseline"}}>
                      <span style={{fontSize:8,color:C.dim,fontFamily:"'DM Mono',monospace",flexShrink:0}}>{a.t}</span>
                      <span style={{fontSize:10,color:C.text,fontFamily:"'DM Mono',monospace"}}>{a.msg}</span>
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        </>
      )}

      {err && (
        <div style={{padding:"8px 14px",background:`${C.red}11`,border:`1px solid ${C.red}44`,borderRadius:6,fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace"}}>
          {err}
          <button onClick={()=>setErr("")} type="button" style={{marginLeft:10,background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:12}}>✕</button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   PUBLIC DESIGN BANNER
   ══════════════════════════════════════════════════════ */
export function PublicDesignBanner({ shareId, onLoad, C }) {
  const [design,  setDesign]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState("");
  const [gone,    setGone]    = useState(false);

  useEffect(() => {
    if (!shareId) { setLoading(false); return; }
    getPublicDesign(shareId).then(d => { d ? setDesign(d) : setErr("Design not found."); setLoading(false); });
  }, [shareId]);

  if (!shareId || gone) return null;
  if (loading) return (
    <div style={{padding:"10px 18px",background:`${C.blue}18`,border:`1px solid ${C.blue}44`,borderRadius:8,marginBottom:10,fontSize:10,color:C.blue,fontFamily:"'DM Mono',monospace"}}>
      ⏳ Loading shared design…
    </div>
  );
  if (err || !design) return (
    <div style={{padding:"10px 18px",background:`${C.red}11`,border:`1px solid ${C.red}33`,borderRadius:8,marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace"}}>❌ {err||"Failed to load design."}</span>
      <button onClick={()=>setGone(true)} type="button" style={{background:"none",border:"none",color:C.muted,cursor:"pointer"}}>✕</button>
    </div>
  );

  const res = JSON.parse(design.results || "{}");
  const prm = JSON.parse(design.params  || "{}");

  return (
    <div style={{padding:"12px 18px",background:`${C.teal}11`,border:`1px solid ${C.teal}44`,borderRadius:8,marginBottom:10,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
      <span style={{fontSize:18}}>🔗</span>
      <div style={{flex:1,minWidth:180}}>
        <div style={{fontSize:10,fontWeight:700,color:C.teal,fontFamily:"'DM Mono',monospace"}}>Shared by {design.display_name||"Anonymous"}</div>
        <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2}}>
          MTOW {res.MTOW} kg · L/D {res.LDact} · {res.Etot} kWh · {design.view_count} views
        </div>
      </div>
      <button onClick={()=>{ onLoad(prm); setGone(true); }} type="button"
        style={{padding:"7px 16px",background:`linear-gradient(135deg,${C.teal}33,${C.blue}33)`,border:`1px solid ${C.teal}66`,borderRadius:5,color:C.teal,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        Load & Explore →
      </button>
      <button onClick={()=>setGone(true)} type="button"
        style={{padding:"7px 10px",background:"none",border:`1px solid ${C.border}`,borderRadius:5,color:C.muted,fontSize:10,cursor:"pointer"}}>
        ✕
      </button>
    </div>
  );
}
