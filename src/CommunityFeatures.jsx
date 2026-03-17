/* ═══════════════════════════════════════════════════════════════════
   COMMUNITY FEATURES v5
   
   TAB-SWITCH FIX: CollabPanel is now rendered OUTSIDE the SR&&<> 
   block in App.jsx, so React never unmounts it on tab switch.
   
   AUDIO FIX: Complete WebRTC rewrite using "perfect negotiation"
   pattern (RFC 8829). Key fixes:
   - Polite/impolite peer roles prevent offer collision
   - ICE candidates queued until remote description ready
   - Audio elements attached to document.body (not React tree)
   - autoplay unlocked via user-gesture context
   - 500ms signal polling for low-latency handshake
   - Signals scoped to join-time (no stale signal confusion)
   ═══════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef, useCallback } from "react";

const SB_URL = "https://obribjypwwrbhsyjllua.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";

const hdrs = () => ({
  "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type": "application/json", "Prefer": "return=representation",
});

async function db(path, method = "GET", body = null) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers: hdrs(), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`DB ${r.status}: ${t.slice(0,120)}`);
  return t ? JSON.parse(t) : null;
}

/* Poll for NEW rows only (created after this call was made) */
function poll(table, filter, cb, ms = 1500) {
  let on = true;
  // Record "now" as baseline — only fetch rows newer than this
  let since = new Date().toISOString();
  const tick = async () => {
    if (!on) return;
    try {
      const enc = encodeURIComponent(since);
      const rows = await db(`${table}?${filter}&created_at=gt.${enc}&order=created_at.asc&limit=50`);
      if (rows?.length) {
        since = rows[rows.length - 1].created_at;
        rows.forEach(cb);
      }
    } catch {}
    if (on) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
  return () => { on = false; };
}

/* ── STUN servers (public, no auth needed) ── */
const ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
]};

async function sig(sessionId, from, to, type, data) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  await db("evtol_webrtc_signals", "POST", {
    id, session_id: sessionId, from_user: from, to_user: to,
    type, payload: JSON.stringify(data), created_at: new Date().toISOString(),
  });
}

/* ═══════════════════════════════════════════════════════════════
   WEBRTC HOOK — Perfect Negotiation Pattern (RFC 8829)
   "Polite" peer = the one who joined later (guest)
   "Impolite" peer = host
   ═══════════════════════════════════════════════════════════════ */
function useVoice(sessionId, myId, isPolite) {
  const [on, setOn]         = useState(false);
  const [muted, setMuted]   = useState(false);
  const [err, setErr]       = useState("");
  const [connected, setConnected] = useState({}); // peerId → name

  const stream    = useRef(null);
  const pcs       = useRef({});      // peerId → RTCPeerConnection
  const iceBuf    = useRef({});      // peerId → candidate[]
  const audioEls  = useRef({});      // peerId → <audio>
  const making    = useRef({});      // peerId → bool (mid-offer)
  const stopPoll  = useRef(null);

  /* Create/reuse a peer connection */
  const peer = useCallback((remoteId, remoteName) => {
    if (pcs.current[remoteId]) return pcs.current[remoteId];

    const pc = new RTCPeerConnection(ICE);
    pcs.current[remoteId] = pc;
    iceBuf.current[remoteId] = [];

    /* Attach local audio */
    stream.current?.getTracks().forEach(t => pc.addTrack(t, stream.current));

    /* Play remote audio */
    pc.ontrack = ({ streams: [s] }) => {
      if (!s) return;
      let el = audioEls.current[remoteId];
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        document.body.appendChild(el);
        audioEls.current[remoteId] = el;
      }
      el.srcObject = s;
      // Autoplay may be blocked — resume on next click
      el.play().catch(() => {
        const resume = () => { el.play().catch(()=>{}); };
        document.addEventListener("click", resume, { once: true });
        document.addEventListener("keydown", resume, { once: true });
      });
      setConnected(p => ({ ...p, [remoteId]: remoteName || remoteId }));
    };

    /* Send ICE over Supabase */
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sig(sessionId, myId, remoteId, "ice", candidate).catch(()=>{});
    };

    /* Perfect-negotiation: handle negotiationneeded */
    pc.onnegotiationneeded = async () => {
      try {
        making.current[remoteId] = true;
        await pc.setLocalDescription();
        await sig(sessionId, myId, remoteId, "offer", pc.localDescription);
      } catch(e) { console.warn("NN failed", e); }
      finally { making.current[remoteId] = false; }
    };

    pc.onconnectionstatechange = () => {
      if (["failed","closed","disconnected"].includes(pc.connectionState)) {
        const el = audioEls.current[remoteId];
        if (el) { el.srcObject = null; el.remove(); delete audioEls.current[remoteId]; }
        pc.close(); delete pcs.current[remoteId];
        setConnected(p => { const n={...p}; delete n[remoteId]; return n; });
      }
    };

    return pc;
  }, [sessionId, myId]);

  /* Handle incoming signal */
  const onSig = useCallback(async (row) => {
    if (row.to_user !== myId && row.to_user !== "all") return;
    if (row.from_user === myId) return;

    const from = row.from_user;
    let data;
    try { data = JSON.parse(row.payload); } catch { return; }

    /* Someone announced they joined — create connection */
    if (row.type === "hello") {
      if (stream.current) peer(from, data.name);
      setConnected(p => ({ ...p, [from]: { name: data.name, connected: false } }));
      return;
    }

    const pc = peer(from, data?.senderName || from);

    if (row.type === "offer") {
      /* Perfect negotiation: ignore colliding offer if we're impolite and also making */
      const collision = making.current[from] || pc.signalingState !== "stable";
      if (collision && !isPolite) return; // impolite: ignore
      // polite: rollback and accept
      try {
        await pc.setRemoteDescription(data);
        // Flush buffered ICE
        for (const c of (iceBuf.current[from] || [])) {
          await pc.addIceCandidate(c).catch(()=>{});
        }
        iceBuf.current[from] = [];
        await pc.setLocalDescription();
        await sig(sessionId, myId, from, "answer", pc.localDescription);
      } catch(e) { console.warn("offer handling failed", e); }
      return;
    }

    if (row.type === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(data);
        for (const c of (iceBuf.current[from] || [])) {
          await pc.addIceCandidate(c).catch(()=>{});
        }
        iceBuf.current[from] = [];
      } catch(e) { console.warn("answer handling failed", e); }
      return;
    }

    if (row.type === "ice") {
      if (!pc.remoteDescription) {
        iceBuf.current[from] = [...(iceBuf.current[from]||[]), data];
      } else {
        await pc.addIceCandidate(data).catch(()=>{});
      }
      return;
    }
  }, [myId, sessionId, isPolite, peer]);

  /* Enable mic */
  const enable = useCallback(async (members = []) => {
    setErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      stream.current = s;
      setOn(true); setMuted(false);

      /* Announce to session */
      const myName = members.find(m => m.user_id === myId)?.display_name || myId;
      await sig(sessionId, myId, "all", "hello", { name: myName }).catch(()=>{});

      /* Create connections to everyone already in session */
      members.filter(m => m.user_id !== myId).forEach(m => peer(m.user_id, m.display_name));

      /* Poll signals at 500ms */
      stopPoll.current?.();
      stopPoll.current = poll("evtol_webrtc_signals", `session_id=eq.${sessionId}`, onSig, 500);

    } catch(e) {
      setErr(
        e.name === "NotAllowedError" ? "❌ Microphone blocked — click the 🔒 in your address bar → allow microphone → try again." :
        e.name === "NotFoundError"   ? "❌ No microphone found. Connect a mic and try again." :
        "❌ " + e.message
      );
    }
  }, [sessionId, myId, peer, onSig]);

  const mute = useCallback(() => {
    stream.current?.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setMuted(m => !m);
  }, []);

  const disable = useCallback(() => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    Object.values(pcs.current).forEach(pc => pc.close());
    pcs.current = {}; iceBuf.current = {}; making.current = {};
    Object.values(audioEls.current).forEach(el => { el.srcObject = null; el.remove(); });
    audioEls.current = {};
    stopPoll.current?.(); stopPoll.current = null;
    setOn(false); setMuted(false); setConnected({});
  }, []);

  useEffect(() => () => disable(), [disable]);

  return { on, muted, err, connected, enable, mute, disable };
}

/* ═══════════════════════════════════════════════════════════════
   SESSION / DESIGN API
   ═══════════════════════════════════════════════════════════════ */
export async function publishDesign(userId, displayName, params, results) {
  const shareId = Math.random().toString(36).slice(2, 10);
  const id = crypto.randomUUID ? crypto.randomUUID() : shareId + "_" + Date.now();
  await db("evtol_public_designs", "POST", {
    id, user_id: userId, share_id: shareId,
    name: `${displayName}'s Design — MTOW ${results.MTOW}kg`,
    params: JSON.stringify(params),
    results: JSON.stringify({ MTOW:results.MTOW, Etot:results.Etot, Phov:results.Phov,
      LDact:results.LDact, SM_vt:results.SM_vt, Wbat:results.Wbat, bWing:results.bWing }),
    display_name: displayName, is_public: true, view_count: 0,
    created_at: new Date().toISOString(),
  });
  const eff = (results.LDact * results.Etot) / results.MTOW;
  await db("evtol_leaderboard", "POST", {
    id, design_id: id, share_id: shareId, user_id: userId, display_name: displayName,
    name: `${displayName}'s Design`, metric_ld: results.LDact, metric_mtow: results.MTOW,
    metric_payload: params.payload, metric_efficiency: +eff.toFixed(4),
    metric_etot: results.Etot, created_at: new Date().toISOString(),
  });
  return shareId;
}

export async function getPublicDesign(shareId) {
  try {
    const rows = await db(`evtol_public_designs?share_id=eq.${shareId}&is_public=eq.true`);
    if (!rows?.length) return null;
    await db(`evtol_public_designs?share_id=eq.${shareId}`, "PATCH", { view_count: (rows[0].view_count||0)+1 });
    return rows[0];
  } catch { return null; }
}

export async function getLeaderboard() {
  try { return await db("evtol_leaderboard?order=metric_ld.desc&limit=50") || []; }
  catch { return []; }
}

export async function createCollabSession(hostId, hostName, params) {
  const sid = Math.random().toString(36).slice(2, 12);
  await db("evtol_collab_sessions", "POST", {
    session_id: sid, host_id: hostId, host_name: hostName,
    state_json: JSON.stringify(params), updated_at: new Date().toISOString(),
  });
  return sid;
}

export async function getCollabSession(sid) {
  try { const r = await db(`evtol_collab_sessions?session_id=eq.${sid}`); return r?.[0]||null; }
  catch { return null; }
}

export async function pushCollabState(sid, params) {
  try { await db(`evtol_collab_sessions?session_id=eq.${sid}`, "PATCH",
    { state_json: JSON.stringify(params), updated_at: new Date().toISOString() }); }
  catch {}
}

async function reqJoin(sid, uid, name) {
  const id = `${sid}_${uid}_${Date.now()}`;
  await db("evtol_collab_requests", "POST", { id, session_id:sid, user_id:uid, display_name:name, status:"pending", created_at:new Date().toISOString(), updated_at:new Date().toISOString() });
  return id;
}
async function replyReq(id, status) { await db(`evtol_collab_requests?id=eq.${id}`, "PATCH", { status, updated_at:new Date().toISOString() }); }
async function addMember(sid, uid, name, role) { await db("evtol_collab_members", "POST", { id:`${sid}_${uid}`, session_id:sid, user_id:uid, display_name:name, role, joined_at:new Date().toISOString(), updated_at:new Date().toISOString() }); }
async function setRole(sid, uid, role) { await db(`evtol_collab_members?session_id=eq.${sid}&user_id=eq.${uid}`, "PATCH", { role, updated_at:new Date().toISOString() }); }
async function getMembers(sid) { try { return await db(`evtol_collab_members?session_id=eq.${sid}&order=joined_at.asc`) || []; } catch { return []; } }

/* ═══════════════════════════════════════════════════════════════
   SHARE BUTTON
   ═══════════════════════════════════════════════════════════════ */
export function ShareDesignButton({ user, params, results, C }) {
  const [state, setState] = useState("idle"); // idle | sharing | done
  const [shareId, setShareId] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const share = async () => {
    if (!user) { setErr("Sign in to share."); return; }
    setState("sharing"); setErr("");
    try {
      const name = user.name || user.email?.split("@")[0] || "Anonymous";
      setShareId(await publishDesign(user.id, name, params, results));
      setState("done");
    } catch(e) { setErr("Failed: "+e.message); setState("idle"); }
  };

  const url = `${location.origin}${location.pathname}?design=${shareId}`;
  const copy = () => navigator.clipboard.writeText(url).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); });

  if (state === "done") return (
    <div style={{position:"relative",display:"inline-block"}}>
      <div style={{position:"absolute",right:0,top:32,zIndex:999,background:C.panel,border:`1px solid ${C.green}44`,borderRadius:8,padding:"12px 14px",width:320,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
        <div style={{fontSize:10,color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:8}}>✓ Published!</div>
        <div style={{display:"flex",gap:6,background:C.bg,border:`1px solid ${C.border}`,borderRadius:5,padding:"5px 8px",marginBottom:8}}>
          <span style={{fontSize:9,color:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'DM Mono',monospace"}}>{url}</span>
          <button onClick={copy} type="button" style={{padding:"2px 8px",background:copied?`${C.green}22`:`${C.amber}22`,border:`1px solid ${copied?C.green:C.amber}55`,borderRadius:3,color:copied?C.green:C.amber,fontSize:9,cursor:"pointer"}}>
            {copied?"✓":"Copy"}
          </button>
        </div>
        <button onClick={()=>setState("idle")} type="button" style={{background:"none",border:"none",color:C.muted,fontSize:9,cursor:"pointer"}}>Close</button>
      </div>
      <button type="button" style={{padding:"5px 14px",background:`${C.green}22`,border:`1px solid ${C.green}55`,borderRadius:4,color:C.green,fontSize:9,fontFamily:"'DM Mono',monospace",fontWeight:700,cursor:"pointer"}}>✓ Shared</button>
    </div>
  );

  return (
    <div style={{position:"relative",display:"inline-block"}}>
      <button onClick={share} disabled={state==="sharing"} type="button"
        style={{padding:"5px 14px",background:`${C.purple}22`,border:`1px solid ${C.purple}55`,borderRadius:4,color:C.purple,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        {!user&&"🔒 "}{state==="sharing"?"Sharing...":"🔗 Share Design"}
      </button>
      {err&&<div style={{position:"absolute",right:0,top:32,zIndex:999,background:C.panel,border:`1px solid ${C.red}44`,borderRadius:6,padding:"8px 12px",fontSize:10,color:C.red,width:220,fontFamily:"'DM Mono',monospace"}}>
        {err} <button onClick={()=>setErr("")} type="button" style={{marginLeft:6,background:"none",border:"none",color:C.muted,cursor:"pointer"}}>✕</button>
      </div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LEADERBOARD
   ═══════════════════════════════════════════════════════════════ */
export function LeaderboardPanel({ C, onLoadDesign }) {
  const [data,setData]       = useState([]);
  const [loading,setLoading] = useState(true);
  const [activeTab,setActive]= useState("ld");

  const tabs=[
    {k:"ld",  label:"Best L/D",       f:"metric_ld",         fmt:v=>v?.toFixed(2),        col:"#14b8a6",icon:"🏆",asc:false},
    {k:"mtow",label:"Lowest MTOW",    f:"metric_mtow",       fmt:v=>v?.toFixed(0)+" kg",  col:"#f59e0b",icon:"⚖️",asc:true},
    {k:"eff", label:"Best Efficiency",f:"metric_efficiency", fmt:v=>v?.toFixed(3),        col:"#8b5cf6",icon:"⚡",asc:false},
    {k:"etot",label:"Lowest Energy",  f:"metric_etot",       fmt:v=>v?.toFixed(1)+" kWh", col:"#3b82f6",icon:"🔋",asc:true},
  ];
  useEffect(()=>{ setLoading(true); getLeaderboard().then(r=>{ setData(r); setLoading(false); }); },[]);
  const at = tabs.find(t=>t.k===activeTab);
  const rows = [...data].sort((a,b)=>at.asc?(a[at.f]||0)-(b[at.f]||0):(b[at.f]||0)-(a[at.f]||0)).slice(0,10);

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
              background:activeTab===t.k?`${t.col}22`:"transparent",
              border:`1px solid ${activeTab===t.k?t.col+"66":C.border}`,
              color:activeTab===t.k?t.col:C.muted}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      {loading ? <div style={{textAlign:"center",padding:24,color:C.muted,fontFamily:"'DM Mono',monospace"}}>⏳ Loading…</div>
      : rows.length===0 ? <div style={{textAlign:"center",padding:24,color:C.muted,background:C.panel,borderRadius:8,border:`1px solid ${C.border}`,fontFamily:"'DM Mono',monospace"}}>No designs yet — be the first! 🚁</div>
      : (
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"40px 1fr 100px 70px 70px 55px",gap:6,padding:"7px 14px",
            background:C.bg,borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase"}}>
            {["#","Designer",at.label,"L/D","MTOW",""].map((h,i)=><span key={i}>{h}</span>)}
          </div>
          {rows.map((row,i)=>(
            <div key={row.id||i} style={{display:"grid",gridTemplateColumns:"40px 1fr 100px 70px 70px 55px",gap:6,
              padding:"9px 14px",borderBottom:`1px solid ${C.border}22`,alignItems:"center",cursor:"pointer",
              background:i<3?`${at.col}08`:"transparent"}}
              onMouseEnter={e=>e.currentTarget.style.background=`${at.col}14`}
              onMouseLeave={e=>e.currentTarget.style.background=i<3?`${at.col}08`:"transparent"}
              onClick={()=>onLoadDesign?.(row)}>
              <span style={{textAlign:"center"}}>{["🥇","🥈","🥉"][i]||<span style={{fontSize:10,color:C.muted}}>{i+1}</span>}</span>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{row.display_name||"Anon"}</div>
                <div style={{fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{row.name?.slice(0,36)||"—"}</div>
              </div>
              <span style={{fontSize:11,fontWeight:700,color:at.col,fontFamily:"'DM Mono',monospace"}}>{at.fmt(row[at.f])}</span>
              <span style={{fontSize:10,color:C.teal,fontFamily:"'DM Mono',monospace"}}>{row.metric_ld?.toFixed(2)||"—"}</span>
              <span style={{fontSize:10,color:C.amber,fontFamily:"'DM Mono',monospace"}}>{row.metric_mtow?.toFixed(0)||"—"} kg</span>
              <button type="button" onClick={e=>{e.stopPropagation();row.share_id&&window.open(`?design=${row.share_id}`,"_blank");}}
                style={{padding:"2px 6px",background:`${C.teal}22`,border:`1px solid ${C.teal}44`,borderRadius:3,color:C.teal,fontSize:8,cursor:"pointer"}}>View</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   COLLABORATION PANEL v5
   ═══════════════════════════════════════════════════════════════ */
export function CollabPanel({ user, params, onParamChange, C }) {
  const [sid, setSid]           = useState("");
  const [joinId, setJoinId]     = useState("");
  const [inSession, setIn]      = useState(false);
  const [isHost, setHost]       = useState(false);
  const [role, setRole]         = useState("viewer");
  const [members, setMembers]   = useState([]);
  const [pending, setPending]   = useState([]);
  const [log, setLog]           = useState([]);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");
  const [copied, setCopied]     = useState(false);
  const [waiting, setWaiting]   = useState(false);

  // Stable user ID — persists across renders
  const myId = useRef(user?.id || ("anon_" + Math.random().toString(36).slice(2,10)));
  const myName = user?.name || user?.email?.split("@")[0] || "Anonymous";

  // isPolite = guest (joined later), impolite = host
  const voice = useVoice(sid, myId.current, !isHost);

  const polls = useRef({});
  const lastPush = useRef(0);

  const addLog = useCallback(msg =>
    setLog(p => [{ msg, t: new Date().toLocaleTimeString(), id: Math.random() }, ...p].slice(0,30))
  , []);

  /* Sync params as host-editor */
  useEffect(() => {
    if (!inSession || !isHost || role !== "editor") return;
    const now = Date.now();
    if (now - lastPush.current < 1500) return;
    lastPush.current = now;
    pushCollabState(sid, params);
  }, [params, inSession, isHost, sid, role]);

  const stopAll = () => { Object.values(polls.current).forEach(f=>f?.()); polls.current = {}; };

  const leave = () => {
    stopAll(); voice.disable();
    setIn(false); setHost(false); setSid(""); setJoinId("");
    setMembers([]); setPending([]); setLog([]);
    setWaiting(false); setRole("viewer");
  };

  /* ── Host ── */
  const host = async () => {
    if (!user) { setErr("Sign in to host."); return; }
    setBusy(true); setErr("");
    try {
      const newSid = await createCollabSession(myId.current, myName, params);
      setSid(newSid); setIn(true); setHost(true); setRole("editor");
      addLog("🏠 Session started. Share the ID above.");
      polls.current.req = poll("evtol_collab_requests", `session_id=eq.${newSid}&status=eq.pending`,
        req => setPending(p => p.find(r=>r.id===req.id) ? p : [...p, req]), 2000);
      polls.current.mem = poll("evtol_collab_members", `session_id=eq.${newSid}`,
        () => getMembers(newSid).then(setMembers), 4000);
    } catch(e) { setErr("Failed: "+e.message); }
    setBusy(false);
  };

  /* ── Join request ── */
  const join = async () => {
    if (!joinId.trim()) { setErr("Enter a session ID."); return; }
    if (!user) { setErr("Sign in to join."); return; }
    setBusy(true); setErr("");
    try {
      const session = await getCollabSession(joinId.trim());
      if (!session) { setErr("Session not found. Check the ID."); setBusy(false); return; }
      const reqId = await reqJoin(joinId.trim(), myId.current, myName);
      setSid(joinId.trim()); setWaiting(true);
      addLog("📤 Request sent — waiting for host approval…");

      polls.current.approval = poll("evtol_collab_requests", `id=eq.${reqId}`,
        async req => {
          if (req.status === "approved") {
            polls.current.approval?.(); delete polls.current.approval;
            setWaiting(false); setIn(true); setHost(false);
            const mems = await getMembers(joinId.trim());
            const me = mems.find(m => m.user_id === myId.current);
            setRole(me?.role || "viewer"); setMembers(mems);
            const s = await getCollabSession(joinId.trim());
            if (s?.state_json) {
              try { Object.entries(JSON.parse(s.state_json)).forEach(([k,v]) => onParamChange(k)(v)); } catch {}
            }
            addLog("✅ Approved! You are in the session.");
            polls.current.state = poll("evtol_collab_sessions", `session_id=eq.${joinId.trim()}`,
              row => { try { Object.entries(JSON.parse(row.state_json||"{}")).forEach(([k,v])=>onParamChange(k)(v)); addLog("🔄 Params updated"); } catch {} }, 2000);
            polls.current.mem = poll("evtol_collab_members", `session_id=eq.${joinId.trim()}`,
              () => getMembers(joinId.trim()).then(setMembers), 4000);
          } else if (req.status === "denied") {
            polls.current.approval?.(); delete polls.current.approval;
            setWaiting(false); setSid(""); setErr("❌ Host denied your request.");
          }
        }, 1500);
    } catch(e) { setErr("Failed: "+e.message); }
    setBusy(false);
  };

  const approve = async (req, yes) => {
    try {
      await replyReq(req.id, yes ? "approved" : "denied");
      if (yes) { await addMember(sid, req.user_id, req.display_name, "viewer"); getMembers(sid).then(setMembers); addLog(`✅ ${req.display_name} joined`); }
      else { addLog(`❌ Denied ${req.display_name}`); }
      setPending(p => p.filter(r=>r.id!==req.id));
    } catch(e) { setErr(e.message); }
  };

  const changeRole = async (mem, newRole) => {
    try {
      await setRole(sid, mem.user_id, newRole);
      setMembers(p => p.map(m => m.user_id===mem.user_id ? {...m,role:newRole} : m));
      addLog(`🔑 ${mem.display_name} → ${newRole}`);
    } catch(e) { setErr(e.message); }
  };

  const copyLink = () =>
    navigator.clipboard.writeText(`${location.origin}${location.pathname}?session=${sid}`)
      .then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); });

  const B = (col, active=false) => ({
    padding:"7px 16px", borderRadius:6, border:`1px solid ${col}66`,
    background: active ? `${col}33` : `${col}18`, color: col,
    fontSize:11, fontWeight:700, fontFamily:"'DM Mono',monospace", cursor:"pointer",
  });

  const connIds = Object.keys(voice.connected);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>

      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${C.teal}18,${C.blue}18)`,border:`1px solid ${C.teal}33`,borderRadius:10,padding:"14px 18px"}}>
        <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:4}}>REAL-TIME COLLABORATION v5</div>
        <div style={{fontSize:16,fontWeight:800,color:C.text}}><span style={{color:C.teal}}>Live</span> Design Sessions</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:4,lineHeight:1.6}}>
          Host approval · Editor/Viewer roles · WebRTC P2P voice chat<br/>
          <strong style={{color:C.amber}}>Session persists while you browse other tabs — click Leave to end.</strong>
        </div>
      </div>

      {/* ── Idle ── */}
      {!inSession && !waiting && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{background:C.panel,border:`1px solid ${C.teal}33`,borderRadius:8,padding:"14px 16px"}}>
            <div style={{fontSize:10,fontWeight:700,color:C.teal,fontFamily:"'DM Mono',monospace",marginBottom:8}}>🏠 Host a Session</div>
            <div style={{fontSize:10,color:C.muted,lineHeight:1.6,fontFamily:"'DM Mono',monospace",marginBottom:12}}>
              Start a live session. Others send a join request; you approve and set their role.
            </div>
            <button onClick={host} disabled={busy} type="button" style={B(C.teal)}>{busy?"Starting…":"Start Session →"}</button>
            {!user && <div style={{fontSize:9,color:C.amber,marginTop:6,fontFamily:"'DM Mono',monospace"}}>⚠ Sign in required</div>}
          </div>
          <div style={{background:C.panel,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"14px 16px"}}>
            <div style={{fontSize:10,fontWeight:700,color:C.blue,fontFamily:"'DM Mono',monospace",marginBottom:8}}>🔗 Join a Session</div>
            <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:8,lineHeight:1.6}}>
              Paste the session ID. The host receives a popup to accept or deny.
            </div>
            <input value={joinId} onChange={e=>setJoinId(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&join()}
              placeholder="e.g. abc123xyz"
              style={{width:"100%",boxSizing:"border-box",background:C.bg,border:`1px solid ${C.border}`,
                borderRadius:4,color:C.text,fontSize:11,padding:"7px 10px",
                fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:8}}/>
            <button onClick={join} disabled={busy} type="button" style={B(C.blue)}>{busy?"Requesting…":"Send Join Request →"}</button>
            {!user && <div style={{fontSize:9,color:C.amber,marginTop:6,fontFamily:"'DM Mono',monospace"}}>⚠ Sign in required</div>}
          </div>
        </div>
      )}

      {/* ── Waiting ── */}
      {waiting && (
        <div style={{background:C.panel,border:`1px solid ${C.amber}55`,borderRadius:8,padding:24,textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:8}}>⏳</div>
          <div style={{fontSize:13,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:6}}>Waiting for host approval…</div>
          <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:16,lineHeight:1.6}}>
            The host will see a popup. This page updates automatically when they accept.
          </div>
          <button onClick={leave} type="button" style={B(C.red)}>Cancel Request</button>
        </div>
      )}

      {/* ── Active session ── */}
      {inSession && (<>

        {/* Status bar */}
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",background:`${C.green}11`,border:`1px solid ${C.green}44`,borderRadius:8,flexWrap:"wrap"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite",flexShrink:0,display:"block"}}/>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:11,fontWeight:700,color:C.green,fontFamily:"'DM Mono',monospace"}}>
              {isHost ? "🏠 Hosting" : `👥 Joined as ${role}`}
            </div>
            <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2}}>
              Session ID: <strong style={{color:C.amber}}>{sid}</strong>
              {"  ·  "}{role==="editor"?"✏️ Editor (can change params)":"👁 Viewer (read-only)"}
            </div>
          </div>
          {isHost && <button onClick={copyLink} type="button" style={B(C.amber,copied)}>{copied?"✓ Copied!":"📋 Copy Link"}</button>}
          <button onClick={leave} type="button" style={B(C.red)}>Leave Session</button>
        </div>

        {/* Pending join requests — HOST ONLY */}
        {isHost && pending.length > 0 && (
          <div style={{background:C.panel,border:`2px solid ${C.amber}`,borderRadius:8,padding:"14px 16px",boxShadow:`0 0 24px ${C.amber}44`}}>
            <div style={{fontSize:11,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:10}}>
              📩 {pending.length} join request{pending.length>1?"s":""}
            </div>
            {pending.map(req=>(
              <div key={req.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:C.bg,borderRadius:6,marginBottom:8,border:`1px solid ${C.border}`}}>
                <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${C.teal},${C.blue})`,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:800,color:"#fff",flexShrink:0}}>
                  {(req.display_name||"?")[0].toUpperCase()}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{req.display_name}</div>
                  <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace"}}>Wants to join your session</div>
                </div>
                <button onClick={()=>approve(req,true)} type="button"
                  style={{padding:"7px 16px",background:`${C.green}22`,border:`1px solid ${C.green}66`,borderRadius:5,color:C.green,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                  ✓ Accept
                </button>
                <button onClick={()=>approve(req,false)} type="button"
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
              const hasVoice = connIds.includes(mem.user_id);
              return (
                <div key={mem.id||mem.user_id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}22`}}>
                  <div style={{position:"relative",flexShrink:0}}>
                    <div style={{width:34,height:34,borderRadius:"50%",
                      background:`linear-gradient(135deg,${mem.role==="editor"?C.amber:C.blue}99,${C.teal}99)`,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontSize:14,fontWeight:800,color:"#fff",
                      boxShadow:hasVoice?`0 0 10px ${C.green}88`:"none"}}>
                      {(mem.display_name||"?")[0].toUpperCase()}
                    </div>
                    {hasVoice && (
                      <div style={{position:"absolute",bottom:-2,right:-2,width:11,height:11,
                        borderRadius:"50%",background:C.green,border:`2px solid ${C.panel}`,animation:"pulse 1s infinite"}}/>
                    )}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{mem.display_name}</div>
                    <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:mem.role==="editor"?C.amber:C.muted}}>
                      {mem.role==="editor"?"✏️ Editor":"👁 Viewer"}
                      {hasVoice ? <span style={{color:C.green,marginLeft:8}}>🎙 Voice on</span> : ""}
                    </div>
                  </div>
                  {isHost && (
                    <button onClick={()=>changeRole(mem, mem.role==="editor"?"viewer":"editor")} type="button"
                      style={{padding:"4px 12px",background:mem.role==="editor"?`${C.muted}18`:`${C.amber}18`,
                        border:`1px solid ${mem.role==="editor"?C.muted:C.amber}55`,borderRadius:4,
                        color:mem.role==="editor"?C.muted:C.amber,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                      {mem.role==="editor"?"→ Viewer":"→ Editor"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Voice */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px"}}>
          <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12}}>
            🎙️ Voice Chat (WebRTC P2P)
          </div>

          {!voice.on ? (
            <div>
              <button onClick={()=>voice.enable(members)} type="button"
                style={{...B(C.teal),display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                🎙️ Enable Microphone
              </button>
              <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.8,background:C.bg,borderRadius:6,padding:"10px 12px",border:`1px solid ${C.border}`}}>
                <strong style={{color:C.text}}>How to use voice:</strong><br/>
                1. Both you and the other person click <strong style={{color:C.teal}}>"Enable Microphone"</strong><br/>
                2. Your browser asks for mic permission → click <strong style={{color:C.green}}>Allow</strong><br/>
                3. A direct peer-to-peer audio connection is established automatically<br/>
                4. You will hear each other with no server relay (WebRTC)
              </div>
            </div>
          ) : (
            <div>
              {/* Controls */}
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
                <button onClick={voice.mute} type="button"
                  style={{...B(voice.muted?C.red:C.green,true),display:"flex",alignItems:"center",gap:8,minWidth:130}}>
                  {voice.muted ? "🔇 Unmute" : "🎙️ Mute"}
                </button>
                <button onClick={voice.disable} type="button" style={{...B(C.red),display:"flex",alignItems:"center",gap:6}}>
                  ⏹ Leave Voice
                </button>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:10,height:10,borderRadius:"50%",
                    background:voice.muted?C.red:C.green,
                    animation:voice.muted?"none":"pulse 1s infinite"}}/>
                  <span style={{fontSize:11,fontWeight:700,color:voice.muted?C.red:C.green,fontFamily:"'DM Mono',monospace"}}>
                    {voice.muted?"Muted":"Transmitting"}
                  </span>
                </div>
              </div>

              {/* Connection status */}
              {connIds.length > 0 ? (
                <div style={{background:`${C.green}0e`,border:`1px solid ${C.green}33`,borderRadius:6,padding:"10px 14px"}}>
                  <div style={{fontSize:9,color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:6}}>
                    🔗 Voice connected with {connIds.length} peer{connIds.length>1?"s":""}
                  </div>
                  {connIds.map(id=>(
                    <div key={id} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0"}}>
                      <div style={{width:7,height:7,borderRadius:"50%",background:C.green,animation:"pulse 1s infinite"}}/>
                      <span style={{fontSize:11,color:C.text,fontFamily:"'DM Mono',monospace"}}>
                        {voice.connected[id]?.name || voice.connected[id] || id}
                      </span>
                      <span style={{fontSize:9,color:C.green,fontFamily:"'DM Mono',monospace"}}>● live audio</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{background:`${C.amber}0e`,border:`1px solid ${C.amber}33`,borderRadius:6,padding:"10px 14px"}}>
                  <div style={{fontSize:10,fontWeight:700,color:C.amber,fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                    ⏳ Mic is on — waiting for others
                  </div>
                  <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.6}}>
                    Tell the other person to open the <strong style={{color:C.text}}>Collaboration tab</strong> and click <strong style={{color:C.teal}}>"Enable Microphone"</strong>. The connection establishes automatically.
                  </div>
                </div>
              )}
            </div>
          )}

          {voice.err && (
            <div style={{marginTop:10,padding:"10px 14px",background:`${C.red}0e`,border:`1px solid ${C.red}44`,borderRadius:6,fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
              {voice.err}
            </div>
          )}
        </div>

        {/* Activity log */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8}}>Activity</div>
          {log.length===0 ? <div style={{fontSize:10,color:C.dim,fontFamily:"'DM Mono',monospace"}}>No activity yet…</div> : (
            <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:160,overflowY:"auto"}}>
              {log.map(a=>(
                <div key={a.id} style={{display:"flex",gap:10,alignItems:"baseline"}}>
                  <span style={{fontSize:8,color:C.dim,fontFamily:"'DM Mono',monospace",flexShrink:0}}>{a.t}</span>
                  <span style={{fontSize:10,color:C.text,fontFamily:"'DM Mono',monospace"}}>{a.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </>)}

      {err && (
        <div style={{padding:"8px 14px",background:`${C.red}11`,border:`1px solid ${C.red}44`,borderRadius:6,fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace"}}>
          {err}
          <button onClick={()=>setErr("")} type="button" style={{marginLeft:10,background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:12}}>✕</button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PUBLIC DESIGN BANNER
   ═══════════════════════════════════════════════════════════════ */
export function PublicDesignBanner({ shareId, onLoad, C }) {
  const [design, setDesign]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState("");
  const [gone, setGone]         = useState(false);

  useEffect(()=>{
    if (!shareId) { setLoading(false); return; }
    getPublicDesign(shareId).then(d => { d ? setDesign(d) : setErr("Design not found."); setLoading(false); });
  },[shareId]);

  if (!shareId || gone) return null;
  if (loading) return (
    <div style={{padding:"10px 18px",background:`${C.blue}18`,border:`1px solid ${C.blue}44`,borderRadius:8,marginBottom:10,fontSize:10,color:C.blue,fontFamily:"'DM Mono',monospace"}}>
      ⏳ Loading shared design…
    </div>
  );
  if (err) return (
    <div style={{padding:"10px 18px",background:`${C.red}11`,border:`1px solid ${C.red}33`,borderRadius:8,marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:10,color:C.red,fontFamily:"'DM Mono',monospace"}}>❌ {err}</span>
      <button onClick={()=>setGone(true)} type="button" style={{background:"none",border:"none",color:C.muted,cursor:"pointer"}}>✕</button>
    </div>
  );
  if (!design) return null;

  const res = JSON.parse(design.results||"{}");
  const prm = JSON.parse(design.params||"{}");

  return (
    <div style={{padding:"12px 18px",background:`${C.teal}11`,border:`1px solid ${C.teal}44`,borderRadius:8,marginBottom:10,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
      <span style={{fontSize:16}}>🔗</span>
      <div style={{flex:1,minWidth:180}}>
        <div style={{fontSize:10,fontWeight:700,color:C.teal,fontFamily:"'DM Mono',monospace"}}>
          Shared by {design.display_name||"Anonymous"}
        </div>
        <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2}}>
          MTOW {res.MTOW} kg · L/D {res.LDact} · {res.Etot} kWh · {design.view_count} views
        </div>
      </div>
      <button onClick={()=>{ onLoad(prm); setGone(true); }} type="button"
        style={{padding:"7px 16px",background:`linear-gradient(135deg,${C.teal}33,${C.blue}33)`,
          border:`1px solid ${C.teal}66`,borderRadius:5,color:C.teal,fontSize:10,
          cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        Load & Explore →
      </button>
      <button onClick={()=>setGone(true)} type="button"
        style={{padding:"7px 10px",background:"none",border:`1px solid ${C.border}`,borderRadius:5,color:C.muted,fontSize:10,cursor:"pointer"}}>
        ✕
      </button>
    </div>
  );
}
