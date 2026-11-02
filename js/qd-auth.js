/**
 * qd-auth.js
 * ------------------------------------------------------------------
 * Sign-in and Quality Dashboard roles (Shift Scrap Close, Phase 1).
 *
 * Accounts: the SAME Firebase Auth accounts as Production V2 — employees sign
 * in with their employee code, which becomes "<code>@prodv2.local" exactly
 * like production-v2/js/auth-v2.js. There is no sign-up here either.
 *
 * Roles: qdUsers/{email} (email = lowercase "<code>@prodv2.local"), separate
 * from Production V2's prodV2_authorizedUsers, so being allowed to write in
 * one system never grants anything in the other.
 *   { role: "admin" | "leader" | "viewer", active: true,
 *     displayName: "…", slots: ["A_DAY", "A_NIGHT"],   // Leader's Line_Shift
 *     updatedAt, updatedBy }
 *
 * Security: every check in this file is a convenience for the UI. The real
 * boundary is Firestore Security Rules (emulator/firestore.rules), which use
 * the same matrix. In QD_AUTH_MODE "off" this file does nothing at all.
 *
 * Exposed as window.QDAuth in the browser; the pure parts (permission matrix,
 * canRole, codeToEmail) are also exported for Node unit tests.
 * ------------------------------------------------------------------
 */
(function (root) {
  const ROLES = ["admin", "leader", "viewer"];
  const SLOT_LINES = ["A", "B", "C"];
  const SLOT_SHIFTS = ["DAY", "NIGHT"];
  const ALL_SLOTS = SLOT_LINES.flatMap(l => SLOT_SHIFTS.map(s => `${l}_${s}`));

  // Who may do what. true = always, false = never, "slot" = only on the Leader's
  // assigned Line_Shift slots. Mirrored by emulator/firestore.rules.
  const PERMISSIONS = {
    "scrap.write":        { admin: true, leader: "slot", viewer: false },   // add / edit / delete one scrap log
    "scrap.import":       { admin: true, leader: false,  viewer: false },   // Excel import (batch, many slots)
    "mapping.write":      { admin: true, leader: false,  viewer: false },   // Excel model mapping
    "targetMaster.write": { admin: true, leader: false,  viewer: false },
    "improvement.write":  { admin: true, leader: true,   viewer: false },
    "weeklyPlan.write":   { admin: true, leader: true,   viewer: false },
    "users.manage":       { admin: true, leader: false,  viewer: false }
  };

  const ACTION_LABEL = {
    "scrap.write": "save scrap records",
    "scrap.import": "import scrap from Excel",
    "mapping.write": "save model mappings",
    "targetMaster.write": "change targets",
    "improvement.write": "save improvements",
    "weeklyPlan.write": "save weekly plans",
    "users.manage": "manage users"
  };

  function slotKey(line, shift) { return `${line}_${shift}`; }

  function codeToEmail(code, domain) {
    return String(code || "").trim().toLowerCase().replace(/\s+/g, "") + (domain || "@prodv2.local");
  }

  // ctx for "slot" actions: { line, shift } and, when a record moves, { fromLine, fromShift }.
  // Without a slot (e.g. delete by id) a Leader with any slot passes here; the rules check the
  // stored record.
  function canRole(profile, action, ctx) {
    if (!profile || profile.active !== true || !ROLES.includes(profile.role)) return false;
    const rule = PERMISSIONS[action];
    if (!rule) return false;
    const allowed = rule[profile.role];
    if (allowed === true) return true;
    if (allowed !== "slot") return false;
    const slots = Array.isArray(profile.slots) ? profile.slots : [];
    if (!ctx || !ctx.line || !ctx.shift) return slots.length > 0;
    const needed = [slotKey(ctx.line, ctx.shift)];
    if (ctx.fromLine && ctx.fromShift) needed.push(slotKey(ctx.fromLine, ctx.fromShift));
    return needed.every(k => slots.includes(k));
  }

  function describeProfile(profile) {
    if (!profile) return "No Quality Dashboard role";
    if (profile.active !== true) return "Account disabled";
    const role = profile.role.charAt(0).toUpperCase() + profile.role.slice(1);
    if (profile.role !== "leader") return role;
    const slots = (profile.slots || []).map(k => { const [l, s] = k.split("_"); return `${l} ${s === "DAY" ? "Day" : "Night"}`; });
    return `${role}${slots.length ? " · " + slots.join(", ") : " · no line assigned"}`;
  }

  const pure = { ROLES, ALL_SLOTS, PERMISSIONS, canRole, codeToEmail, slotKey, describeProfile };
  if (typeof module !== "undefined" && module.exports) module.exports = pure;
  if (typeof window === "undefined") return;

  // ================= Browser =================
  const state = { ready: false, checking: false, user: null, email: null, profile: null, profileError: null };
  const listeners = [];
  const enforce = () => window.qdAuthMode === "enforce";
  const domain = typeof QD_EMPLOYEE_EMAIL_DOMAIN === "string" ? QD_EMPLOYEE_EMAIL_DOMAIN : "@prodv2.local";
  const usersCollection = typeof QD_USERS_COLLECTION === "string" ? QD_USERS_COLLECTION : "qdUsers";

  function permissionError(message) {
    const e = new Error(message);
    e.code = "qd/permission-denied";
    return e;
  }

  function notify() { listeners.forEach(cb => { try { cb(getState()); } catch (e) { console.error(e); } }); render(); }
  function getState() { return { enabled: enforce(), emulator: !!window.qdEmulator, ready: state.ready, checking: state.checking, user: state.user, email: state.email, profile: state.profile, profileError: state.profileError }; }

  async function loadProfile(email) {
    const snap = await window.qdDb.collection(usersCollection).doc(email).get();
    return snap.exists ? snap.data() : null;
  }

  function init() {
    if (!enforce()) { state.ready = true; return; }
    if (!window.qdAuth) { state.ready = true; state.profileError = window.qdFirebaseError || "Sign-in is unavailable."; render(); return; }
    window.qdAuth.onAuthStateChanged(async user => {
      state.user = user; state.email = user && user.email ? user.email.toLowerCase() : null;
      state.profile = null; state.profileError = null;
      // While the role is being read, show "checking" — never "no role" — and refuse writes.
      state.checking = !!state.email;
      notify();
      if (state.email) {
        try { state.profile = await loadProfile(state.email); }
        catch (e) { console.error("Quality Dashboard: could not read the user role:", e); state.profileError = "Could not read your role."; }
      }
      state.checking = false;
      state.ready = true;
      notify();
    });
  }

  function signInErrorText(e) {
    const code = (e && e.code) || "";
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) return "Employee code or password is incorrect.";
    if (/too-many-requests/.test(code)) return "Too many attempts. Wait a moment and try again.";
    if (/network-request-failed/.test(code)) return "No connection to the sign-in service.";
    return (e && e.message) || "Sign-in failed.";
  }

  async function signIn(code, password) {
    if (!window.qdAuth) throw new Error("Sign-in is unavailable.");
    return window.qdAuth.signInWithEmailAndPassword(codeToEmail(code, domain), password);
  }
  async function signOut() { if (window.qdAuth) await window.qdAuth.signOut(); }

  // Throws before a write the signed-in role may not make; returns { email } to stamp the write.
  function assertCan(action, ctx) {
    if (!enforce()) return {};
    const what = ACTION_LABEL[action] || action;
    if (!state.user) throw permissionError(`Sign in with your employee code to ${what}.`);
    if (state.checking) throw permissionError("Your role is still being checked. Try again in a moment.");
    if (state.profileError) throw permissionError(state.profileError + " Try again, or sign out and sign in.");
    if (!state.profile) throw permissionError(`Your account has no Quality Dashboard role yet, so you cannot ${what}. Ask a Quality Dashboard admin.`);
    if (!canRole(state.profile, action, ctx)) {
      const where = ctx && ctx.line && ctx.shift ? ` for Door ${ctx.line} · ${ctx.shift === "DAY" ? "Day" : "Night"}` : "";
      throw permissionError(`Your role (${describeProfile(state.profile)}) cannot ${what}${where}.`);
    }
    return { email: state.email };
  }

  function can(action, ctx) { return !enforce() || canRole(state.profile, action, ctx); }

  // ---- Admin: qdUsers management (rules: admin only) ----
  async function listUsers() {
    assertCan("users.manage");
    const snap = await window.qdDb.collection(usersCollection).get();
    const out = []; snap.forEach(d => out.push(Object.assign({ email: d.id }, d.data())));
    return out.sort((a, b) => a.email.localeCompare(b.email));
  }
  async function saveUser({ code, displayName, role, slots, active }) {
    const who = assertCan("users.manage");
    const email = codeToEmail(code, domain);
    if (!String(code || "").trim()) throw new Error("Enter an employee code.");
    if (!ROLES.includes(role)) throw new Error("Choose a role.");
    const cleanSlots = role === "leader" ? (slots || []).filter(k => ALL_SLOTS.includes(k)) : [];
    if (role === "leader" && cleanSlots.length === 0) throw new Error("Choose at least one Line and Shift for a Leader.");
    await window.qdDb.collection(usersCollection).doc(email).set({
      role, active: active !== false, displayName: String(displayName || "").trim().slice(0, 80), slots: cleanSlots,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: who.email
    });
    return email;
  }

  // ---- Widget ----
  let host = null, open = false, busy = false, lastError = "";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function injectStyle() {
    if (document.getElementById("qdAuthStyle")) return;
    const st = document.createElement("style");
    st.id = "qdAuthStyle";
    st.textContent = `
      .qd-auth{font:500 13px/1.4 var(--font-body, system-ui, sans-serif);color:#3E4B5B;margin:12px;padding:10px 12px;border:1px solid #E3E9F1;border-radius:12px;background:#F8FAFC;display:grid;gap:8px}
      .qd-auth.in-nav{margin:0 0 0 auto;padding:6px 10px;background:#fff;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .qd-auth b{color:#16212E;font-weight:600}
      .qd-auth small{display:block;color:#5E6B7A;font-size:12px}
      .qd-auth button{font:inherit;font-weight:600;border-radius:8px;min-height:36px;padding:0 12px;cursor:pointer;border:1px solid #C9DAF6;background:#E8F0FD;color:#1F62D6}
      .qd-auth button.primary{background:#1F62D6;border-color:#1F62D6;color:#fff}
      .qd-auth form{display:grid;gap:6px}
      .qd-auth input{font:inherit;min-height:36px;border:1px solid #D5DCE5;border-radius:8px;padding:0 10px;min-width:0}
      .qd-auth .err{color:#A3243A;font-size:12px}
      .qd-auth .warn{color:#9A4F07;font-size:12px}
      .qd-auth-emu{position:fixed;left:0;right:0;bottom:0;z-index:1000;background:#7A2E00;color:#fff;font:600 12px/1.4 system-ui,sans-serif;text-align:center;padding:4px 8px calc(4px + env(safe-area-inset-bottom,0px))}
    `;
    document.head.appendChild(st);
  }

  function mount() {
    if (!enforce()) return;
    injectStyle();
    if (window.qdEmulator && !document.getElementById("qdAuthEmu")) {
      const b = document.createElement("div"); b.id = "qdAuthEmu"; b.className = "qd-auth-emu";
      b.textContent = "TEST MODE · Firebase Emulator (demo-quality-dashboard) · no real data";
      document.body.appendChild(b);
    }
    host = document.createElement("div");
    host.id = "qdAuthBox";
    const sidebar = document.querySelector(".qd-dashboard-sidebar");
    const nav = document.querySelector("#navRoot .qd-nav");
    if (sidebar) { host.className = "qd-auth"; sidebar.appendChild(host); }
    else if (nav) { host.className = "qd-auth in-nav"; nav.appendChild(host); }
    else { host.className = "qd-auth"; document.body.insertBefore(host, document.body.firstChild); }
    render();
  }

  function render() {
    if (!host) return;
    if (!state.ready) { host.innerHTML = "<small>Checking sign-in…</small>"; return; }
    if (state.user) {
      const code = state.email ? state.email.replace(domain, "").toUpperCase() : "";
      const warn = state.checking ? "" : state.profileError ? `<span class="warn">${esc(state.profileError)}</span>`
        : !state.profile ? '<span class="warn">Read-only in the Quality Dashboard</span>' : "";
      const roleText = state.checking ? "Checking role…" : describeProfile(state.profile);
      host.innerHTML = `<div><b>${esc((state.profile && state.profile.displayName) || code)}</b><small>${esc(code)} · ${esc(roleText)}</small>${warn}</div>
        <button type="button" id="qdAuthSignOut">Sign out</button>`;
      host.querySelector("#qdAuthSignOut").onclick = () => signOut();
      return;
    }
    if (!open) {
      host.innerHTML = `<div><b>Read-only</b><small>Sign in to save changes</small>${state.profileError ? `<span class="err">${esc(state.profileError)}</span>` : ""}</div>
        <button type="button" id="qdAuthOpen">Sign in</button>`;
      host.querySelector("#qdAuthOpen").onclick = () => { open = true; lastError = ""; render(); const i = host.querySelector("#qdAuthCode"); if (i) i.focus(); };
      return;
    }
    host.innerHTML = `<form id="qdAuthForm" novalidate>
        <label for="qdAuthCode"><small>Employee code</small></label>
        <input id="qdAuthCode" autocomplete="username" autocapitalize="characters" required>
        <label for="qdAuthPassword"><small>Password</small></label>
        <input id="qdAuthPassword" type="password" autocomplete="current-password" required>
        ${lastError ? `<span class="err" role="alert">${esc(lastError)}</span>` : ""}
        <button type="submit" class="primary" id="qdAuthSubmit" ${busy ? "disabled" : ""}>${busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" id="qdAuthCancel">Cancel</button>
      </form>`;
    host.querySelector("#qdAuthCancel").onclick = () => { open = false; render(); };
    host.querySelector("#qdAuthForm").onsubmit = async ev => {
      ev.preventDefault();
      const code = host.querySelector("#qdAuthCode").value, pw = host.querySelector("#qdAuthPassword").value;
      if (!code.trim() || !pw) { lastError = "Enter your employee code and password."; render(); return; }
      busy = true; lastError = ""; render();
      try { await signIn(code, pw); open = false; }
      catch (e) { lastError = signInErrorText(e); }
      busy = false; render();
    };
  }

  window.QDAuth = Object.assign({}, pure, {
    init, signIn, signOut, assertCan, can, getState, listUsers, saveUser,
    onChange: cb => { listeners.push(cb); }
  });

  init();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(mount, 0));
  else setTimeout(mount, 0);
})(this);
