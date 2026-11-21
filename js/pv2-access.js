/**
 * pv2-access.js
 * ------------------------------------------------------------------
 * Production V2 read access for the Quality Dashboard (Security plan A).
 *
 * Every read of a prodV2_* collection (js/data-adapter.js: fetchOne and
 * fetchPlanDoc) first awaits window.qdPv2Access(). It resolves when:
 *   - someone is signed in with the SAME Firebase Auth account as Production
 *     V2 ("<code>@prodv2.local"), and
 *   - their OWN prodV2_authorizedUsers/{email} document grants a Production
 *     V2 role: an explicit "viewer" or "editor" (no role / any other value = no access).
 * A missing document or active:false means no access; the read is then
 * refused with a permission error, which the pages already show as a read
 * error. Production V2's own Firestore Rules enforce the same.
 *
 * Sign-in "off" (live site today): while signed out, a small sign-in bar
 * appears at the top of the page. It is removed once access is granted,
 * leaving the page exactly as before.
 * Sign-in "enforce": the Quality Dashboard's own sign-in (window.qdAuth)
 * is used; no second form is shown.
 *
 * Fails closed: without the Firebase Auth SDK, prodV2_* reads are refused.
 * Pages that never read prodV2_* never start this (it is lazy). Quality
 * Dashboard collections and roles (qdUsers) are not touched.
 * ------------------------------------------------------------------
 */
(function () {
  const ALLOWLIST = "prodV2_authorizedUsers";
  const DOMAIN = typeof QD_EMPLOYEE_EMAIL_DOMAIN === "string" ? QD_EMPLOYEE_EMAIL_DOMAIN : "@prodv2.local";
  const state = { started: false, role: null, denied: null, user: null, reason: "read" };
  let waiters = [], auth = null;
  const watchers = [];
  function notify() { const r = state.role; watchers.slice().forEach(cb => { try { cb(r); } catch (e) { console.error(e); } }); applyNeeds(document); }
  // Controls that need a role carry data-qd-need="viewer" | "editor": disabled (same look, with a tooltip) until the signed-in
  // account has that role. The Firestore Rules enforce the same; this only keeps people from pressing what would be refused.
  function can(need) { const r = state.role; return need === "editor" ? r === "editor" : (r === "viewer" || r === "editor"); }
  function applyNeeds(root) {
    (root || document).querySelectorAll("[data-qd-need]").forEach(el => {
      const ok = can(el.getAttribute("data-qd-need"));
      if (el.dataset.qdTitle === undefined) el.dataset.qdTitle = el.getAttribute("title") || "";
      el.disabled = !ok; el.setAttribute("aria-disabled", ok ? "false" : "true");
      if (ok) { if (el.dataset.qdTitle) el.setAttribute("title", el.dataset.qdTitle); else el.removeAttribute("title"); }
      else el.setAttribute("title", state.user ? "Needs a Production V2 " + el.getAttribute("data-qd-need") + " account" : "Sign in with a Production V2 account first");
    });
  }

  // Same rule as production-v2/js/auth-v2.js roleOf() and the Firestore Rules: only an explicit viewer / editor counts.
  function roleOf(d) {
    if (!d || d.active === false) return "none";
    const r = d.role == null ? "none" : String(d.role);
    return r === "viewer" || r === "editor" ? r : "none";
  }
  function deny(message) { const e = new Error(message); e.code = "permission-denied"; return e; }
  function getAuth() {
    if (window.qdAuth) return window.qdAuth;                 // "enforce": the Quality Dashboard's own sign-in
    if (auth) return auth;
    if (typeof firebase === "undefined" || typeof firebase.auth !== "function" || !window.qdDb) return null;
    try {
      auth = firebase.auth(firebase.app(FIREBASE_APP_NAME));
      if (window.qdEmulator) auth.useEmulator(QD_EMULATOR.authUrl, { disableWarnings: true });
    } catch (e) { console.error("Quality Dashboard: Production V2 sign-in unavailable", e); auth = null; }
    return auth;
  }
  function settle(fn) { const w = waiters; waiters = []; w.forEach(fn); }

  // ---- sign-in bar ("off" mode only; inline styles so no stylesheet changes) ----
  function removeBar() { const b = document.getElementById("qdPv2Bar"); if (b) b.remove(); }
  function showBar(kind, a) {
    if (window.qdAuthMode === "enforce") return;            // the QD sign-in handles it
    const render = () => {
      let b = document.getElementById("qdPv2Bar");
      if (!b) { b = document.createElement("div"); b.id = "qdPv2Bar"; document.body.insertBefore(b, document.body.firstChild); }
      b.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px;padding:10px 14px;border:1px solid #fed7aa;border-radius:10px;background:#fff7ed;color:#9a3412;font:600 13px/1.4 system-ui,sans-serif";
      const inp = "height:32px;border:1px solid #d1d5db;border-radius:8px;padding:0 10px;font:13px system-ui,sans-serif;width:130px";
      const btn = "height:32px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:700 13px system-ui,sans-serif;padding:0 14px;cursor:pointer";
      const write = state.reason === "write";
      b.innerHTML = kind === "signin"
        ? `<span>🔒 ${write ? "การบันทึก / แก้ไขข้อมูลต้อง Login ด้วยบัญชี Production V2 ก่อน" : "ข้อมูลยอดผลิต (Production V2) ต้อง Login ก่อน"}</span><input id="qdPv2Code" placeholder="รหัสพนักงาน" autocomplete="username" style="${inp}"><input id="qdPv2Pass" type="password" placeholder="Password" autocomplete="current-password" style="${inp}"><button id="qdPv2SignIn" style="${btn}">เข้าสู่ระบบ</button><span id="qdPv2Err" style="color:#dc2626;font-weight:500;flex-basis:100%;display:none"></span>`
        : `<span>🔒 บัญชีนี้ไม่มี role viewer / editor ใน Production V2 ${write ? "จึงบันทึก / แก้ไขไม่ได้" : "จึงดูข้อมูลยอดผลิตไม่ได้"} — ติดต่อผู้ดูแลระบบ</span><button id="qdPv2SignOut" style="${btn}">ออกจากระบบ</button>`;
      if (kind === "signin") {
        const go = async () => {
          const code = document.getElementById("qdPv2Code").value, pw = document.getElementById("qdPv2Pass").value, err = document.getElementById("qdPv2Err");
          if (!code || !pw) { err.textContent = "กรอกรหัสพนักงานและ Password"; err.style.display = ""; return; }
          try { err.style.display = "none"; await a.signInWithEmailAndPassword(String(code).trim().toLowerCase().replace(/\s+/g, "") + DOMAIN, pw); }
          catch (e) { err.textContent = "เข้าสู่ระบบไม่สำเร็จ: " + (e.message || e.code || "unknown error"); err.style.display = ""; }
        };
        document.getElementById("qdPv2SignIn").onclick = go;
        ["qdPv2Code", "qdPv2Pass"].forEach(id => document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") go(); }));
      } else document.getElementById("qdPv2SignOut").onclick = () => a.signOut();
    };
    if (document.body) render(); else document.addEventListener("DOMContentLoaded", render, { once: true });
  }

  function start() {
    if (state.started) return;
    state.started = true;
    const a = getAuth();
    if (!a) { state.denied = deny("Production V2 data needs sign-in, but Firebase Auth is not available on this page."); settle(w => w.reject(state.denied)); return; }
    a.onAuthStateChanged(async user => {
      if (state.user && (!user || user.uid !== state.user.uid) && window.qdAuthMode !== "enforce") { location.reload(); return; }   // account changed: clear what is on screen
      state.user = user || null; state.role = null; state.denied = null;
      if (!user) { showBar("signin", a); notify(); return; }   // reads stay pending until someone signs in
      try {
        const snap = await window.qdDb.collection(ALLOWLIST).doc(String(user.email || "").toLowerCase()).get();   // own document only
        const role = roleOf(snap.exists ? snap.data() : null);
        if (role === "viewer" || role === "editor") { state.role = role; removeBar(); notify(); settle(w => w.resolve(role)); return; }
        state.denied = deny("This account has no Production V2 role (prodV2_authorizedUsers).");
      } catch (e) { state.denied = e && e.code ? e : deny(String(e && e.message || e)); }
      showBar("none", a); notify(); settle(w => w.reject(state.denied));
    });
  }

  // ---- small sign-out button ("off" mode only; the "enforce" sign-in has its own) ----
  // Shown whenever a Production V2 session exists on this device, also on pages that have not
  // read Production V2 data yet, so a shared computer is never left signed in by accident.
  // It lives INSIDE the navigation, never over the page content:
  //   - pages with the left sidebar (Dashboard, Scrap Entry): at the bottom of the sidebar
  //     (the drawer on phones);
  //   - pages with the top bar (Executive Report, Scrap Detail): the last item of the links
  //     (the ☰ menu on phones);
  //   - a page with neither (none today): a small fixed button in the bottom-right corner.
  // No Firestore read. Same look on every page: a small outlined button.
  const BTN_ID = "qdPv2SignOutMini";
  const BTN_BASE = "box-sizing:border-box;height:32px;max-width:100%;padding:0 12px;border:1px solid rgba(100,116,139,.45);border-radius:8px;background:transparent;color:inherit;font:600 12px/30px system-ui,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  function signOutHost() {
    const side = document.getElementById("dashboardSidebar");
    if (side) return { el: side, kind: "sidebar" };
    const links = document.getElementById("qdNavLinks");
    if (links) return { el: links, kind: "topbar" };
    return null;
  }
  function placeSignOut(btn) {
    const h = signOutHost();
    if (h && h.kind === "sidebar") {
      btn.style.cssText = BTN_BASE + "display:block;margin:auto 14px 16px;width:calc(100% - 28px);flex-shrink:0;text-align:center;";
      if (btn.parentNode !== h.el) h.el.appendChild(btn);
    } else if (h) {
      // top bar: exactly one more link (same class, same padding, so the bar does not get taller);
      // an inset ring instead of a border keeps its size identical to the other links
      btn.className = "qd-nav-link";
      btn.style.cssText = "border:0;background:transparent;cursor:pointer;text-align:left;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28);box-sizing:border-box;overflow:hidden;line-height:1.1;";
      if (btn.parentNode !== h.el) h.el.appendChild(btn);
      // Thai text and the emoji give a taller line box than the other links: copy an existing link's height
      const ref = h.el.querySelector("a.qd-nav-link");
      if (ref) { const hh = ref.getBoundingClientRect().height; if (hh) btn.style.height = hh + "px"; btn.style.paddingTop = btn.style.paddingBottom = "0"; btn.style.display = "flex"; btn.style.alignItems = "center"; }
    } else {
      btn.style.cssText = BTN_BASE + "position:fixed;right:12px;bottom:12px;z-index:9000;background:#fff;color:#374151;box-shadow:0 1px 3px rgba(0,0,0,.12);";
      if (btn.parentNode !== document.body) document.body.appendChild(btn);
    }
    return !!h;
  }
  // Top bar only: if the full label would push the last link onto a second row (the bar is tight at about
  // 800–890 px), show just the lock (the label stays in the tooltip and aria-label). Re-checked on resize.
  function fitTopBar(btn) {
    const host = btn.parentElement, nav = host && host.closest(".qd-nav");
    if (!nav || !btn.classList.contains("qd-nav-link") || host.offsetParent === null) return;
    btn.textContent = "🔒 ออกจากระบบ"; btn.style.paddingLeft = btn.style.paddingRight = "";
    const shown = btn.style.display; btn.style.display = "none"; const base = nav.offsetHeight; btn.style.display = shown;
    if (nav.offsetHeight > base) { btn.textContent = "🔒"; btn.style.paddingLeft = btn.style.paddingRight = "10px"; }
  }
  let fitTimer = null;
  window.addEventListener("resize", () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { const b = document.getElementById(BTN_ID); if (b) fitTopBar(b); }, 150); });
  function watchSession() {
    if (window.qdAuthMode === "enforce" || window.QD_RETIRED_PAGE) return;
    const a = getAuth();
    if (!a) return;
    let had = false, obs = null;
    a.onAuthStateChanged(user => {
      let b = document.getElementById(BTN_ID);
      if (!user) { if (obs) obs.disconnect(); if (b) b.remove(); if (had) location.reload(); return; }   // signed out: reload, nothing kept on screen
      had = true;
      if (!b) {
        b = document.createElement("button");
        b.id = BTN_ID; b.type = "button";
        b.onclick = () => { b.disabled = true; a.signOut(); };
      }
      const code = String(user.email || "").replace(DOMAIN, "").toUpperCase();
      b.dataset.code = code;
      b.title = "Sign out of Production V2 on this device (" + code + ")";
      b.setAttribute("aria-label", "ออกจากระบบ " + code);
      // the navigation can be built a moment later (nav.js): keep looking until it is there, then stop
      const placed = placeSignOut(b);
      b.textContent = (signOutHost() && signOutHost().kind === "sidebar") ? "🔒 " + code + " · ออกจากระบบ" : "🔒 ออกจากระบบ";   // sidebar has room for the account; the top bar stays short
      fitTopBar(b);
      if (!placed && document.body) {
        if (obs) obs.disconnect();
        obs = new MutationObserver(() => { const h = signOutHost(); if (h) { obs.disconnect(); placeSignOut(b); b.textContent = h.kind === "sidebar" ? "🔒 " + code + " · ออกจากระบบ" : "🔒 ออกจากระบบ"; fitTopBar(b); } });
        obs.observe(document.body, { childList: true, subtree: true });
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchSession, { once: true }); else watchSession();

  window.qdPv2Access = function () {
    if (state.role) return Promise.resolve(state.role);
    if (state.denied) return Promise.reject(state.denied);
    return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); start(); });
  };
  window.qdPv2Role = () => state.role;
  // For pages that WRITE: starts the sign-in (bar when signed out) and calls cb(role | null) now and whenever it changes.
  window.qdPv2Watch = function (cb, opts) { if (opts && opts.reason) state.reason = opts.reason; if (typeof cb === "function") watchers.push(cb); start(); if (typeof cb === "function") cb(state.role); applyNeeds(document); };
  window.qdPv2Can = can;
  window.qdPv2Apply = applyNeeds;
  window.qdPv2RoleOf = roleOf;
})();
