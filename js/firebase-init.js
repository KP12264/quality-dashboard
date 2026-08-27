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
 * ------------------------------------------------------------------
 */

window.qdDb = null;
window.qdFirebaseError = null;

(function initFirebase() {
  try {
    if (typeof firebase === "undefined") {
      window.qdFirebaseError = "Firebase SDK failed to load (script blocked or offline).";
      return;
    }
    // Named app instance so this never collides with any other Firebase
    // app instance that might be running on the same page/browser.
    const app = firebase.initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
    window.qdDb = firebase.firestore(app);
  } catch (e) {
    console.error("Quality Dashboard: Firebase init failed:", e);
    window.qdFirebaseError = "Could not connect to Firebase: " + (e && e.message ? e.message : String(e));
  }
})();
