import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════
   eVTOL SIZER — AUTH SYSTEM  v1.0
   Features:
   • Email + Password sign up / login
   • OTP (email code) login
   • Google SSO (mock)
   • Organization / SSO login
   • Persistent session (localStorage)
   • Notification center
   • User profile dropdown
   • Protected action gate (PDF Report, VSP Download)
   ═══════════════════════════════════════════════════════════════ */

/* ── Colors (match main app) ── */
const C = {
  bg: "#07090f", panel: "#0d1117", border: "#1c2333",
  amber: "#f59e0b", teal: "#14b8a6", blue: "#3b82f6",
  red: "#ef4444", green: "#22c55e", dim: "#4b5563",
  text: "#e2e8f0", muted: "#64748b", purple: "#8b5cf6",
};

/* ── Tiny helpers ── */
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();
const fmtTime = (iso) => {
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
};

/* ── Mock OTP store (in-memory) ── */
const otpStore = {};
function generateOTP(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore[email] = { code, expires: Date.now() + 5 * 60 * 1000 };
  return code;
}
function verifyOTP(email, code) {
  const entry = otpStore[email];
  if (!entry) return false;
  if (Date.now() > entry.expires) return false;
  return entry.code === code.trim();
}

/* ── Mock user DB (localStorage) ── */
function getUsers() {
  try { return JSON.parse(localStorage.getItem("evtol_users") || "{}"); } catch { return {}; }
}
function saveUsers(u) { localStorage.setItem("evtol_users", JSON.stringify(u)); }
function getSession() {
  try { return JSON.parse(localStorage.getItem("evtol_session") || "null"); } catch { return null; }
}
function saveSession(s) { localStorage.setItem("evtol_session", JSON.stringify(s)); }
function clearSession() { localStorage.removeItem("evtol_session"); }

/* ── Notification helpers ── */
function getNotifs(uid) {
  try { return JSON.parse(localStorage.getItem(`evtol_notifs_${uid}`) || "[]"); } catch { return []; }
}
function saveNotifs(uid, n) { localStorage.setItem(`evtol_notifs_${uid}`, JSON.stringify(n)); }
function addNotif(uid, { title, body, type = "info" }) {
  const notifs = getNotifs(uid);
  notifs.unshift({ id: uid + "_" + Date.now(), title, body, type, read: false, time: now() });
  saveNotifs(uid, notifs.slice(0, 50));
}

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

function Input({ label, type = "text", value, onChange, placeholder, error, autoFocus, rightEl }) {
  const [show, setShow] = useState(false);
  const isPass = type === "password";
  return (
    <div style={{ marginBottom: 14 }}>
      {label && (
        <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {label}
        </div>
      )}
      <div style={{ position: "relative" }}>
        <input
          type={isPass && show ? "text" : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#0a0d14", border: `1px solid ${error ? C.red : C.border}`,
            borderRadius: 6, color: C.text, fontSize: 13,
            padding: "10px 40px 10px 12px", fontFamily: "'DM Mono',monospace",
            outline: "none", transition: "border-color 0.2s",
          }}
          onFocus={e => e.target.style.borderColor = C.amber}
          onBlur={e => e.target.style.borderColor = error ? C.red : C.border}
        />
        {isPass && (
          <button onClick={() => setShow(s => !s)} style={{
            position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 13, padding: 2,
          }}>{show ? "🙈" : "👁"}</button>
        )}
        {rightEl && <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" }}>{rightEl}</div>}
      </div>
      {error && <div style={{ fontSize: 10, color: C.red, marginTop: 4, fontFamily: "'DM Mono',monospace" }}>{error}</div>}
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", disabled, loading, fullWidth, small }) {
  const styles = {
    primary: { background: `linear-gradient(135deg,${C.amber},#f97316)`, color: "#07090f", border: "none" },
    secondary: { background: "transparent", color: C.text, border: `1px solid ${C.border}` },
    ghost: { background: "transparent", color: C.muted, border: "none" },
    danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}44` },
    google: { background: "#fff", color: "#1f2937", border: "1px solid #d1d5db" },
    blue: { background: `linear-gradient(135deg,#1e3a5f,#1e40af)`, color: "#93c5fd", border: `1px solid ${C.blue}` },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        ...styles[variant],
        padding: small ? "6px 14px" : "10px 20px",
        borderRadius: 6, fontSize: small ? 11 : 13, fontWeight: 700,
        fontFamily: "'DM Mono',monospace", cursor: disabled || loading ? "not-allowed" : "pointer",
        width: fullWidth ? "100%" : "auto", letterSpacing: "0.04em",
        opacity: disabled || loading ? 0.6 : 1, transition: "opacity 0.15s, transform 0.1s",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      }}
      onMouseEnter={e => { if (!disabled && !loading) e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {loading ? <span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⏳</span> : children}
    </button>
  );
}

function Divider({ text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      <span style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{text}</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function Alert({ type, children }) {
  const colors = { error: C.red, success: C.green, info: C.blue, warn: C.amber };
  const col = colors[type] || C.muted;
  const icons = { error: "✗", success: "✓", info: "ℹ", warn: "⚠" };
  return (
    <div style={{
      background: `${col}11`, border: `1px solid ${col}44`, borderRadius: 6,
      padding: "9px 12px", marginBottom: 12, display: "flex", gap: 8, alignItems: "flex-start",
    }}>
      <span style={{ color: col, fontSize: 12, flexShrink: 0, marginTop: 1 }}>{icons[type]}</span>
      <span style={{ fontSize: 11, color: col, fontFamily: "'DM Mono',monospace", lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

/* ── OTP Input (6 boxes) ── */
function OTPInput({ value, onChange }) {
  const inputs = useRef([]);
  const digits = (value || "      ").split("").slice(0, 6);
  const handleKey = (i, e) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) inputs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) inputs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 5) inputs.current[i + 1]?.focus();
  };
  const handleChange = (i, v) => {
    const d = v.replace(/\D/, "").slice(-1);
    const arr = [...digits];
    arr[i] = d || " ";
    onChange(arr.join("").trimEnd());
    if (d && i < 5) inputs.current[i + 1]?.focus();
  };
  const handlePaste = (e) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted) { onChange(pasted.padEnd(6, " ")); inputs.current[Math.min(pasted.length, 5)]?.focus(); }
    e.preventDefault();
  };
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "16px 0" }}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <input
          key={i}
          ref={el => inputs.current[i] = el}
          type="text" inputMode="numeric" maxLength={1}
          value={digits[i]?.trim() || ""}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onPaste={handlePaste}
          style={{
            width: 44, height: 52, textAlign: "center", fontSize: 22, fontWeight: 700,
            fontFamily: "'DM Mono',monospace", background: "#0a0d14",
            border: `1px solid ${digits[i]?.trim() ? C.amber : C.border}`,
            borderRadius: 8, color: C.amber, outline: "none",
          }}
          onFocus={e => e.target.style.borderColor = C.amber}
          onBlur={e => e.target.style.borderColor = digits[i]?.trim() ? C.amber : C.border}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   AUTH MODAL — all flows
   ═══════════════════════════════════════════════════════════════ */
function AuthModal({ onClose, onAuth, defaultFlow = "login" }) {
  const [flow, setFlow] = useState(defaultFlow); // login | register | otp | org | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [orgCode, setOrgCode] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState(""); // mock: shown on screen
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [otpTimer, setOtpTimer] = useState(0);

  const timerRef = useRef(null);

  const startTimer = () => {
    setOtpTimer(60);
    timerRef.current = setInterval(() => {
      setOtpTimer(t => { if (t <= 1) { clearInterval(timerRef.current); return 0; } return t - 1; });
    }, 1000);
  };

  useEffect(() => () => clearInterval(timerRef.current), []);

  const reset = () => { setErr(""); setInfo(""); };

  /* ── REGISTER ── */
  const handleRegister = async () => {
    reset();
    if (!name.trim()) return setErr("Full name is required.");
    if (!email.includes("@")) return setErr("Enter a valid email.");
    if (password.length < 8) return setErr("Password must be ≥ 8 characters.");
    if (password !== confirmPw) return setErr("Passwords do not match.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 700));
    const users = getUsers();
    if (users[email]) { setLoading(false); return setErr("Account already exists. Please log in."); }
    const user = { id: uid(), name, email, org: org || null, createdAt: now(), avatar: name[0].toUpperCase() };
    users[email] = { ...user, pwHash: btoa(password) };
    saveUsers(users);
    const session = { ...user, token: uid() };
    saveSession(session);
    addNotif(user.id, { title: "Welcome to eVTOL Sizer!", body: `Hi ${name}, your account is ready. Start sizing your aircraft.`, type: "success" });
    setLoading(false);
    onAuth(session);
  };

  /* ── LOGIN ── */
  const handleLogin = async () => {
    reset();
    if (!email.includes("@")) return setErr("Enter a valid email.");
    if (!password) return setErr("Password is required.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 600));
    const users = getUsers();
    const user = users[email];
    if (!user || user.pwHash !== btoa(password)) { setLoading(false); return setErr("Invalid email or password."); }
    const session = { id: user.id, name: user.name, email: user.email, org: user.org, avatar: user.avatar, token: uid() };
    saveSession(session);
    addNotif(user.id, { title: "Login Successful", body: `Welcome back, ${user.name}! Session started.`, type: "info" });
    setLoading(false);
    onAuth(session);
  };

  /* ── SEND OTP ── */
  const handleSendOTP = async () => {
    reset();
    if (!email.includes("@")) return setErr("Enter a valid email.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 800));
    const code = generateOTP(email);
    setOtpCode(code); // mock: display since no real email service
    setOtpSent(true);
    startTimer();
    setLoading(false);
    setInfo("OTP sent! Check your email. (Demo: code shown below)");
  };

  /* ── VERIFY OTP ── */
  const handleVerifyOTP = async () => {
    reset();
    if (otp.trim().length < 6) return setErr("Enter the 6-digit code.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 600));
    if (!verifyOTP(email, otp.trim())) { setLoading(false); return setErr("Invalid or expired OTP. Try again."); }
    const users = getUsers();
    let user = users[email];
    if (!user) {
      // Auto-create account via OTP
      user = { id: uid(), name: email.split("@")[0], email, org: null, createdAt: now(), avatar: email[0].toUpperCase(), pwHash: "" };
      users[email] = user;
      saveUsers(users);
    }
    const session = { id: user.id, name: user.name, email: user.email, org: user.org, avatar: user.avatar, token: uid() };
    saveSession(session);
    addNotif(user.id, { title: "OTP Login Successful", body: "You signed in via one-time code.", type: "success" });
    setLoading(false);
    onAuth(session);
  };

  /* ── ORG / SSO LOGIN ── */
  const handleOrgLogin = async () => {
    reset();
    if (!org.trim()) return setErr("Enter your organization name or domain.");
    if (!orgCode.trim()) return setErr("Enter your SSO access code.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 1000));
    // Mock: any org with code "WSU2025" works
    if (orgCode.toUpperCase() !== "WSU2025") { setLoading(false); return setErr("Invalid SSO code. (Demo: use WSU2025)"); }
    const orgName = org.trim();
    const mockEmail = `user@${orgName.toLowerCase().replace(/\s+/g, "")}.edu`;
    const users = getUsers();
    let user = users[mockEmail];
    if (!user) {
      user = { id: uid(), name: `${orgName} User`, email: mockEmail, org: orgName, createdAt: now(), avatar: orgName[0].toUpperCase(), pwHash: "" };
      users[mockEmail] = user;
      saveUsers(users);
    }
    const session = { id: user.id, name: user.name, email: user.email, org: user.org, avatar: user.avatar, token: uid() };
    saveSession(session);
    addNotif(user.id, { title: `${orgName} SSO Login`, body: `Authenticated via ${orgName} organization portal.`, type: "success" });
    setLoading(false);
    onAuth(session);
  };

  /* ── GOOGLE MOCK ── */
  const handleGoogle = async () => {
    reset();
    setLoading(true);
    await new Promise(r => setTimeout(r, 1200));
    const mockEmail = "demo.user@gmail.com";
    const users = getUsers();
    let user = users[mockEmail];
    if (!user) {
      user = { id: uid(), name: "Demo User", email: mockEmail, org: null, createdAt: now(), avatar: "D", pwHash: "" };
      users[mockEmail] = user;
      saveUsers(users);
    }
    const session = { id: user.id, name: user.name, email: user.email, org: user.org, avatar: user.avatar, token: uid() };
    saveSession(session);
    addNotif(user.id, { title: "Google Sign-In", body: "Signed in with Google account successfully.", type: "success" });
    setLoading(false);
    onAuth(session);
  };

  /* ── FORGOT PASSWORD ── */
  const handleForgot = async () => {
    reset();
    if (!email.includes("@")) return setErr("Enter your registered email.");
    setLoading(true);
    await new Promise(r => setTimeout(r, 800));
    setLoading(false);
    setInfo("If an account exists, a reset link has been sent. (Demo only — no actual email)");
  };

  const titles = {
    login: "Sign In", register: "Create Account",
    otp: "Sign In with OTP", org: "Organization Login", forgot: "Reset Password",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(7,9,15,0.85)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: "28px 32px", width: 420, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto",
        boxShadow: `0 0 60px ${C.amber}18`, animation: "slideUp 0.25s ease",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.2em", fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>
              AEROSPACE DESIGN SUITE
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>
              <span style={{ color: C.amber }}>eVTOL</span>
              <span style={{ color: C.text }}> — {titles[flow]}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 20, cursor: "pointer", padding: 4, lineHeight: 1 }}>✕</button>
        </div>

        {err && <Alert type="error">{err}</Alert>}
        {info && <Alert type="success">{info}</Alert>}

        {/* ── LOGIN FLOW ── */}
        {flow === "login" && (
          <>
            <Btn variant="google" fullWidth onClick={handleGoogle} loading={loading}>
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Continue with Google
            </Btn>
            <Divider text="or sign in with email" />
            <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Input label="Password" type="password" value={password} onChange={setPassword} placeholder="••••••••" />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -8, marginBottom: 14 }}>
              <button onClick={() => { reset(); setFlow("forgot"); }} style={{ background: "none", border: "none", color: C.muted, fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono',monospace", padding: 0 }}>
                Forgot password?
              </button>
            </div>
            <Btn variant="primary" fullWidth onClick={handleLogin} loading={loading}>Sign In →</Btn>
            <Divider text="other options" />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="secondary" fullWidth onClick={() => { reset(); setFlow("otp"); }}>📱 OTP Login</Btn>
              <Btn variant="secondary" fullWidth onClick={() => { reset(); setFlow("org"); }}>🏢 Org / SSO</Btn>
            </div>
            <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace" }}>
              No account?{" "}
              <button onClick={() => { reset(); setFlow("register"); }} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono',monospace", fontWeight: 700, padding: 0 }}>
                Create one →
              </button>
            </div>
          </>
        )}

        {/* ── REGISTER FLOW ── */}
        {flow === "register" && (
          <>
            <Btn variant="google" fullWidth onClick={handleGoogle} loading={loading}>
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Sign up with Google
            </Btn>
            <Divider text="or create with email" />
            <Input label="Full Name" value={name} onChange={setName} placeholder="Dr. Jane Smith" autoFocus />
            <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Input label="Organization (optional)" value={org} onChange={setOrg} placeholder="Wright State University" />
            <Input label="Password" type="password" value={password} onChange={setPassword} placeholder="Min. 8 characters" />
            <Input label="Confirm Password" type="password" value={confirmPw} onChange={setConfirmPw} placeholder="Repeat password" />
            <div style={{ fontSize: 9, color: C.dim, fontFamily: "'DM Mono',monospace", marginBottom: 14, lineHeight: 1.6 }}>
              By creating an account you agree to the Terms of Service and Privacy Policy.
            </div>
            <Btn variant="primary" fullWidth onClick={handleRegister} loading={loading}>Create Account →</Btn>
            <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace" }}>
              Already have one?{" "}
              <button onClick={() => { reset(); setFlow("login"); }} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono',monospace", fontWeight: 700, padding: 0 }}>
                Sign in →
              </button>
            </div>
          </>
        )}

        {/* ── OTP FLOW ── */}
        {flow === "otp" && (
          <>
            <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 16, lineHeight: 1.7 }}>
              Enter your email to receive a 6-digit one-time code. No password needed.
            </div>
            <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus={!otpSent} />
            {!otpSent ? (
              <Btn variant="primary" fullWidth onClick={handleSendOTP} loading={loading}>Send OTP →</Btn>
            ) : (
              <>
                <div style={{ fontSize: 11, color: C.green, fontFamily: "'DM Mono',monospace", textAlign: "center", marginBottom: 4 }}>
                  Code sent to {email}
                </div>
                {otpCode && (
                  <Alert type="info">Demo mode — your OTP is: <strong style={{ color: C.amber, fontSize: 16, letterSpacing: "0.2em" }}>{otpCode}</strong></Alert>
                )}
                <OTPInput value={otp} onChange={setOtp} />
                <Btn variant="primary" fullWidth onClick={handleVerifyOTP} loading={loading}>Verify Code →</Btn>
                <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace" }}>
                  {otpTimer > 0 ? (
                    <span>Resend in {otpTimer}s</span>
                  ) : (
                    <button onClick={handleSendOTP} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace", padding: 0 }}>
                      Resend OTP
                    </button>
                  )}
                </div>
              </>
            )}
            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button onClick={() => { reset(); setFlow("login"); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace" }}>
                ← Back to login
              </button>
            </div>
          </>
        )}

        {/* ── ORG / SSO FLOW ── */}
        {flow === "org" && (
          <>
            <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 16, lineHeight: 1.7 }}>
              Sign in via your institution or organization's SSO portal. Contact your IT admin for the access code.
            </div>
            <Input label="Organization / Domain" value={org} onChange={setOrg} placeholder="Wright State University" autoFocus />
            <Input label="SSO Access Code" value={orgCode} onChange={setOrgCode} placeholder="e.g. WSU2025"
              rightEl={<span style={{ fontSize: 9, color: C.dim, fontFamily: "'DM Mono',monospace" }}>Demo: WSU2025</span>} />
            <Btn variant="blue" fullWidth onClick={handleOrgLogin} loading={loading}>🏢 Authenticate via SSO →</Btn>
            <Divider text="supported providers" />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginBottom: 8 }}>
              {["Okta", "Azure AD", "Google Workspace", "Shibboleth", "SAML 2.0"].map(p => (
                <span key={p} style={{ fontSize: 9, color: C.muted, background: "#111827", border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 8px", fontFamily: "'DM Mono',monospace" }}>{p}</span>
              ))}
            </div>
            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button onClick={() => { reset(); setFlow("login"); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace" }}>
                ← Back to login
              </button>
            </div>
          </>
        )}

        {/* ── FORGOT PASSWORD FLOW ── */}
        {flow === "forgot" && (
          <>
            <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace", marginBottom: 16, lineHeight: 1.7 }}>
              Enter your registered email and we'll send a password reset link.
            </div>
            <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus />
            <Btn variant="primary" fullWidth onClick={handleForgot} loading={loading}>Send Reset Link →</Btn>
            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button onClick={() => { reset(); setFlow("login"); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace" }}>
                ← Back to login
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION CENTER
   ═══════════════════════════════════════════════════════════════ */
function NotifCenter({ user, onClose }) {
  const [notifs, setNotifs] = useState(() => getNotifs(user.id));

  const markAllRead = () => {
    const updated = notifs.map(n => ({ ...n, read: true }));
    setNotifs(updated);
    saveNotifs(user.id, updated);
  };
  const markRead = (id) => {
    const updated = notifs.map(n => n.id === id ? { ...n, read: true } : n);
    setNotifs(updated);
    saveNotifs(user.id, updated);
  };
  const deleteNotif = (id) => {
    const updated = notifs.filter(n => n.id !== id);
    setNotifs(updated);
    saveNotifs(user.id, updated);
  };

  const typeIcon = { info: "ℹ️", success: "✅", warn: "⚠️", error: "❌" };
  const unread = notifs.filter(n => !n.read).length;

  return (
    <div style={{
      position: "absolute", top: "100%", right: 0, zIndex: 200, marginTop: 8,
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      width: 340, maxHeight: 440, display: "flex", flexDirection: "column",
      boxShadow: `0 8px 40px rgba(0,0,0,0.6)`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>Notifications</span>
          {unread > 0 && <span style={{ background: C.red, color: "#fff", fontSize: 9, borderRadius: 10, padding: "2px 6px", fontWeight: 700 }}>{unread}</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {unread > 0 && <button onClick={markAllRead} style={{ background: "none", border: "none", color: C.muted, fontSize: 9, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>Mark all read</button>}
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 0 }}>✕</button>
        </div>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {notifs.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: C.dim, fontSize: 11, fontFamily: "'DM Mono',monospace" }}>
            🛩️ No notifications yet
          </div>
        ) : notifs.map(n => (
          <div key={n.id} onClick={() => markRead(n.id)} style={{
            padding: "10px 14px", borderBottom: `1px solid ${C.border}22`,
            background: n.read ? "transparent" : `${C.amber}08`,
            display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer",
            transition: "background 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = "#ffffff07"}
            onMouseLeave={e => e.currentTarget.style.background = n.read ? "transparent" : `${C.amber}08`}
          >
            <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{typeIcon[n.type] || "🔔"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: n.read ? 400 : 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{n.title}</span>
                {!n.read && <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.amber, flexShrink: 0 }} />}
              </div>
              <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono',monospace", marginTop: 2, lineHeight: 1.5 }}>{n.body}</div>
              <div style={{ fontSize: 9, color: C.dim, fontFamily: "'DM Mono',monospace", marginTop: 3 }}>{fmtTime(n.time)}</div>
            </div>
            <button onClick={e => { e.stopPropagation(); deleteNotif(n.id); }} style={{
              background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer", padding: "0 2px", flexShrink: 0,
            }}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PROFILE DROPDOWN
   ═══════════════════════════════════════════════════════════════ */
function ProfileDropdown({ user, onSignOut, onClose }) {
  const items = [
    { icon: "👤", label: "Profile & Settings", action: () => { alert("Profile settings — coming soon!"); onClose(); } },
    { icon: "📐", label: "My Designs", action: () => { alert("Saved designs — coming soon!"); onClose(); } },
    { icon: "🔑", label: "Change Password", action: () => { alert("Password change — coming soon!"); onClose(); } },
    { icon: "🏢", label: "Organization", action: () => { alert(`Org: ${user.org || "Not set"}`); onClose(); } },
    { icon: "📄", label: "Report History", action: () => { alert("Report history — coming soon!"); onClose(); } },
  ];
  return (
    <div style={{
      position: "absolute", top: "100%", right: 0, zIndex: 200, marginTop: 8,
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      width: 240, boxShadow: `0 8px 40px rgba(0,0,0,0.6)`,
    }}>
      {/* User info */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%", background: `linear-gradient(135deg,${C.amber},#f97316)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 800, color: "#07090f", flexShrink: 0,
          }}>{user.avatar}</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace" }}>{user.name}</div>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{user.email}</div>
            {user.org && <div style={{ fontSize: 9, color: C.purple, fontFamily: "'DM Mono',monospace", marginTop: 1 }}>🏢 {user.org}</div>}
          </div>
        </div>
      </div>
      {/* Menu items */}
      {items.map(item => (
        <button key={item.label} onClick={item.action} style={{
          width: "100%", padding: "9px 16px", background: "none", border: "none",
          display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left",
          borderBottom: `1px solid ${C.border}22`,
        }}
          onMouseEnter={e => e.currentTarget.style.background = "#ffffff08"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <span style={{ fontSize: 13 }}>{item.icon}</span>
          <span style={{ fontSize: 11, color: C.text, fontFamily: "'DM Mono',monospace" }}>{item.label}</span>
        </button>
      ))}
      {/* Sign out */}
      <button onClick={onSignOut} style={{
        width: "100%", padding: "10px 16px", background: "none", border: "none",
        display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left",
      }}
        onMouseEnter={e => e.currentTarget.style.background = `${C.red}11`}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      >
        <span style={{ fontSize: 13 }}>🚪</span>
        <span style={{ fontSize: 11, color: C.red, fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>Sign Out</span>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   AUTH GATE — modal prompt before protected action
   ═══════════════════════════════════════════════════════════════ */
function AuthGate({ user, action, onAuth, children }) {
  const [showModal, setShowModal] = useState(false);
  const pendingAction = useRef(null);

  const handleClick = () => {
    if (user) {
      children.props.onClick?.();
    } else {
      setShowModal(true);
    }
  };

  const handleAuthSuccess = (session) => {
    setShowModal(false);
    onAuth(session);
    // Slight delay so state settles
    setTimeout(() => children.props.onClick?.(), 100);
  };

  return (
    <>
      {/* Clone the child button with our intercept handler */}
      <div onClick={handleClick} style={{ display: "contents" }}>
        {children}
      </div>
      {showModal && (
        <AuthModal
          onClose={() => setShowModal(false)}
          onAuth={handleAuthSuccess}
          defaultFlow="login"
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   USER HEADER BAR — avatar, notifs, dropdown
   ═══════════════════════════════════════════════════════════════ */
function UserHeaderBar({ user, onSignOut, onSignIn }) {
  const [showNotifs, setShowNotifs] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [notifCount, setNotifCount] = useState(0);
  const notifRef = useRef(null);
  const profileRef = useRef(null);

  useEffect(() => {
    if (user) {
      const n = getNotifs(user.id);
      setNotifCount(n.filter(x => !x.read).length);
    }
  }, [user, showNotifs]);

  // Click outside to close
  useEffect(() => {
    const handler = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifs(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfile(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (!user) {
    return (
      <div style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center" }}>
        <Btn variant="secondary" small onClick={onSignIn}>Sign In</Btn>
        <Btn variant="primary" small onClick={onSignIn}>Register →</Btn>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 10, marginLeft: "auto", alignItems: "center" }}>
      {/* Notification bell */}
      <div ref={notifRef} style={{ position: "relative" }}>
        <button onClick={() => { setShowNotifs(s => !s); setShowProfile(false); }} style={{
          background: showNotifs ? `${C.amber}15` : "transparent",
          border: `1px solid ${showNotifs ? C.amber + "44" : C.border}`,
          borderRadius: 6, padding: "5px 9px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4, position: "relative",
        }}>
          <span style={{ fontSize: 14 }}>🔔</span>
          {notifCount > 0 && (
            <span style={{
              position: "absolute", top: -4, right: -4,
              background: C.red, color: "#fff", fontSize: 8, borderRadius: 10,
              padding: "1px 5px", fontWeight: 800, fontFamily: "'DM Mono',monospace",
              minWidth: 16, textAlign: "center",
            }}>{notifCount > 9 ? "9+" : notifCount}</span>
          )}
        </button>
        {showNotifs && <NotifCenter user={user} onClose={() => setShowNotifs(false)} />}
      </div>

      {/* Avatar + dropdown */}
      <div ref={profileRef} style={{ position: "relative" }}>
        <button onClick={() => { setShowProfile(s => !s); setShowNotifs(false); }} style={{
          display: "flex", alignItems: "center", gap: 8,
          background: showProfile ? `${C.amber}15` : "transparent",
          border: `1px solid ${showProfile ? C.amber + "44" : C.border}`,
          borderRadius: 6, padding: "4px 10px 4px 5px", cursor: "pointer",
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: "50%",
            background: `linear-gradient(135deg,${C.amber},#f97316)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 800, color: "#07090f",
          }}>{user.avatar}</div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: "'DM Mono',monospace", lineHeight: 1.2 }}>{user.name.split(" ")[0]}</div>
            {user.org && <div style={{ fontSize: 8, color: C.purple, fontFamily: "'DM Mono',monospace" }}>🏢 {user.org}</div>}
          </div>
          <span style={{ fontSize: 8, color: C.dim }}>{showProfile ? "▾" : "▸"}</span>
        </button>
        {showProfile && (
          <ProfileDropdown user={user} onSignOut={onSignOut} onClose={() => setShowProfile(false)} />
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════ */
export {
  AuthModal,
  AuthGate,
  UserHeaderBar,
  NotifCenter,
  getSession,
  saveSession,
  clearSession,
  addNotif,
};
