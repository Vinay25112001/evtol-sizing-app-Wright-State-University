import { useState, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════
   eVTOL SIZER — AUTH SYSTEM v3.0
   Register: firstName, lastName, mobile, email, password + OTP verify
   Login: email OR mobile OR username + password → OTP verify
   Forgot: enter email → OTP → reset password
   ═══════════════════════════════════════════════════════════════ */

/* ── Theme system — reads from App's global C if available, else dark fallback ── */
const DARK_C = {
  bg:"#07090f", panel:"#0d1117", border:"#1c2333",
  amber:"#f59e0b", teal:"#14b8a6", blue:"#3b82f6",
  red:"#ef4444", green:"#22c55e", dim:"#4b5563",
  text:"#e2e8f0", muted:"#64748b", purple:"#8b5cf6",
};
const LIGHT_C = {
  bg:"#f8fafc", panel:"#ffffff", border:"#e2e8f0",
  amber:"#d97706", teal:"#0d9488", blue:"#2563eb",
  red:"#dc2626", green:"#16a34a", dim:"#9ca3af",
  text:"#0f172a", muted:"#64748b", purple:"#7c3aed",
};
/* C is set by the exported setAuthTheme() or falls back to dark */
let C = DARK_C;
export function setAuthTheme(isDark){ C = isDark ? DARK_C : LIGHT_C; }

/* ── helpers ── */
const uid = () => Math.random().toString(36).slice(2,10);
const nowISO = () => new Date().toISOString();
const fmtTime = (iso) => {
  const d=new Date(iso), diff=(Date.now()-d)/1000;
  if(diff<60) return "just now";
  if(diff<3600) return `${Math.floor(diff/60)}m ago`;
  if(diff<86400) return `${Math.floor(diff/3600)}h ago`;
  return d.toLocaleDateString();
};

/* ── EmailJS ── */
const EJS_SERVICE  = "service_lr9esnm";
const EJS_TEMPLATE = "template_g6lhbyl";
const EJS_KEY      = "xdMM2-AaS1VGWJSaa";

async function sendOTPEmail(toEmail, otpCode) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      service_id:EJS_SERVICE, template_id:EJS_TEMPLATE, user_id:EJS_KEY,
      template_params:{ to_email:toEmail, otp_code:otpCode },
    }),
  });
  if(!res.ok){ const t=await res.text().catch(()=>""); throw new Error(`EmailJS ${res.status}: ${t}`); }
}

/* ── OTP store ── */
const otpStore = {};
function generateOTP(email) {
  const code = String(Math.floor(100000+Math.random()*900000));
  otpStore[email] = { code, expires: Date.now()+5*60*1000 };
  return code;
}
function verifyOTP(email, code) {
  const e=otpStore[email];
  if(!e||Date.now()>e.expires) return false;
  return /^\d{6}$/.test(code) && e.code===code;
}
function clearOTP(email){ delete otpStore[email]; }

/* ══════════════════════════════════════════════════════════════
   SUPABASE CLIENT — cross-device persistence
   Create a FREE project at https://supabase.com then:
   1. Replace SUPABASE_URL and SUPABASE_ANON_KEY below
   2. Run the SQL setup in your Supabase SQL editor (see README)
   ══════════════════════════════════════════════════════════════ */
const SUPABASE_URL  = "https://obribjypwwrbhsyjllua.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";

async function sbFetch(path, opts={}){
  const { prefer, headers:extraHeaders={}, body, method="GET" } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers:{
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": prefer||"return=representation",
      ...extraHeaders,
    },
    ...(body ? { body } : {}),
  });
  if(!res.ok){
    const t=await res.text().catch(()=>"");
    console.error(`Supabase error ${res.status} on ${method} ${path}:`, t);
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  const text=await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── User DB — Supabase table: evtol_users ── */
async function getUsers(){ try{ return await sbFetch("evtol_users?select=*"); }catch{ return []; } }

async function getUserByEmail(email){
  if(!email) return null;
  try{
    const rows=await sbFetch(`evtol_users?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=*`);
    console.log("getUserByEmail:", email, "→ found:", rows?.length, rows?.[0]?.email);
    return rows?.[0]||null;
  }catch(e){ console.error("getUserByEmail error:", e); return null; }
}

async function getUserByMobileOrUsername(identifier){
  try{
    const id=identifier.trim().toLowerCase();
    const rows=await sbFetch(`evtol_users?or=(mobile.eq.${encodeURIComponent(id)},username.eq.${encodeURIComponent(id)})&select=*`);
    return rows?.[0]||null;
  }catch(e){ console.error("getUserByMobileOrUsername error:", e); return null; }
}

async function upsertUser(u){
  try{
    // Only send columns that exist in Supabase (snake_case only)
    const clean={
      id:         u.id,
      email:      u.email?.toLowerCase(),
      first_name: u.first_name||u.firstName||"",
      last_name:  u.last_name||u.lastName||"",
      username:   u.username||"",
      mobile:     u.mobile||null,
      org:        u.org||null,
      pw_hash:    u.pw_hash||u.pwHash||"",
      provider:   u.provider||null,
      avatar:     u.avatar||"",
      created_at: u.created_at||u.createdAt||nowISO(),
    };
    const result=await sbFetch("evtol_users",{
      method:"POST",
      prefer:"resolution=merge-duplicates,return=representation",
      headers:{"Prefer":"resolution=merge-duplicates,return=representation"},
      body:JSON.stringify(clean),
    });
    console.log("upsertUser success:", clean.email, result);
    return result;
  }catch(e){ console.error("upsertUser error:",e); throw e; }
}

/* ── Session — still localStorage (per-device token) ── */
function getSession(){ try{return JSON.parse(localStorage.getItem("evtol_session")||"null");}catch{return null;} }
function saveSession(s){ localStorage.setItem("evtol_session",JSON.stringify(s)); }
function clearSession(){ localStorage.removeItem("evtol_session"); }

/* ── Find user (async, checks Supabase) ── */
async function findUser(identifier){
  const id=identifier.trim().toLowerCase();
  const byEmail=await getUserByEmail(id);
  if(byEmail) return byEmail;
  return getUserByMobileOrUsername(id);
}

/* ── Notifications — Supabase table: evtol_notifs ── */
async function getNotifs(userId){
  try{
    return await sbFetch(`evtol_notifs?user_id=eq.${userId}&order=time.desc&limit=50&select=*`)||[];
  }catch{ return []; }
}
async function saveNotifs(userId, notifs){
  // We save individually; this bulk approach replaces all notifs for user
  // For simplicity just use addNotif for new ones
}
async function addNotif(userId,{title,body,type="info"}){
  try{
    await sbFetch("evtol_notifs",{
      method:"POST",
      body:JSON.stringify({id:userId+"_"+Date.now(),user_id:userId,title,body,type,read:false,time:nowISO()}),
    });
  }catch(e){ console.warn("addNotif failed:",e); }
}
async function markNotifRead(notifId){
  try{ await sbFetch(`evtol_notifs?id=eq.${notifId}`,{method:"PATCH",body:JSON.stringify({read:true})}); }catch{}
}
async function deleteNotif(notifId){
  try{ await sbFetch(`evtol_notifs?id=eq.${notifId}`,{method:"DELETE"}); }catch{}
}

/* ── Designs DB — Supabase table: evtol_designs ── */
async function getDesigns(userId){
  try{
    return await sbFetch(`evtol_designs?user_id=eq.${userId}&order=saved_at.desc&limit=20&select=*`)||[];
  }catch{ return []; }
}
async function saveDesign(userId,{name,params,results,pdfHtml}){
  try{
    await sbFetch("evtol_designs",{
      method:"POST",
      body:JSON.stringify({id:uid(),user_id:userId,name,params:JSON.stringify(params),results:JSON.stringify(results),pdf_html:pdfHtml,saved_at:nowISO()}),
    });
  }catch(e){ console.error("saveDesign:",e); }
}
async function deleteDesign(designId){
  try{ await sbFetch(`evtol_designs?id=eq.${designId}`,{method:"DELETE"}); }catch{}
}

/* ── Report History — Supabase table: evtol_reports ── */
async function getReports(userId){
  try{
    return await sbFetch(`evtol_reports?user_id=eq.${userId}&order=generated_at.desc&limit=30&select=*`)||[];
  }catch{ return []; }
}
async function addReport(userId,{name,params,results,pdfHtml}){
  try{
    await sbFetch("evtol_reports",{
      method:"POST",
      body:JSON.stringify({id:uid(),user_id:userId,name,params:JSON.stringify(params),results:JSON.stringify(results),pdf_html:pdfHtml,generated_at:nowISO()}),
    });
  }catch(e){ console.error("addReport:",e); }
}
async function deleteReport(reportId){
  try{ await sbFetch(`evtol_reports?id=eq.${reportId}`,{method:"DELETE"}); }catch{}
}

/* ── Get full user from Supabase ── */
async function getFullUser(email){
  return getUserByEmail(email);
}

/* ── Fix session name — handle old/missing firstName/lastName ── */
function buildDisplayName(u){
  if(!u) return "User";
  const fn=u.first_name||u.firstName||"";
  const ln=u.last_name||u.lastName||"";
  const full=`${fn} ${ln}`.trim();
  if(full) return full;
  if(u.name&&u.name!=="undefined undefined") return u.name;
  return u.email?.split("@")[0]||"User";
}

/* ══════════════════════════════════════════════════════════════
   UI PRIMITIVES
   ══════════════════════════════════════════════════════════════ */
function Input({label,type="text",value,onChange,placeholder,autoFocus,error,hint}){
  const[show,setShow]=useState(false);
  const isP=type==="password";
  return(
    <div style={{marginBottom:14}}>
      {label&&<div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:5,letterSpacing:"0.08em",textTransform:"uppercase"}}>{label}</div>}
      <div style={{position:"relative"}}>
        <input
          type={isP&&show?"text":type} value={value}
          onChange={e=>onChange(e.target.value)}
          placeholder={placeholder} autoFocus={autoFocus}
          style={{width:"100%",boxSizing:"border-box",background:C.bg,
            border:`1px solid ${error?C.red:C.border}`,borderRadius:6,color:C.text,
            fontSize:13,padding:"10px 40px 10px 12px",fontFamily:"'DM Mono',monospace",outline:"none"}}
          onFocus={e=>e.target.style.borderColor=C.amber}
          onBlur={e=>e.target.style.borderColor=error?C.red:C.border}
        />
        {isP&&(
          <button onClick={()=>setShow(s=>!s)} type="button"
            style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
              background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:13,padding:2}}>
            {show?"🙈":"👁"}
          </button>
        )}
      </div>
      {error&&<div style={{fontSize:10,color:C.red,marginTop:4,fontFamily:"'DM Mono',monospace"}}>{error}</div>}
      {hint&&!error&&<div style={{fontSize:9,color:C.dim,marginTop:3,fontFamily:"'DM Mono',monospace"}}>{hint}</div>}
    </div>
  );
}

function Btn({children,onClick,variant="primary",loading,fullWidth,small}){
  const s={
    primary:{background:`linear-gradient(135deg,${C.amber},#f97316)`,color:"#07090f",border:"none"},
    secondary:{background:"transparent",color:C.text,border:`1px solid ${C.border}`},
    google:{background:"#fff",color:"#1f2937",border:"1px solid #d1d5db"},
    blue:{background:`linear-gradient(135deg,#1e3a5f,#1e40af)`,color:"#93c5fd",border:`1px solid ${C.blue}`},
    danger:{background:"transparent",color:C.red,border:`1px solid ${C.red}44`},
  };
  return(
    <button onClick={onClick} disabled={loading} type="button"
      style={{...s[variant],padding:small?"6px 14px":"10px 20px",borderRadius:6,
        fontSize:small?11:13,fontWeight:700,fontFamily:"'DM Mono',monospace",
        cursor:loading?"not-allowed":"pointer",width:fullWidth?"100%":"auto",
        letterSpacing:"0.04em",opacity:loading?0.6:1,
        display:"flex",alignItems:"center",justifyContent:"center",gap:6,transition:"transform 0.1s"}}
      onMouseEnter={e=>{if(!loading)e.currentTarget.style.transform="translateY(-1px)";}}
      onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";}}
    >
      {loading?<span style={{animation:"spin 0.7s linear infinite",display:"inline-block"}}>⏳</span>:children}
    </button>
  );
}

function Divider({text}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0"}}>
      <div style={{flex:1,height:1,background:C.border}}/>
      <span style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{text}</span>
      <div style={{flex:1,height:1,background:C.border}}/>
    </div>
  );
}

function Alert({type,children}){
  const cols={error:C.red,success:C.green,info:C.blue,warn:C.amber};
  const icons={error:"✗",success:"✓",info:"ℹ",warn:"⚠"};
  const col=cols[type]||C.muted;
  return(
    <div style={{background:`${col}11`,border:`1px solid ${col}44`,borderRadius:6,
      padding:"9px 12px",marginBottom:12,display:"flex",gap:8,alignItems:"flex-start"}}>
      <span style={{color:col,fontSize:12,flexShrink:0,marginTop:1}}>{icons[type]}</span>
      <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",lineHeight:1.5}}>{children}</span>
    </div>
  );
}

/* ── Password strength indicator ── */
function PasswordStrength({password}){
  if(!password) return null;
  const checks=[
    password.length>=8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score=checks.filter(Boolean).length;
  const labels=["","Weak","Fair","Good","Strong"];
  const colors=["","#ef4444","#f97316","#eab308","#22c55e"];
  return(
    <div style={{marginTop:-8,marginBottom:14}}>
      <div style={{display:"flex",gap:3,marginBottom:3}}>
        {[1,2,3,4].map(i=>(
          <div key={i} style={{flex:1,height:3,borderRadius:2,
            background:i<=score?colors[score]:C.border,transition:"background 0.2s"}}/>
        ))}
      </div>
      <div style={{fontSize:9,color:colors[score]||C.dim,fontFamily:"'DM Mono',monospace"}}>
        {score>0?`Password strength: ${labels[score]}`:""}
      </div>
    </div>
  );
}

/* ── 6-box OTP input ── */
function OTPInput({value,onChange}){
  const refs=useRef([]);
  const digits=(value||"").replace(/\D/g,"").split("").slice(0,6);
  while(digits.length<6) digits.push("");
  const handleChange=(i,v)=>{
    const d=v.replace(/\D/g,"").slice(-1);
    const arr=[...digits]; arr[i]=d;
    onChange(arr.join(""));
    if(d&&i<5) refs.current[i+1]?.focus();
  };
  const handleKey=(i,e)=>{
    if(e.key==="Backspace"&&!digits[i]&&i>0){
      const arr=[...digits]; arr[i-1]="";
      onChange(arr.join(""));
      refs.current[i-1]?.focus();
    }
    if(e.key==="ArrowLeft"&&i>0) refs.current[i-1]?.focus();
    if(e.key==="ArrowRight"&&i<5) refs.current[i+1]?.focus();
  };
  const handlePaste=(e)=>{
    const p=e.clipboardData.getData("text").replace(/\D/g,"").slice(0,6);
    if(p){ onChange(p); refs.current[Math.min(p.length,5)]?.focus(); }
    e.preventDefault();
  };
  return(
    <div style={{display:"flex",gap:8,justifyContent:"center",margin:"20px 0"}}>
      {[0,1,2,3,4,5].map(i=>(
        <input key={i} ref={el=>refs.current[i]=el}
          type="text" inputMode="numeric" maxLength={1}
          value={digits[i]}
          onChange={e=>handleChange(i,e.target.value)}
          onKeyDown={e=>handleKey(i,e)}
          onPaste={handlePaste}
          style={{width:46,height:54,textAlign:"center",fontSize:24,fontWeight:700,
            fontFamily:"'DM Mono',monospace",background:C.panel,
            border:`2px solid ${digits[i]?C.amber:C.border}`,
            borderRadius:8,color:C.amber,outline:"none"}}
          onFocus={e=>e.target.style.borderColor=C.amber}
          onBlur={e=>e.target.style.borderColor=digits[i]?C.amber:C.border}
        />
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   OTP SCREEN — mandatory after every credential check
   ══════════════════════════════════════════════════════════════ */
function OTPScreen({email, onVerified, onBack, title="Verify Your Email"}){
  const[otp,setOtp]=useState("");
  const[loading,setLoading]=useState(false);
  const[sending,setSending]=useState(true);
  const[err,setErr]=useState("");
  const[info,setInfo]=useState("");
  const[timer,setTimer]=useState(0);
  const timerRef=useRef(null);

  const startTimer=()=>{
    setTimer(60);
    clearInterval(timerRef.current);
    timerRef.current=setInterval(()=>{
      setTimer(t=>{ if(t<=1){clearInterval(timerRef.current);return 0;} return t-1; });
    },1000);
  };

  useEffect(()=>{ sendCode(); return()=>clearInterval(timerRef.current); },[]);

  const sendCode=async()=>{
    setErr(""); setInfo(""); setSending(true); setOtp("");
    try{
      const code=generateOTP(email);
      await sendOTPEmail(email,code);
      startTimer();
      setInfo(`6-digit code sent to ${email}`);
    }catch(e){
      setErr("Failed to send OTP: "+e.message);
    }
    setSending(false);
  };

  const handleVerify=async()=>{
    setErr("");
    const clean=otp.replace(/\D/g,"");
    if(clean.length!==6) return setErr("Enter all 6 digits.");
    setLoading(true);
    await new Promise(r=>setTimeout(r,400));
    if(!verifyOTP(email,clean)){
      setLoading(false); setOtp("");
      return setErr("Wrong or expired code. Try again or request a new one.");
    }
    clearOTP(email);
    setLoading(false);
    onVerified();
  };

  return(
    <div>
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:10}}>📧</div>
        <div style={{fontSize:15,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{title}</div>
        <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:6,lineHeight:1.8}}>
          We sent a 6-digit code to<br/>
          <span style={{color:C.amber,fontWeight:700}}>{email}</span>
        </div>
      </div>
      {err&&<Alert type="error">{err}</Alert>}
      {info&&!err&&<Alert type="success">{info}</Alert>}
      {sending?(
        <div style={{textAlign:"center",padding:"20px 0",color:C.muted,fontSize:12,fontFamily:"'DM Mono',monospace"}}>
          <span style={{animation:"spin 0.7s linear infinite",display:"inline-block",marginRight:6}}>⏳</span>Sending code...
        </div>
      ):(
        <>
          <OTPInput value={otp} onChange={setOtp}/>
          <Btn variant="primary" fullWidth onClick={handleVerify} loading={loading}>Verify & Continue →</Btn>
          <div style={{textAlign:"center",marginTop:12,fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace"}}>
            {timer>0?<span>Resend in {timer}s</span>:(
              <button onClick={sendCode} type="button"
                style={{background:"none",border:"none",color:C.amber,cursor:"pointer",fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:700,padding:0}}>
                Resend code
              </button>
            )}
          </div>
          <div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace",textAlign:"center",marginTop:8,lineHeight:1.6}}>
            Check spam/junk folder if not in inbox. Code expires in 5 minutes.
          </div>
        </>
      )}
      <div style={{textAlign:"center",marginTop:16}}>
        <button onClick={onBack} type="button"
          style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",padding:0}}>
          ← Back
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   RESET PASSWORD SCREEN — after OTP verified for forgot password
   ══════════════════════════════════════════════════════════════ */
function ResetPasswordScreen({email, onDone}){
  const[pw,setPw]=useState("");
  const[pw2,setPw2]=useState("");
  const[err,setErr]=useState("");
  const[loading,setLoading]=useState(false);

  const handleReset=async()=>{
    setErr("");
    if(pw.length<8) return setErr("Password must be at least 8 characters.");
    if(pw!==pw2) return setErr("Passwords do not match.");
    setLoading(true);
    try{
      const u=await getUserByEmail(email.toLowerCase());
      if(!u){ setLoading(false); return setErr("Account not found."); }
      await upsertUser({...u, pw_hash:btoa(pw), pwHash:btoa(pw)});
      setLoading(false);
      addNotif(u.id,{title:"Password Reset",body:"Your password has been reset successfully.",type:"success"});
      onDone();
    }catch(e){
      setLoading(false);
      setErr("Failed to reset password — check connection. "+e.message);
    }
  };

  return(
    <div>
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:36,marginBottom:10}}>🔑</div>
        <div style={{fontSize:15,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>Set New Password</div>
        <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:6}}>for {email}</div>
      </div>
      {err&&<Alert type="error">{err}</Alert>}
      <Input label="New Password" type="password" value={pw} onChange={setPw} placeholder="Min. 8 characters" autoFocus/>
      <PasswordStrength password={pw}/>
      <Input label="Confirm New Password" type="password" value={pw2} onChange={setPw2} placeholder="Repeat password"/>
      <Btn variant="primary" fullWidth onClick={handleReset} loading={loading}>Save New Password →</Btn>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AUTH MODAL
   ══════════════════════════════════════════════════════════════ */
function AuthModal({onClose, onAuth, defaultFlow="login"}){
  // stage: "creds" | "otp" | "reset_otp" | "reset_pw" | "success"
  const[stage,setStage]=useState("creds");
  const[flow,setFlow]=useState(defaultFlow);
  const[dbStatus,setDbStatus]=useState("checking"); // "checking"|"ok"|"error"

  // Test Supabase connection on mount
  useEffect(()=>{
    sbFetch("evtol_users?limit=1&select=id")
      .then(()=>setDbStatus("ok"))
      .catch(e=>{ console.error("DB connection test failed:",e); setDbStatus("error"); });
  },[]);

  // Register fields
  const[firstName,setFirstName]=useState("");
  const[lastName,setLastName]=useState("");
  const[mobile,setMobile]=useState("");
  const[regEmail,setRegEmail]=useState("");
  const[regPw,setRegPw]=useState("");
  const[regPw2,setRegPw2]=useState("");
  const[org,setOrg]=useState("");

  // Login fields
  const[loginId,setLoginId]=useState(""); // email or mobile or username
  const[loginPw,setLoginPw]=useState("");
  const[loginPwErr,setLoginPwErr]=useState("");

  // Google
  const[googleEmail,setGoogleEmail]=useState("");
  const[showGoogleInput,setShowGoogleInput]=useState(false);

  // Forgot
  const[forgotEmail,setForgotEmail]=useState("");

  // Org
  const[orgName,setOrgName]=useState("");
  const[orgCode,setOrgCode]=useState("");

  const[loading,setLoading]=useState(false);
  const[err,setErr]=useState("");

  // pending user — set after creds verified, before OTP
  const pendingUser=useRef(null);
  // email to use for OTP (could differ from login identifier)
  const otpEmail=useRef("");

  const reset=()=>{ setErr(""); setLoginPwErr(""); };
  const switchFlow=(f)=>{ reset(); setFlow(f); setStage("creds"); };

  /* ── after OTP verified → complete login ── */
  const handleOTPVerified=()=>{
    const u=pendingUser.current;
    if(!u) return;
    const fn=u.first_name||u.firstName||"";
    const ln=u.last_name||u.lastName||"";
    const displayName=buildDisplayName({firstName:fn,lastName:ln,email:u.email});
    const session={
      id:u.id, name:displayName,
      firstName:fn, lastName:ln,
      email:u.email, mobile:u.mobile||null, org:u.org||null,
      avatar:displayName[0].toUpperCase(), token:uid()
    };
    saveSession(session);
    addNotif(u.id,{title:"Login Successful",body:`Welcome back, ${fn||displayName}! OTP verified.`,type:"success"});
    onAuth(session);
  };

  const proceedToOTP=(user,emailForOTP)=>{
    pendingUser.current=user;
    otpEmail.current=emailForOTP||user.email;
    setStage("otp");
  };

  /* ── REGISTER ── */
  const handleRegister=async()=>{
    reset();
    if(!firstName.trim()) return setErr("First name is required.");
    if(!lastName.trim()) return setErr("Last name is required.");
    if(!regEmail.includes("@")) return setErr("Enter a valid email address.");
    if(mobile && !/^\+?[\d\s\-]{7,15}$/.test(mobile)) return setErr("Enter a valid mobile number.");
    if(regPw.length<8) return setErr("Password must be at least 8 characters.");
    if(regPw!==regPw2) return setErr("Passwords do not match.");
    setLoading(true);
    try{
      const emailKey=regEmail.trim().toLowerCase();
      const existing=await getUserByEmail(emailKey);
      if(existing){ setLoading(false); return setErr("An account with this email already exists. Please log in."); }
      const username=`${firstName.toLowerCase()}${lastName.toLowerCase()}`.replace(/\s/g,"");
      const u={
        id:uid(),
        first_name:firstName.trim(), last_name:lastName.trim(),
        // keep camelCase only for in-memory session use — NOT sent to Supabase
        firstName:firstName.trim(), lastName:lastName.trim(),
        email:emailKey, mobile:mobile.trim()||null,
        username, org:org.trim()||null,
        pw_hash:btoa(regPw),
        created_at:nowISO(),
        avatar:firstName[0].toUpperCase(),
      };
      await upsertUser(u);
      setLoading(false);
      addNotif(u.id,{title:"Welcome to eVTOL Sizer!",body:`Hi ${u.firstName}, your account is ready.`,type:"success"});
      proceedToOTP(u,emailKey);
    }catch(e){
      setLoading(false);
      setErr("Registration failed — check your connection and try again. "+e.message);
    }
  };

  /* ── LOGIN ── */
  const handleLogin=async()=>{
    reset();
    if(!loginId.trim()) return setErr("Enter your email, mobile, or username.");
    if(!loginPw) return setErr("Password is required.");
    setLoading(true);
    try{
      const u=await findUser(loginId.trim());
      if(!u){
        setLoading(false);
        return setErr("No account found with that email, mobile, or username.");
      }
      const storedHash=u.pw_hash||u.pwHash||"";
      if(storedHash!==btoa(loginPw)){
        setLoading(false);
        setLoginPwErr("Wrong password. Please try again.");
        return;
      }
      setLoading(false);
      proceedToOTP(u,u.email);
    }catch(e){
      setLoading(false);
      setErr("Login failed — check your connection. "+e.message);
    }
  };

  /* ── GOOGLE ── */
  const handleGoogle=async()=>{
    reset();
    if(!googleEmail.trim()) return setErr("Enter your Gmail address.");
    if(!googleEmail.includes("@")) return setErr("Enter a valid email.");
    setLoading(true);
    try{
      const gEmail=googleEmail.trim().toLowerCase();
      let u=await getUserByEmail(gEmail);
      if(!u){
        const nameParts=gEmail.split("@")[0].replace(/[._]/g," ").split(" ");
        u={id:uid(),
          first_name:nameParts[0]||"", last_name:nameParts[1]||"",
          firstName:nameParts[0]||"", lastName:nameParts[1]||"",
          email:gEmail, mobile:null, username:gEmail.split("@")[0], org:null,
          pw_hash:"", provider:"google",
          created_at:nowISO(), avatar:(nameParts[0]||"G")[0].toUpperCase()};
        await upsertUser(u);
      }
      setLoading(false);
      proceedToOTP(u,gEmail);
    }catch(e){
      setLoading(false);
      setErr("Google sign-in failed — check your connection. "+e.message);
    }
  };

  /* ── FORGOT PASSWORD ── */
  const handleForgotSend=async()=>{
    reset();
    if(!forgotEmail.includes("@")) return setErr("Enter your registered email.");
    setLoading(true);
    try{
      const u=await getUserByEmail(forgotEmail.trim().toLowerCase());
      if(!u){ setLoading(false); return setErr("No account found with that email."); }
      setLoading(false);
      otpEmail.current=forgotEmail.trim().toLowerCase();
      pendingUser.current=u;
      setStage("reset_otp");
    }catch(e){
      setLoading(false);
      setErr("Could not reach server — check your connection. "+e.message);
    }
  };

  /* ── ORG SSO ── */
  const handleOrg=async()=>{
    reset();
    if(!orgName.trim()) return setErr("Enter your organization name.");
    if(!orgCode.trim()) return setErr("Enter your SSO access code.");
    setLoading(true);
    try{
      if(orgCode.toUpperCase()!=="WSU2025"){ setLoading(false); return setErr("Invalid SSO code. (Demo: use WSU2025)"); }
      const name=orgName.trim();
      const mockEmail=`user@${name.toLowerCase().replace(/\s+/g,"")}.edu`;
      let u=await getUserByEmail(mockEmail);
      if(!u){
        u={id:uid(), first_name:"SSO", last_name:"User",
          firstName:"SSO", lastName:"User",
          email:mockEmail, mobile:null,
          username:`sso_${name.toLowerCase().replace(/\s/g,"")}`, org:name,
          pw_hash:"", created_at:nowISO(), avatar:name[0].toUpperCase()};
        await upsertUser(u);
      }
      setLoading(false);
      proceedToOTP(u,mockEmail);
    }catch(e){
      setLoading(false);
      setErr("SSO failed — check your connection. "+e.message);
    }
  };

  const GoogleSVG=()=>(
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );

  const stageTitles={
    creds:{login:"Sign In",register:"Create Account",forgot:"Forgot Password",org:"Organization Login"},
    otp:"Verify OTP", reset_otp:"Verify Your Email", reset_pw:"Reset Password",
  };

  const getTitle=()=>{
    if(stage==="otp") return "Verify OTP";
    if(stage==="reset_otp") return "Verify Your Email";
    if(stage==="reset_pw") return "Reset Password";
    return stageTitles.creds[flow]||"Sign In";
  };

  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(7,9,15,0.88)",
      backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,
        padding:"28px 32px",width:440,maxWidth:"92vw",maxHeight:"92vh",overflowY:"auto",
        boxShadow:`0 0 60px ${C.amber}18`,animation:"slideUp 0.25s ease"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:22}}>
          <div>
            <div style={{fontSize:8,color:C.muted,letterSpacing:"0.2em",fontFamily:"'DM Mono',monospace",marginBottom:4}}>AEROSPACE DESIGN SUITE</div>
            <div style={{fontSize:19,fontWeight:800,letterSpacing:"-0.03em"}}>
              <span style={{color:C.amber}}>eVTOL</span>
              <span style={{color:C.text}}> — {getTitle()}</span>
            </div>
          </div>
          <button onClick={onClose} type="button"
            style={{background:"none",border:"none",color:C.muted,fontSize:20,cursor:"pointer",padding:4,lineHeight:1}}>✕</button>
        </div>

        {/* DB Connection Status */}
        <div style={{marginBottom:14,padding:"7px 12px",borderRadius:6,fontSize:10,fontFamily:"'DM Mono',monospace",
          background:dbStatus==="ok"?`${C.green}15`:dbStatus==="error"?`${C.red}15`:`${C.amber}15`,
          border:`1px solid ${dbStatus==="ok"?C.green:dbStatus==="error"?C.red:C.amber}44`,
          color:dbStatus==="ok"?C.green:dbStatus==="error"?C.red:C.amber,
          display:"flex",alignItems:"center",gap:8}}>
          {dbStatus==="checking"&&<span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span>}
          {dbStatus==="ok"&&"✅"}
          {dbStatus==="error"&&"❌"}
          {dbStatus==="checking"&&" Connecting to database..."}
          {dbStatus==="ok"&&" Cloud database connected — accounts sync across all devices"}
          {dbStatus==="error"&&" Database unreachable — check your internet connection"}
        </div>

        {/* ── OTP VERIFY (after login/register/google/org) ── */}
        {stage==="otp"&&(
          <OTPScreen email={otpEmail.current} onVerified={handleOTPVerified}
            onBack={()=>{ setStage("creds"); setErr(""); }}
            title="Verify Your Identity"/>
        )}

        {/* ── OTP VERIFY (for forgot password) ── */}
        {stage==="reset_otp"&&(
          <OTPScreen email={otpEmail.current}
            onVerified={()=>setStage("reset_pw")}
            onBack={()=>{ setStage("creds"); setFlow("forgot"); setErr(""); }}
            title="Verify to Reset Password"/>
        )}

        {/* ── RESET PASSWORD ── */}
        {stage==="reset_pw"&&(
          <ResetPasswordScreen email={otpEmail.current}
            onDone={()=>{
              setStage("creds"); setFlow("login");
              setErr("");
              // show success
              setTimeout(()=>setErr("✓ Password reset! Please sign in with your new password."),100);
            }}/>
        )}

        {/* ── CREDENTIALS STAGE ── */}
        {stage==="creds"&&(
          <>
            {err&&<Alert type={err.startsWith("✓")?"success":"error"}>{err}</Alert>}

            {/* ════ LOGIN ════ */}
            {flow==="login"&&(
              <>
                {showGoogleInput?(
                  <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:14}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <GoogleSVG/>
                      <span style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>Continue with Google</span>
                      <button onClick={()=>{setShowGoogleInput(false);reset();}} type="button"
                        style={{marginLeft:"auto",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:0}}>✕</button>
                    </div>
                    <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:8}}>OTP will be sent to this email to verify.</div>
                    <Input value={googleEmail} onChange={setGoogleEmail} placeholder="yourname@gmail.com" autoFocus type="email"/>
                    <Btn variant="google" fullWidth onClick={handleGoogle} loading={loading}>Send OTP & Continue →</Btn>
                  </div>
                ):(
                  <Btn variant="google" fullWidth onClick={()=>{reset();setShowGoogleInput(true);}}>
                    <GoogleSVG/> Continue with Google
                  </Btn>
                )}
                <Divider text="or sign in with credentials"/>
                <Input label="Email / Mobile / Username" value={loginId} onChange={v=>{setLoginId(v);setLoginPwErr("");}}
                  placeholder="email, +1234567890, or username" autoFocus={!showGoogleInput}
                  hint="You can sign in with your email, mobile number, or username"/>
                <Input label="Password" type="password" value={loginPw} onChange={v=>{setLoginPw(v);setLoginPwErr("");}}
                  placeholder="••••••••" error={loginPwErr}/>
                <div style={{display:"flex",justifyContent:"flex-end",marginTop:-8,marginBottom:14}}>
                  <button onClick={()=>switchFlow("forgot")} type="button"
                    style={{background:"none",border:"none",color:C.amber,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace",padding:0,fontWeight:700}}>
                    Forgot password?
                  </button>
                </div>
                <Btn variant="primary" fullWidth onClick={handleLogin} loading={loading}>Sign In & Verify OTP →</Btn>
                <Divider text="other options"/>
                <div style={{display:"flex",gap:8}}>
                  <Btn variant="secondary" fullWidth onClick={()=>switchFlow("org")}>🏢 Org / SSO</Btn>
                </div>
                <div style={{textAlign:"center",marginTop:16,fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace"}}>
                  No account?{" "}
                  <button onClick={()=>switchFlow("register")} type="button"
                    style={{background:"none",border:"none",color:C.amber,cursor:"pointer",fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:700,padding:0}}>
                    Create one →
                  </button>
                </div>
              </>
            )}

            {/* ════ REGISTER ════ */}
            {flow==="register"&&(
              <>
                {showGoogleInput?(
                  <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:14}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <GoogleSVG/>
                      <span style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>Sign up with Google</span>
                      <button onClick={()=>{setShowGoogleInput(false);reset();}} type="button"
                        style={{marginLeft:"auto",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:0}}>✕</button>
                    </div>
                    <Input value={googleEmail} onChange={setGoogleEmail} placeholder="yourname@gmail.com" autoFocus type="email"/>
                    <Btn variant="google" fullWidth onClick={handleGoogle} loading={loading}>Send OTP to Gmail →</Btn>
                  </div>
                ):(
                  <Btn variant="google" fullWidth onClick={()=>{reset();setShowGoogleInput(true);}}>
                    <GoogleSVG/> Sign up with Google
                  </Btn>
                )}
                <Divider text="or create with email"/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <Input label="First Name" value={firstName} onChange={setFirstName} placeholder="Jane" autoFocus/>
                  <Input label="Last Name" value={lastName} onChange={setLastName} placeholder="Smith"/>
                </div>
                <Input label="Email Address" type="email" value={regEmail} onChange={setRegEmail} placeholder="jane@example.com"/>
                <Input label="Mobile Number (optional)" value={mobile} onChange={setMobile} placeholder="+1 234 567 8900"
                  hint="Used for login — include country code"/>
                <Input label="Organization (optional)" value={org} onChange={setOrg} placeholder="Wright State University"/>
                <Input label="Password" type="password" value={regPw} onChange={setRegPw} placeholder="Min. 8 characters"/>
                <PasswordStrength password={regPw}/>
                <Input label="Confirm Password" type="password" value={regPw2} onChange={setRegPw2} placeholder="Repeat password"/>
                <div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace",marginBottom:14,lineHeight:1.7,
                  background:C.bg,padding:"8px 10px",borderRadius:6,border:`1px solid ${C.border}`}}>
                  Your username will be auto-generated as: <span style={{color:C.amber}}>
                    {firstName&&lastName?`${firstName.toLowerCase()}${lastName.toLowerCase()}`.replace(/\s/g,""):"firstnamelastname"}
                  </span>
                </div>
                <div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace",marginBottom:14,lineHeight:1.6}}>
                  By creating an account you agree to our Terms of Service and Privacy Policy. An OTP will be sent to verify your email.
                </div>
                <Btn variant="primary" fullWidth onClick={handleRegister} loading={loading}>Create Account & Verify Email →</Btn>
                <div style={{textAlign:"center",marginTop:16,fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace"}}>
                  Already have one?{" "}
                  <button onClick={()=>switchFlow("login")} type="button"
                    style={{background:"none",border:"none",color:C.amber,cursor:"pointer",fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:700,padding:0}}>
                    Sign in →
                  </button>
                </div>
              </>
            )}

            {/* ════ FORGOT PASSWORD ════ */}
            {flow==="forgot"&&(
              <>
                <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:16,lineHeight:1.7}}>
                  Enter your registered email. We'll send an OTP to verify your identity before letting you set a new password.
                </div>
                <Input label="Registered Email" type="email" value={forgotEmail} onChange={setForgotEmail}
                  placeholder="jane@example.com" autoFocus/>
                <Btn variant="primary" fullWidth onClick={handleForgotSend} loading={loading}>Send Verification Code →</Btn>
                <div style={{textAlign:"center",marginTop:16}}>
                  <button onClick={()=>switchFlow("login")} type="button"
                    style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                    ← Back to login
                  </button>
                </div>
              </>
            )}

            {/* ════ ORG / SSO ════ */}
            {flow==="org"&&(
              <>
                <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:16,lineHeight:1.7}}>
                  Sign in via your institution's SSO portal. OTP verification is still required.
                </div>
                <Input label="Organization / Institution" value={orgName} onChange={setOrgName}
                  placeholder="Wright State University" autoFocus/>
                <Input label="SSO Access Code" value={orgCode} onChange={setOrgCode} placeholder="e.g. WSU2025"/>
                <div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace",marginBottom:14}}>
                  Demo SSO code: <span style={{color:C.amber}}>WSU2025</span>
                </div>
                <Btn variant="blue" fullWidth onClick={handleOrg} loading={loading}>🏢 Authenticate & Send OTP →</Btn>
                <Divider text="supported providers"/>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center",marginBottom:8}}>
                  {["Okta","Azure AD","Google Workspace","Shibboleth","SAML 2.0"].map(p=>(
                    <span key={p} style={{fontSize:9,color:C.muted,background:"#111827",border:`1px solid ${C.border}`,
                      borderRadius:4,padding:"3px 8px",fontFamily:"'DM Mono',monospace"}}>{p}</span>
                  ))}
                </div>
                <div style={{textAlign:"center",marginTop:16}}>
                  <button onClick={()=>switchFlow("login")} type="button"
                    style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                    ← Back to login
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATION CENTER
   ══════════════════════════════════════════════════════════════ */
function NotifCenter({user,onClose}){
  const[notifs,setNotifs]=useState([]);
  useEffect(()=>{ getNotifs(user.id).then(n=>setNotifs(n||[])).catch(()=>{}); },[user.id]);
  const markAll=async()=>{
    const updated=notifs.map(n=>({...n,read:true}));
    setNotifs(updated);
    await Promise.all(updated.filter(n=>!n.read).map(n=>markNotifRead(n.id)));
  };
  const markOne=async(id)=>{
    setNotifs(prev=>prev.map(n=>n.id===id?{...n,read:true}:n));
    await markNotifRead(id);
  };
  const del=async(id)=>{
    setNotifs(prev=>prev.filter(n=>n.id!==id));
    await deleteNotif(id);
  };
  const icons={info:"ℹ️",success:"✅",warn:"⚠️",error:"❌"};
  const unread=notifs.filter(n=>!n.read).length;
  return(
    <div style={{position:"absolute",top:"100%",right:0,zIndex:200,marginTop:8,
      background:C.panel,border:`1px solid ${C.border}`,borderRadius:10,
      width:340,maxHeight:440,display:"flex",flexDirection:"column",
      boxShadow:"0 8px 40px rgba(0,0,0,0.6)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"12px 14px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:13,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>Notifications</span>
          {unread>0&&<span style={{background:C.red,color:"#fff",fontSize:9,borderRadius:10,padding:"2px 6px",fontWeight:700}}>{unread}</span>}
        </div>
        <div style={{display:"flex",gap:6}}>
          {unread>0&&<button onClick={markAll} type="button"
            style={{background:"none",border:"none",color:C.muted,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
            Mark all read
          </button>}
          <button onClick={onClose} type="button"
            style={{background:"none",border:"none",color:C.muted,fontSize:16,cursor:"pointer",lineHeight:1,padding:0}}>✕</button>
        </div>
      </div>
      <div style={{overflowY:"auto",flex:1}}>
        {notifs.length===0?(
          <div style={{padding:28,textAlign:"center",color:C.dim,fontSize:11,fontFamily:"'DM Mono',monospace"}}>🛩️ No notifications yet</div>
        ):notifs.map(n=>(
          <div key={n.id} onClick={()=>markOne(n.id)}
            style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}22`,
              background:n.read?"transparent":`${C.amber}08`,
              display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}>
            <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{icons[n.type]||"🔔"}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4}}>
                <span style={{fontSize:11,fontWeight:n.read?400:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{n.title}</span>
                {!n.read&&<div style={{width:6,height:6,borderRadius:"50%",background:C.amber,flexShrink:0}}/>}
              </div>
              <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2,lineHeight:1.5}}>{n.body}</div>
              <div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace",marginTop:3}}>{fmtTime(n.time)}</div>
            </div>
            <button onClick={e=>{e.stopPropagation();del(n.id);}} type="button"
              style={{background:"none",border:"none",color:C.dim,fontSize:12,cursor:"pointer",padding:"0 2px",flexShrink:0}}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   POPUP MODAL WRAPPER — reusable professional popup
   ══════════════════════════════════════════════════════════════ */
function Popup({title,subtitle,onClose,children,width=520}){
  return(
    <div style={{position:"fixed",inset:0,zIndex:2000,background:"rgba(7,9,15,0.88)",
      backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <style>{`@keyframes popIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}`}</style>
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,
        width,maxWidth:"95vw",maxHeight:"90vh",display:"flex",flexDirection:"column",
        boxShadow:"0 24px 80px rgba(0,0,0,0.7)",animation:"popIn 0.2s ease"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"16px 20px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          <div>
            <div style={{fontSize:8,color:C.muted,letterSpacing:"0.18em",fontFamily:"'DM Mono',monospace",marginBottom:3,textTransform:"uppercase"}}>AEROSPACE DESIGN SUITE</div>
            <div style={{fontSize:16,fontWeight:800,color:C.text,letterSpacing:"-0.02em"}}>
              <span style={{color:C.amber}}>eVTOL</span> <span style={{color:C.muted,fontWeight:400,fontSize:12}}>—</span> {title}
            </div>
            {subtitle&&<div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginTop:2}}>{subtitle}</div>}
          </div>
          <button onClick={onClose} type="button"
            style={{background:`${C.border}`,border:`1px solid ${C.border}`,borderRadius:6,
              color:C.muted,fontSize:14,cursor:"pointer",padding:"6px 10px",lineHeight:1,
              fontFamily:"'DM Mono',monospace",transition:"all 0.15s"}}
            onMouseEnter={e=>{e.currentTarget.style.background=`${C.red}22`;e.currentTarget.style.color=C.red;}}
            onMouseLeave={e=>{e.currentTarget.style.background=C.border;e.currentTarget.style.color=C.muted;}}>
            ✕ Close
          </button>
        </div>
        {/* Content */}
        <div style={{overflowY:"auto",flex:1,padding:"20px"}}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Profile Modal ── */
function ProfileModal({user,onClose,onUpdate}){
  const[fu,setFu]=useState(null);
  const[loadingUser,setLoadingUser]=useState(true);

  useEffect(()=>{
    getUserByEmail(user.email).then(data=>{
      setFu(data);
      setLoadingUser(false);
    }).catch(()=>setLoadingUser(false));
  },[user.email]);

  // Smart name parsing — handle all account types
  const parsedFirstName=(()=>{
    if(fu?.first_name) return fu.first_name;
    if(fu?.firstName) return fu.firstName;
    const n=(fu?.name||user.name||user.firstName||"").trim();
    if(n && n!=="undefined undefined" && n!=="undefined") return n.split(" ")[0]||"";
    return (user.email||"").split("@")[0]||"";
  })();
  const parsedLastName=(()=>{
    if(fu?.last_name) return fu.last_name;
    if(fu?.lastName) return fu.lastName;
    const n=(fu?.name||user.name||"").trim();
    if(n && n!=="undefined undefined" && n!=="undefined"){
      const parts=n.split(" ");
      return parts.slice(1).join(" ")||"";
    }
    return user.lastName||"";
  })();

  const[firstName,setFirstName]=useState(user.firstName||"");
  const[lastName,setLastName]=useState(user.lastName||"");
  const[mobile,setMobile]=useState(user.mobile||"");
  const[org,setOrg]=useState(user.org||"");
  const[saving,setSaving]=useState(false);
  const[saved,setSaved]=useState(false);
  const[showPwSection,setShowPwSection]=useState(false);
  const[oldPw,setOldPw]=useState("");
  const[newPw,setNewPw]=useState("");
  const[newPw2,setNewPw2]=useState("");
  const[pwErr,setPwErr]=useState("");
  const[pwOk,setPwOk]=useState("");

  // Once fu loads from Supabase, sync fields
  useEffect(()=>{
    if(fu){
      setFirstName(fu.first_name||fu.firstName||parsedFirstName);
      setLastName(fu.last_name||fu.lastName||parsedLastName);
      setMobile(fu.mobile||user.mobile||"");
      setOrg(fu.org||user.org||"");
    }
  },[fu]);

  // Auto-generate username from name if not set
  const username=fu?.username||(parsedFirstName+parsedLastName).toLowerCase().replace(/\s/g,"")||user.email.split("@")[0];

  const handleSave=async()=>{
    setSaving(true);
    try{
      const u=await getUserByEmail(user.email);
      if(u){
        const updatedUser={...u,
          first_name:firstName.trim(), last_name:lastName.trim(),
          firstName:firstName.trim(), lastName:lastName.trim(),
          mobile:mobile.trim()||null,
          org:org.trim()||null,
          username:u.username||username,
        };
        await upsertUser(updatedUser);
        const newName=`${firstName.trim()} ${lastName.trim()}`.trim()||parsedFirstName;
        const updatedSession={
          ...getSession(),
          name:newName,
          firstName:firstName.trim(),
          lastName:lastName.trim(),
          mobile:mobile.trim()||null,
          org:org.trim()||null,
          avatar:newName[0].toUpperCase(),
        };
        saveSession(updatedSession);
        onUpdate(updatedSession);
        addNotif(user.id,{title:"Profile Updated",body:"Your profile details have been saved.",type:"success"});
      }
      setSaving(false); setSaved(true);
      setTimeout(()=>setSaved(false),2500);
    }catch(e){
      setSaving(false);
      console.error("Profile save failed:",e);
    }
  };

  const handlePasswordChange=async()=>{
    setPwErr(""); setPwOk("");
    try{
      const u=await getUserByEmail(user.email);
      if(!u) return setPwErr("Account not found.");
      const storedHash=u.pw_hash||u.pwHash||"";
      if(storedHash!==btoa(oldPw)) return setPwErr("Current password is incorrect.");
      if(newPw.length<8) return setPwErr("New password must be ≥ 8 characters.");
      if(newPw!==newPw2) return setPwErr("New passwords do not match.");
      await upsertUser({...u, pw_hash:btoa(newPw), pwHash:btoa(newPw)});
      addNotif(user.id,{title:"Password Changed",body:"Your password has been updated successfully.",type:"success"});
      setPwOk("✓ Password changed successfully!");
      setOldPw(""); setNewPw(""); setNewPw2("");
      setTimeout(()=>setShowPwSection(false),1500);
    }catch(e){
      setPwErr("Failed to update password — check connection. "+e.message);
    }
  };

  const displayAvatar=(firstName[0]||parsedFirstName[0]||user.email[0]||"?").toUpperCase();
  const displayFullName=`${firstName} ${lastName}`.trim()||parsedFirstName;

  const fields=[
    {label:"First Name",value:firstName,set:setFirstName,placeholder:"Enter first name"},
    {label:"Last Name",value:lastName,set:setLastName,placeholder:"Enter last name"},
    {label:"Email Address",value:user.email,set:()=>{},placeholder:"",disabled:true},
    {label:"Mobile Number",value:mobile,set:setMobile,placeholder:"+1 234 567 8900"},
    {label:"Organization",value:org,set:setOrg,placeholder:"e.g. Wright State University"},
    {label:"Username",value:username,set:()=>{},placeholder:"",disabled:true},
  ];

  return(
    <Popup title="My Profile" subtitle={`Joined ${fu?.createdAt?new Date(fu.createdAt).toLocaleDateString():"—"}`} onClose={onClose} width={480}>
      {/* Avatar + name header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24,padding:"16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
        <div style={{width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.amber},#f97316)`,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:800,color:"#07090f",flexShrink:0}}>
          {displayAvatar}
        </div>
        <div>
          <div style={{fontSize:16,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{displayFullName}</div>
          <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{user.email}</div>
          {username&&<div style={{fontSize:10,color:C.dim,fontFamily:"'DM Mono',monospace"}}>@{username}</div>}
          {(org||fu?.org)&&<div style={{fontSize:10,color:C.purple,fontFamily:"'DM Mono',monospace"}}>🏢 {org||fu?.org}</div>}
        </div>
      </div>

      {/* Fields */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        {fields.map(({label,value,set,placeholder,disabled})=>(
          <div key={label}>
            <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.08em"}}>{label}</div>
            <input value={value} onChange={e=>set(e.target.value)} placeholder={placeholder} disabled={disabled} type="text"
              style={{width:"100%",boxSizing:"border-box",background:disabled?C.bg:C.bg,
                border:`1px solid ${disabled?C.border+"88":C.border}`,borderRadius:6,
                color:disabled?C.muted:C.text,fontSize:12,padding:"9px 12px",
                fontFamily:"'DM Mono',monospace",outline:"none",opacity:disabled?0.6:1}}
              onFocus={e=>{if(!disabled)e.target.style.borderColor=C.amber;}}
              onBlur={e=>{if(!disabled)e.target.style.borderColor=C.border;}}
            />
          </div>
        ))}
      </div>

      <button onClick={handleSave} disabled={saving} type="button"
        style={{width:"100%",padding:"10px",
          background:saved?`linear-gradient(135deg,${C.green},#16a34a)`:`linear-gradient(135deg,${C.amber},#f97316)`,
          border:"none",borderRadius:6,color:"#07090f",fontSize:13,fontWeight:700,
          cursor:saving?"not-allowed":"pointer",fontFamily:"'DM Mono',monospace",
          marginBottom:16,transition:"background 0.3s"}}>
        {saving?"Saving...":saved?"✓ Saved!":"Save Changes"}
      </button>

      {/* Change password */}
      <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16}}>
        <button onClick={()=>setShowPwSection(s=>!s)} type="button"
          style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,
            color:C.text,fontSize:12,cursor:"pointer",padding:"8px 16px",
            fontFamily:"'DM Mono',monospace",fontWeight:600,marginBottom:showPwSection?12:0}}>
          🔑 {showPwSection?"Hide":"Change Password"}
        </button>
        {showPwSection&&(
          <div style={{background:C.bg,borderRadius:8,padding:14,border:`1px solid ${C.border}`}}>
            {pwErr&&<div style={{color:C.red,fontSize:11,fontFamily:"'DM Mono',monospace",marginBottom:8}}>✗ {pwErr}</div>}
            {pwOk&&<div style={{color:C.green,fontSize:11,fontFamily:"'DM Mono',monospace",marginBottom:8}}>{pwOk}</div>}
            {[["Current Password",oldPw,setOldPw],["New Password",newPw,setNewPw],["Confirm New Password",newPw2,setNewPw2]].map(([lbl,val,setVal])=>(
              <div key={lbl} style={{marginBottom:10}}>
                <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:4,textTransform:"uppercase"}}>{lbl}</div>
                <input type="password" value={val} onChange={e=>setVal(e.target.value)} placeholder="••••••••"
                  style={{width:"100%",boxSizing:"border-box",background:C.bg,
                    border:`1px solid ${C.border}`,borderRadius:6,color:C.text,fontSize:12,
                    padding:"8px 12px",fontFamily:"'DM Mono',monospace",outline:"none"}}
                  onFocus={e=>e.target.style.borderColor=C.amber}
                  onBlur={e=>e.target.style.borderColor=C.border}/>
              </div>
            ))}
            <button onClick={handlePasswordChange} type="button"
              style={{background:C.blue,border:"none",borderRadius:6,color:"#fff",fontSize:12,
                fontWeight:700,cursor:"pointer",padding:"8px 20px",fontFamily:"'DM Mono',monospace"}}>
              Update Password
            </button>
          </div>
        )}
      </div>
    </Popup>
  );
}

/* ── My Designs Modal ── */
function MyDesignsModal({user,onClose}){
  const[designs,setDesigns]=useState([]);
  const[loading,setLoading]=useState(true);
  const[confirm,setConfirm]=useState(null);

  useEffect(()=>{
    getDesigns(user.id).then(d=>{
      // Supabase stores params/results as JSON strings, parse them back
      setDesigns((d||[]).map(x=>({
        ...x,
        params: typeof x.params==="string"?JSON.parse(x.params||"{}"):x.params,
        results: typeof x.results==="string"?JSON.parse(x.results||"{}"):x.results,
        pdfHtml: x.pdf_html||x.pdfHtml||null,
        savedAt: x.saved_at||x.savedAt,
      })));
      setLoading(false);
    }).catch(()=>setLoading(false));
  },[user.id]);

  const handleDelete=async(id)=>{
    setDesigns(prev=>prev.filter(d=>d.id!==id));
    await deleteDesign(id);
    setConfirm(null);
  };

  const handleDownload=(d)=>{
    if(!d.pdfHtml){ alert("No PDF saved for this design. Re-save it from the main app."); return; }
    const w=window.open("","_blank");
    w.document.write(d.pdfHtml);
    w.document.close();
    addNotif(user.id,{title:"Report Opened",body:`PDF report for "${d.name}" opened.`,type:"info"});
  };

  return(
    <Popup title="My Designs" subtitle={loading?"Loading...":
      `${designs.length} saved design${designs.length!==1?"s":""}`} onClose={onClose} width={580}>
      {loading?(
        <div style={{textAlign:"center",padding:"48px 0",color:C.muted,fontFamily:"'DM Mono',monospace"}}>
          <div style={{fontSize:32,marginBottom:12}}>⏳</div>Loading your designs...
        </div>
      ):designs.length===0?(
        <div style={{textAlign:"center",padding:"48px 0",color:C.muted}}>
          <div style={{fontSize:48,marginBottom:16}}>✈️</div>
          <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:8}}>No saved designs yet</div>
          <div style={{fontSize:12,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
            Click the <span style={{color:C.amber,fontWeight:700}}>💾 Save Design</span> button in the main app<br/>to save your current design here.
          </div>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {designs.map(d=>(
            <div key={d.id} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace",marginBottom:4,
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
                  <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
                    Saved {fmtTime(d.savedAt)}
                  </div>
                  {d.results&&(
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {[
                        ["MTOW",d.results.MTOW+"kg",C.amber],
                        ["Energy",d.results.Etot+"kWh",C.teal],
                        ["Hover",d.results.Phov+"kW",C.blue],
                        ["L/D",d.results.LDact,C.green],
                      ].map(([lbl,val,col])=>(
                        <div key={lbl} style={{background:`${col}11`,border:`1px solid ${col}33`,borderRadius:4,padding:"2px 8px"}}>
                          <span style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{lbl}: </span>
                          <span style={{fontSize:9,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{val}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0}}>
                  <button onClick={()=>handleDownload(d)} type="button"
                    style={{padding:"6px 12px",background:`linear-gradient(135deg,#1e3a5f,#1e40af)`,
                      border:`1px solid ${C.blue}`,borderRadius:6,color:"#93c5fd",fontSize:10,
                      cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                    ⬇ PDF
                  </button>
                  <button onClick={()=>setConfirm(d.id)} type="button"
                    style={{padding:"6px 10px",background:"transparent",border:`1px solid ${C.red}44`,
                      borderRadius:6,color:C.red,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                    🗑
                  </button>
                </div>
              </div>
              {confirm===d.id&&(
                <div style={{marginTop:10,padding:"10px 12px",background:`${C.red}11`,border:`1px solid ${C.red}44`,borderRadius:6,
                  display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                  <span style={{fontSize:11,color:C.red,fontFamily:"'DM Mono',monospace"}}>Delete "{d.name}"?</span>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>handleDelete(d.id)} type="button"
                      style={{padding:"4px 12px",background:C.red,border:"none",borderRadius:4,color:"#fff",fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                      Delete
                    </button>
                    <button onClick={()=>setConfirm(null)} type="button"
                      style={{padding:"4px 12px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:4,color:C.muted,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Popup>
  );
}

/* ── Report History Modal ── */
function ReportHistoryModal({user,onClose}){
  const[reports,setReports]=useState([]);
  const[loadingR,setLoadingR]=useState(true);

  useEffect(()=>{
    getReports(user.id).then(r=>{
      setReports((r||[]).map(x=>({
        ...x,
        results: typeof x.results==="string"?JSON.parse(x.results||"{}"):x.results,
        pdfHtml: x.pdf_html||x.pdfHtml||null,
        generatedAt: x.generated_at||x.generatedAt,
      })));
      setLoadingR(false);
    }).catch(()=>setLoadingR(false));
  },[user.id]);

  const handleOpen=(r)=>{
    if(!r.pdfHtml){ alert("PDF not available for this report."); return; }
    const w=window.open("","_blank");
    w.document.write(r.pdfHtml);
    w.document.close();
  };

  const handleDelete=async(id)=>{
    setReports(prev=>prev.filter(r=>r.id!==id));
    await deleteReport(id);
  };

  return(
    <Popup title="Report History" subtitle={loadingR?"Loading...":
      `${reports.length} report${reports.length!==1?"s":""} generated`} onClose={onClose} width={580}>
      {loadingR?(
        <div style={{textAlign:"center",padding:"48px 0",color:C.muted,fontFamily:"'DM Mono',monospace"}}>
          <div style={{fontSize:32,marginBottom:12}}>⏳</div>Loading report history...
        </div>
      ):reports.length===0?(
        <div style={{textAlign:"center",padding:"48px 0"}}>
          <div style={{fontSize:48,marginBottom:16}}>📄</div>
          <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:8}}>No reports yet</div>
          <div style={{fontSize:12,color:C.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
            Click <span style={{color:C.blue,fontWeight:700}}>⬇ PDF REPORT</span> in the header<br/>to generate and save a report.
          </div>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {reports.map(r=>(
            <div key={r.id} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px",
              display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:40,height:40,borderRadius:8,background:`${C.blue}22`,border:`1px solid ${C.blue}44`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📄</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace",marginBottom:2,
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</div>
                <div style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{fmtTime(r.generatedAt)}</div>
                {r.results&&(
                  <div style={{fontSize:10,color:C.dim,fontFamily:"'DM Mono',monospace",marginTop:3}}>
                    MTOW: {r.results.MTOW}kg · E: {r.results.Etot}kWh · SM: {(r.results.SM*100)?.toFixed(1)}%
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>handleOpen(r)} type="button"
                  style={{padding:"6px 12px",background:`linear-gradient(135deg,#1e3a5f,#1e40af)`,
                    border:`1px solid ${C.blue}`,borderRadius:6,color:"#93c5fd",fontSize:10,
                    cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                  ⬇ Open PDF
                </button>
                <button onClick={()=>handleDelete(r.id)} type="button"
                  style={{padding:"6px 10px",background:"transparent",border:`1px solid ${C.red}44`,
                    borderRadius:6,color:C.red,fontSize:10,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Popup>
  );
}

/* ══════════════════════════════════════════════════════════════
   PROFILE DROPDOWN — no modal state here, just triggers
   ══════════════════════════════════════════════════════════════ */
function ProfileDropdown({user,onSignOut,onClose,onOpenProfile,onOpenDesigns,onOpenReports}){
  const[fu,setFu]=useState(null);
  useEffect(()=>{ getUserByEmail(user.email).then(setFu).catch(()=>{}); },[user.email]);
  const displayName=buildDisplayName({...fu,...user});

  const items=[
    {icon:"👤",label:"Profile & Settings",action:()=>{ onClose(); setTimeout(()=>onOpenProfile(),50); }},
    {icon:"📐",label:"My Designs",         action:()=>{ onClose(); setTimeout(()=>onOpenDesigns(),50); }},
    {icon:"📄",label:"Report History",     action:()=>{ onClose(); setTimeout(()=>onOpenReports(),50); }},
  ];

  return(
    <div style={{position:"absolute",top:"100%",right:0,zIndex:200,marginTop:8,
      background:C.panel,border:`1px solid ${C.border}`,borderRadius:10,
      width:260,boxShadow:"0 8px 40px rgba(0,0,0,0.6)"}}>
      {/* User info header */}
      <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:40,height:40,borderRadius:"50%",
            background:`linear-gradient(135deg,${C.amber},#f97316)`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:17,fontWeight:800,color:"#07090f",flexShrink:0}}>
            {displayName[0].toUpperCase()}
          </div>
          <div style={{minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayName}</div>
            <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.email}</div>
            {fu?.mobile&&<div style={{fontSize:9,color:C.teal,fontFamily:"'DM Mono',monospace"}}>📱 {fu.mobile}</div>}
            {(fu?.org||user.org)&&<div style={{fontSize:9,color:C.purple,fontFamily:"'DM Mono',monospace"}}>🏢 {fu?.org||user.org}</div>}
            {fu?.username&&<div style={{fontSize:9,color:C.dim,fontFamily:"'DM Mono',monospace"}}>@{fu.username}</div>}
          </div>
        </div>
      </div>
      {items.map(item=>(
        <button key={item.label} onClick={item.action} type="button"
          style={{width:"100%",padding:"10px 16px",background:"none",border:"none",
            display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",
            borderBottom:`1px solid ${C.border}22`}}
          onMouseEnter={e=>e.currentTarget.style.background="#ffffff08"}
          onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
          <span style={{fontSize:14}}>{item.icon}</span>
          <span style={{fontSize:11,color:C.text,fontFamily:"'DM Mono',monospace"}}>{item.label}</span>
        </button>
      ))}
      <button onClick={()=>{ onClose(); onSignOut(); }} type="button"
        style={{width:"100%",padding:"10px 16px",background:"none",border:"none",
          display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left"}}
        onMouseEnter={e=>e.currentTarget.style.background=`${C.red}11`}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        <span style={{fontSize:14}}>🚪</span>
        <span style={{fontSize:11,color:C.red,fontFamily:"'DM Mono',monospace",fontWeight:700}}>Sign Out</span>
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AUTH GATE
   ══════════════════════════════════════════════════════════════ */
function AuthGate({user,onAuth,children}){
  const[showModal,setShowModal]=useState(false);
  const pendingCb=useRef(null);
  const handleCapture=(e)=>{
    e.stopPropagation(); e.preventDefault();
    pendingCb.current=children.props.onClick||null;
    setShowModal(true);
  };
  const handleAuthSuccess=(session)=>{
    setShowModal(false); onAuth(session);
    const cb=pendingCb.current;
    if(cb) setTimeout(()=>cb(),200);
  };
  return(
    <>
      <div style={{position:"relative",display:"inline-flex"}}>
        {children}
        {!user&&(
          <div onClick={handleCapture} title="Sign in required"
            style={{position:"absolute",inset:0,zIndex:10,cursor:"pointer",borderRadius:"inherit",background:"transparent"}}/>
        )}
      </div>
      {showModal&&<AuthModal onClose={()=>setShowModal(false)} onAuth={handleAuthSuccess}/>}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   USER HEADER BAR — modal state lives here so popups survive
   dropdown unmounting
   ══════════════════════════════════════════════════════════════ */
function UserHeaderBar({user,onSignOut,onSignIn,onUpdate}){
  const[showNotifs,setShowNotifs]=useState(false);
  const[showProfile,setShowProfile]=useState(false);
  const[notifCount,setNotifCount]=useState(0);
  const notifRef=useRef(null);
  const profileRef=useRef(null);

  // Modal state lives HERE — not inside ProfileDropdown
  const[showProfileModal,setShowProfileModal]=useState(false);
  const[showDesignsModal,setShowDesignsModal]=useState(false);
  const[showReportsModal,setShowReportsModal]=useState(false);
  const[userOrg,setUserOrg]=useState(user?.org||"");

  useEffect(()=>{
    if(!user) return;
    // Load notif count and org from Supabase
    getNotifs(user.id).then(n=>setNotifCount((n||[]).filter(x=>!x.read).length)).catch(()=>{});
    getUserByEmail(user.email).then(fu=>{ if(fu?.org) setUserOrg(fu.org); }).catch(()=>{});
  },[user,showNotifs]);

  useEffect(()=>{
    const h=(e)=>{
      if(notifRef.current&&!notifRef.current.contains(e.target)) setShowNotifs(false);
      if(profileRef.current&&!profileRef.current.contains(e.target)) setShowProfile(false);
    };
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);

  if(!user) return(
    <div style={{display:"flex",gap:8,marginLeft:"auto",alignItems:"center"}}>
      <button onClick={onSignIn} type="button"
        style={{padding:"6px 14px",background:"transparent",border:`1px solid ${C.border}`,
          borderRadius:6,color:C.text,fontSize:11,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        Sign In
      </button>
      <button onClick={onSignIn} type="button"
        style={{padding:"6px 14px",background:`linear-gradient(135deg,${C.amber},#f97316)`,
          border:"none",borderRadius:6,color:"#07090f",fontSize:11,cursor:"pointer",
          fontFamily:"'DM Mono',monospace",fontWeight:700}}>
        Register →
      </button>
    </div>
  );

  const displayName=buildDisplayName(user);
  const firstName=displayName.split(" ")[0]||displayName;

  return(
    <>
      <div style={{display:"flex",gap:10,marginLeft:"auto",alignItems:"center"}}>
        {/* Bell */}
        <div ref={notifRef} style={{position:"relative"}}>
          <button onClick={()=>{setShowNotifs(s=>!s);setShowProfile(false);}} type="button"
            style={{background:showNotifs?`${C.amber}15`:"transparent",
              border:`1px solid ${showNotifs?C.amber+"44":C.border}`,
              borderRadius:6,padding:"5px 9px",cursor:"pointer",
              display:"flex",alignItems:"center",gap:4,position:"relative"}}>
            <span style={{fontSize:14}}>🔔</span>
            {notifCount>0&&<span style={{position:"absolute",top:-4,right:-4,background:C.red,color:"#fff",
              fontSize:8,borderRadius:10,padding:"1px 5px",fontWeight:800,
              fontFamily:"'DM Mono',monospace",minWidth:16,textAlign:"center"}}>
              {notifCount>9?"9+":notifCount}
            </span>}
          </button>
          {showNotifs&&<NotifCenter user={user} onClose={()=>setShowNotifs(false)}/>}
        </div>

        {/* Avatar + dropdown */}
        <div ref={profileRef} style={{position:"relative"}}>
          <button onClick={()=>{setShowProfile(s=>!s);setShowNotifs(false);}} type="button"
            style={{display:"flex",alignItems:"center",gap:8,
              background:showProfile?`${C.amber}15`:"transparent",
              border:`1px solid ${showProfile?C.amber+"44":C.border}`,
              borderRadius:6,padding:"4px 10px 4px 5px",cursor:"pointer"}}>
            <div style={{width:28,height:28,borderRadius:"50%",
              background:`linear-gradient(135deg,${C.amber},#f97316)`,
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:13,fontWeight:800,color:"#07090f",flexShrink:0}}>
              {displayName[0].toUpperCase()}
            </div>
            <div style={{textAlign:"left"}}>
              <div style={{fontSize:10,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace",lineHeight:1.2}}>
                {firstName}
              </div>
              {userOrg&&(
                <div style={{fontSize:8,color:C.purple,fontFamily:"'DM Mono',monospace"}}>
                  🏢 {userOrg}
                </div>
              )}
            </div>
            <span style={{fontSize:8,color:C.dim}}>{showProfile?"▾":"▸"}</span>
          </button>

          {showProfile&&(
            <ProfileDropdown
              user={user}
              onSignOut={onSignOut}
              onClose={()=>setShowProfile(false)}
              onOpenProfile={()=>setShowProfileModal(true)}
              onOpenDesigns={()=>setShowDesignsModal(true)}
              onOpenReports={()=>setShowReportsModal(true)}
            />
          )}
        </div>
      </div>

      {/* Modals rendered at this level — outside the dropdown, always mounted when active */}
      {showProfileModal&&(
        <ProfileModal
          user={user}
          onClose={()=>setShowProfileModal(false)}
          onUpdate={s=>{ onUpdate&&onUpdate(s); }}
        />
      )}
      {showDesignsModal&&(
        <MyDesignsModal
          user={user}
          onClose={()=>setShowDesignsModal(false)}
        />
      )}
      {showReportsModal&&(
        <ReportHistoryModal
          user={user}
          onClose={()=>setShowReportsModal(false)}
        />
      )}
    </>
  );
}

/* ── EXPORTS ── */
export { AuthModal, AuthGate, UserHeaderBar, NotifCenter, getSession, saveSession, clearSession, addNotif, saveDesign, addReport, getDesigns, getReports };
