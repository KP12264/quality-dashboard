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
