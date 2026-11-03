/**
 * firebase-init.js
 * ------------------------------------------------------------------
 * Initializes a Firebase app instance dedicated to this dashboard and
 * exposes a single Firestore handle (`window.qdDb`) for the data
 * adapter to use.
 *
 * This dashboard is READ ONLY against the existing production system.
 * Nothing in this file calls .set() / .update() / .add() / .delete().
 * Only js/data-adapter.js talks to Firestore, and only with .get().
 *
 * Sign-in (Shift Scrap Close, Phase 1):
 *   window.qdAuthMode  "off" | "enforce"  (QD_AUTH_MODE in config.js)
 *   window.qdAuth      Firebase Auth for this app, or null when off
 *   window.qdEmulator  true only in local test mode: the page was opened on
 *                      localhost with ?qdEmulator=1. The app is then created
 *                      with the "demo-" project id and wired to the Firebase
 *                      Emulator, so nothing can reach the real project.
 *   window.qdGuardWrite(action, ctx)  every adapter calls this before a
 *                      write. Off: returns {} (no change to the write). Enforce:
 *                      throws a "permission" error when the signed-in role may
 *                      not do it, else returns { email } to stamp createdBy /
 *                      updatedBy. Client-side only — Firestore Rules decide.
 * ------------------------------------------------------------------
 */

window.qdDb = null;
window.qdFirebaseError = null;
window.qdAuth = null;
window.qdEmulator = false;
window.qdAuthMode = (typeof QD_AUTH_MODE === "string" ? QD_AUTH_MODE : "off");
// First date on which shift closes drive the daily target (null = never). See config.js.
window.qdCloseRequiredFrom = null;

(function initFirebase() {
  try {
    if (window.QD_RETIRED_PAGE) {   // retired page copy (js/retired-page.js): never connect
      window.qdFirebaseError = "This page has moved: " + window.QD_RETIRED_PAGE;
      return;
    }
    if (typeof firebase === "undefined") {
      window.qdFirebaseError = "Firebase SDK failed to load (script blocked or offline).";
      return;
    }
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    window.qdEmulator = isLocal && new URLSearchParams(location.search).get("qdEmulator") === "1";
    const config = window.qdEmulator
      ? Object.assign({}, FIREBASE_CONFIG, { projectId: QD_EMULATOR.projectId, apiKey: "demo-api-key", authDomain: "localhost" })
      : FIREBASE_CONFIG;
    if (window.qdEmulator) window.qdAuthMode = "enforce";
    // Local test mode only: ?qdAuthMode=off runs the page exactly as the live site does today
    // (sign-in off) against the emulator, to test the old behaviour under each rules version.
    if (window.qdEmulator && new URLSearchParams(location.search).get("qdAuthMode") === "off") window.qdAuthMode = "off";

    // Named app instance so this never collides with any other Firebase
    // app instance that might be running on the same page/browser.
    const app = firebase.initializeApp(config, FIREBASE_APP_NAME);
    window.qdDb = firebase.firestore(app);
    if (window.qdEmulator) window.qdDb.useEmulator(QD_EMULATOR.firestoreHost, QD_EMULATOR.firestorePort);

    if (window.qdAuthMode === "enforce") {
      if (typeof firebase.auth !== "function") {
        window.qdFirebaseError = "Firebase Auth SDK failed to load — sign-in is unavailable.";
      } else {
        window.qdAuth = firebase.auth(app);
        if (window.qdEmulator) window.qdAuth.useEmulator(QD_EMULATOR.authUrl, { disableWarnings: true });
      }
    }
    // Shift Close drives the daily target only while sign-in is enforced (only then are closes
    // written). Local test mode may set the date with ?qdCloseFrom=YYYY-MM-DD.
    let closeFrom = typeof QD_CLOSE_REQUIRED_FROM === "string" ? QD_CLOSE_REQUIRED_FROM : null;
    const testFrom = new URLSearchParams(location.search).get("qdCloseFrom");
    if (window.qdEmulator && /^\d{4}-\d{2}-\d{2}$/.test(testFrom || "")) closeFrom = testFrom;
    window.qdCloseRequiredFrom = window.qdAuthMode === "enforce" && closeFrom ? closeFrom : null;
    // Operations tab write lock (config, or ?qdOpsWrite=1 in local emulator test mode only).
    window.qdOpsWrite = window.qdAuthMode === "enforce"
      && ((typeof QD_OPS_WRITE_ENABLED === "boolean" && QD_OPS_WRITE_ENABLED) || (window.qdEmulator && new URLSearchParams(location.search).get("qdOpsWrite") === "1"));
  } catch (e) {
    console.error("Quality Dashboard: Firebase init failed:", e);
    window.qdFirebaseError = "Could not connect to Firebase: " + (e && e.message ? e.message : String(e));
  }
})();

// Client-side write gate (see header). Fails closed in "enforce" mode when the
// sign-in module is missing, e.g. on an old page copy that does not load it.
window.qdGuardWrite = function (action, ctx) {
  if (window.qdAuthMode !== "enforce") return {};
  if (!window.QDAuth) {
    const err = new Error("Sign-in is required to save, but the sign-in module is not loaded on this page.");
    err.code = "qd/permission-denied";
    throw err;
  }
  return window.QDAuth.assertCan(action, ctx || {});
};

// Free-text fields end up in publicly readable documents (Phase 8, policy pending G4): while sign-in is
// enforced, remind people not to type names or employee codes there. No effect with sign-in "off".
window.qdPrivacyHint = function (ids) {
  if (window.qdAuthMode !== "enforce") return;
  const apply = () => ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.qdPrivacyHint) return;
    el.dataset.qdPrivacyHint = "1";
    el.placeholder = (el.placeholder ? el.placeholder + " — " : "") + "no names or employee codes (visible to everyone)";
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
};

// Cutover message (Phase 8). After the new rules are published, a page still running with sign-in
// "off" (opened before the switch) is refused by Firestore. Instead of a raw error, tell the user to
// reload — the reloaded page asks them to sign in. Returns null when the error is something else.
window.qdCutoverMessage = function (err) {
  const code = String((err && (err.code || err.message)) || "");
  if (window.qdAuthMode === "enforce" || !/permission/i.test(code)) return null;
  return "This page is out of date: saving now requires signing in. Your entries are kept — reload the page (Ctrl+F5 / pull to refresh) and sign in. · หน้านี้เป็นเวอร์ชันเก่า การบันทึกต้องเข้าสู่ระบบแล้ว ข้อมูลที่กรอกยังอยู่ — กรุณารีโหลดหน้าแล้วเข้าสู่ระบบ";
};

