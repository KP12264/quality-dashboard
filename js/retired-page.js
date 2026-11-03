/**
 * retired-page.js — loaded FIRST in old page copies that are no longer maintained (Phase 7).
 * <script src="js/retired-page.js" data-to="scrap-entry.html"></script>
 * 1. Marks the page retired: js/firebase-init.js then does not connect to Firebase at all, so the
 *    page can neither read nor write (old copies save scrap without sign-in / ledger).
 * 2. Shows a notice and sends the visitor to the current page (keeping the query string, so
 *    local test mode keeps working). Nothing is deleted; reverting = removing this script tag.
 */
(function () {
  var me = document.currentScript;
  var to = (me && me.getAttribute('data-to')) || 'index.html';
  window.QD_RETIRED_PAGE = to;
  var go = function () { location.replace(to + location.search + location.hash); };   // deep links keep query + hash
  var notice = function () {
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;display:flex;align-items:center;justify-content:center;font:16px/1.6 system-ui,sans-serif;padding:24px;text-align:center;';
    d.innerHTML = '<div><b>This page has moved.</b><br>Opening the current version… If nothing happens, <a href="' + to + location.search + location.hash + '">open it here</a>.<br><small>หน้านี้เป็นเวอร์ชันเก่า กำลังเปิดหน้าปัจจุบัน</small></div>';
    document.body.appendChild(d);
  };
  if (document.body) notice(); else document.addEventListener('DOMContentLoaded', notice);
  if (!window.QD_RETIRED_NO_REDIRECT) go();
})();
