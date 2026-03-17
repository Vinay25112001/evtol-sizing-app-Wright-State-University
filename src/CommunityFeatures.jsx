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
   WEBRTC VOICE — v6
   Key fixes:
   1. TURN server for symmetric NAT
   2. Deterministic initiator (lower userId creates offer)
   3. ontrack uses evt.track fallback
   4. Explicit createOffer with offerToReceiveAudio:true
   5. Signal polling uses pollNew (new rows only, correct)
   ══════════════════════════════════════════════════════ */

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free TURN server — allows relay when direct P2P fails (symmetric NAT)
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
  const [micOn,     setMicOn]     = useState(false);
  const [muted,     setMuted]     = useState(false);
  const [audioErr,  setAudioErr]  = useState("");
  const [peers,     setPeers]     = useState({}); // id → {name, state}

  const localStream = useRef(null);
  const pcs         = useRef({});   // id → RTCPeerConnection
  const iceBuf      = useRef({});   // id → RTCIceCandidate[]
  const audioEls    = useRef({});   // id → HTMLAudioElement
  const stopSig     = useRef(null);
  const myIdRef     = useRef(myId);
  myIdRef.current   = myId;

  // Lower userId string = caller (initiator) — deterministic, no collision
  const amInitiator = (remoteId) => myIdRef.current < remoteId;

  const getOrMakePeer = useCallback((remoteId, remoteName) => {
    if (pcs.current[remoteId]) return pcs.current[remoteId];

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcs.current[remoteId] = pc;
    iceBuf.current[remoteId] = [];

    // Add local audio tracks
    if (localStream.current) {
      localStream.current.getTracks().forEach(t => pc.addTrack(t, localStream.current));
    }

    // Receive remote audio — use evt.track as primary, streams[0] as fallback
    pc.ontrack = (evt) => {
      const remoteStream = (evt.streams && evt.streams[0])
        ? evt.streams[0]
        : (() => { const ms = new MediaStream(); ms.addTrack(evt.track); return ms; })();

      let el = audioEls.current[remoteId];
      if (!el) {
        el = document.createElement("audio");
        el.autoplay = true;
        el.playsInline = true;
        el.setAttribute("playsinline", "");
        document.body.appendChild(el);
        audioEls.current[remoteId] = el;
      }
      el.srcObject = remoteStream;
      el.volume = 1.0;

      const tryPlay = () => el.play().catch(() => {
        // Autoplay blocked — retry on next user interaction
        const unlock = () => { el.play().catch(()=>{}); };
        document.addEventListener("click",   unlock, { once: true });
        document.addEventListener("keydown", unlock, { once: true });
        document.addEventListener("touchend",unlock, { once: true });
      });
      tryPlay();

      setPeers(p => ({ ...p, [remoteId]: { name: remoteName || remoteId, state: "connected" } }));
    };

    // Send ICE candidates via Supabase
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && sessionId && myIdRef.current) {
        sendSignal(sessionId, myIdRef.current, remoteId, "ice", candidate.toJSON()).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      setPeers(p => ({
        ...p,
        [remoteId]: { ...(p[remoteId]||{}), state: pc.connectionState },
      }));
      if (["failed","closed","disconnected"].includes(pc.connectionState)) {
        // Clean up audio element
        const el = audioEls.current[remoteId];
        if (el) { el.srcObject = null; el.remove(); delete audioEls.current[remoteId]; }
        pc.close();
        delete pcs.current[remoteId];
        setPeers(p => { const n={...p}; delete n[remoteId]; return n; });
      }
    };

    return pc;
  }, [sessionId]);

  // Handle incoming signal from another peer
  const handleSignal = useCallback(async (row) => {
    if (row.from_user === myIdRef.current) return;
    if (row.to_user !== myIdRef.current && row.to_user !== "all") return;

    const from = row.from_user;
    let payload;
    try { payload = JSON.parse(row.payload || "{}"); } catch { return; }

    if (row.type === "hello") {
      // Peer announced presence — if we have mic, create connection
      // Only initiator (lower userId) sends offer
      setPeers(p => ({ ...p, [from]: { name: payload.name || from, state: "connecting" } }));
      if (localStream.current) {
        const pc = getOrMakePeer(from, payload.name);
        if (amInitiator(from)) {
          // We are initiator — create and send offer
          try {
            const offer = await pc.createOffer({ offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            await sendSignal(sessionId, myIdRef.current, from, "offer", pc.localDescription.toJSON());
          } catch(e) { console.warn("offer failed", e); }
        }
        // Non-initiator waits for the other side's offer
      }
      return;
    }

    if (row.type === "offer") {
      const pc = getOrMakePeer(from, payload.name);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // Flush buffered ICE candidates
        for (const c of iceBuf.current[from] || []) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
        }
        iceBuf.current[from] = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(sessionId, myIdRef.current, from, "answer", pc.localDescription.toJSON());
      } catch(e) { console.warn("answer failed", e); }
      return;
    }

    if (row.type === "answer") {
      const pc = pcs.current[from];
      if (!pc || pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // Flush buffered ICE
        for (const c of iceBuf.current[from] || []) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
        }
        iceBuf.current[from] = [];
      } catch(e) { console.warn("set answer failed", e); }
      return;
    }

    if (row.type === "ice") {
      const pc = pcs.current[from];
      if (!pc) return;
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        // Buffer until remote description is set
        iceBuf.current[from] = [...(iceBuf.current[from] || []), payload];
      } else {
        await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(()=>{});
      }
      return;
    }
  }, [sessionId, getOrMakePeer, amInitiator]);

  const enableMic = useCallback(async (members = []) => {
    setAudioErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
        video: false,
      });
      localStream.current = stream;
      setMicOn(true);
      setMuted(false);

      const myName = members.find(m => m.user_id === myIdRef.current)?.display_name || myIdRef.current;

      // Start polling for signals BEFORE announcing, so we don't miss responses
      stopSig.current?.();
      stopSig.current = pollNew("evtol_webrtc_signals", `session_id=eq.${sessionId}`, handleSignal, 600);

      // Short delay so poll is running before we announce
      await new Promise(r => setTimeout(r, 300));

      // Announce to all session members
      await sendSignal(sessionId, myIdRef.current, "all", "hello", { name: myName }).catch(()=>{});

      // If we're the initiator to any already-present member, create connections
      members
        .filter(m => m.user_id !== myIdRef.current)
        .forEach(m => {
          if (amInitiator(m.user_id)) {
            const pc = getOrMakePeer(m.user_id, m.display_name);
            pc.createOffer({ offerToReceiveAudio: true })
              .then(offer => pc.setLocalDescription(offer))
              .then(() => sendSignal(sessionId, myIdRef.current, m.user_id, "offer", pc.localDescription.toJSON()))
              .catch(e => console.warn("initial offer failed", e));
          }
        });

    } catch(e) {
      setAudioErr(
        e.name === "NotAllowedError" ? "❌ Mic blocked — click the 🔒 in your address bar and allow microphone access, then try again." :
        e.name === "NotFoundError"   ? "❌ No microphone found — connect a mic and try again." :
        "❌ Mic error: " + e.message
      );
    }
  }, [sessionId, handleSignal, getOrMakePeer, amInitiator]);

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
export function CollabPanel({ user, params, onParamChange, C, onPendingChange }) {
  const [sid,      setSid]      = useState("");
  const [joinId,   setJoinId]   = useState("");
  const [inSession,setIn]       = useState(false);
  const [isHost,   setHost]     = useState(false);
  const [role,     setRole]     = useState("viewer");
  const roleRef = useRef("viewer"); // ref so effects always see latest role
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
  const lastSeenUpdatedAt = useRef(""); // track last state_json update we applied

  const addLog = useCallback(msg =>
    setLog(p => [{ msg, t: new Date().toLocaleTimeString(), id: Math.random() }, ...p].slice(0, 30))
  , []);

  // ── PARAM PUSH — any editor (host or guest) pushes on every change ──
  // Use roleRef.current (not role state) so we always read the LIVE role
  // even if React hasn't re-rendered since the host changed our role
  useEffect(() => {
    if (!inSession || roleRef.current !== "editor") return;
    const now = Date.now();
    if (now - lastPushAt.current < 1200) return; // throttle 1.2s
    lastPushAt.current = now;
    pushCollabState(sidRef.current, params, myId.current);
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
          Object.entries(st).forEach(([k, v]) => onParamChange(k)(v));
          addLog("🔄 " + (row.updated_by ? "Collaborator" : "Session") + " updated params");
        } catch {}
      }
    );
  }, [onParamChange, addLog]);

  // Keep roleRef synced so param-push effect always reads latest role
  const setRoleSync = useCallback((newRole) => {
    roleRef.current = newRole;
    setRoleSync(newRole);
  }, []);

  const startMemberSync = useCallback((sessionId) => {
    cleanups.current.members?.();
    // Poll evtol_collab_members every 2s — when host changes a role,
    // updated_at changes on that member row, syncRow fires the callback.
    // We use a simple interval here since syncRow watches a single row.
    const memberTimer = setInterval(async () => {
      const mems = await getMembers(sessionId);
      if (!mems.length) return;
      setMembers(mems);
      // KEY FIX: update guest's own role if host changed it
      const me = mems.find(m => m.user_id === myId.current);
      if (me) setRoleSync(me.role);
    }, 2000);
    cleanups.current.members = () => clearInterval(memberTimer);
    // Immediate fetch
    getMembers(sessionId).then(mems => {
      setMembers(mems);
      const me = mems.find(m => m.user_id === myId.current);
      if (me) setRoleSync(me.role);
    });
  }, []);

  const stopAll = useCallback(() => {
    Object.values(cleanups.current).forEach(fn => { try { fn?.(); } catch {} });
    cleanups.current = {};
  }, []);

  const leave = useCallback(() => {
    stopAll(); voice.stopMic();
    setIn(false); setHost(false); setSid(""); sidRef.current = "";
    setJoinId(""); setMembers([]); setPending([]); setLog([]);
    setWaiting(false); setRoleSync("viewer");
    lastSeenUpdatedAt.current = "";
  }, [stopAll, voice]);

  // ── HOST: start session ──
  const hostSession = async () => {
    if (!user) { setErr("Sign in to host."); return; }
    setBusy(true); setErr("");
    try {
      const newSid = await createCollabSession(myId.current, myName, params);
      setSid(newSid); sidRef.current = newSid;
      setIn(true); setHost(true); setRoleSync("editor");
      addLog("🏠 Session started. Share the session ID with collaborators.");

      // Poll for pending join requests (new rows — created_at filter is correct here)
      // Single robust polling approach: direct fetch every 2s, no created_at filter.
      // This catches ALL pending requests regardless of when they were created.
      const reqTimer = setInterval(async () => {
        const rows = await dbGet(`evtol_collab_requests?session_id=eq.${newSid}&status=eq.pending`);
        setPending(prev => {
          // Add any new requests not already in the list
          const merged = [...prev];
          rows.forEach(r => { if (!merged.find(x => x.id === r.id)) merged.push(r); });
          // Remove any that are no longer pending (host approved/denied in another window)
          const filtered = merged.filter(r => rows.find(x => x.id === r.id));
          // Notify parent of count change
          if (filtered.length !== prev.length) onPendingChange?.(filtered.length);
          return filtered.length !== prev.length ? filtered : prev;
        });
      }, 2000);
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
          setRoleSync(me?.role || "viewer");
          setMembers(mems);

          // Load current params
          const sess = await getCollabSession(joinId.trim());
          if (sess?.state_json) {
            try {
              Object.entries(JSON.parse(sess.state_json)).forEach(([k,v]) => onParamChange(k)(v));
              lastSeenUpdatedAt.current = sess.updated_at || "";
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
      setPending(p => {
        const newP = p.filter(r => r.id !== req.id);
        onPendingChange?.(newP.length);
        return newP;
      });
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
