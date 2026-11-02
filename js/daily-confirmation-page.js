/**
 * daily-confirmation-page.js — Daily Confirmation matrix (Shift Scrap Close, Phase 3).
 * Door A/B/C × Day/Night for one production date. Everything is in js/shift-close-ui.js;
 * this file only wires the date picker and the mobile sidebar.
 */
(function () {
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function shift(dateStr, days) { const [y, m, d] = dateStr.split('-').map(Number); return fmt(new Date(y, m - 1, d + days)); }

  function init() {
    const sidebar = $('dashboardSidebar'), toggle = $('dashboardMobileToggle'), overlay = $('dashboardSidebarOverlay');
    const set = open => { sidebar.classList.toggle('open', open); overlay.classList.toggle('open', open); toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    toggle.addEventListener('click', () => set(!sidebar.classList.contains('open')));
    overlay.addEventListener('click', () => set(false));
    if (window.qdFirebaseError) { const b = $('connectionBanner'); b.className = 'qd-banner error'; b.textContent = '⚠ ' + window.qdFirebaseError; b.style.display = 'flex'; }

    const qs = new URLSearchParams(location.search);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '') ? qs.get('date') : QDAuth.localToday();   // Thailand date
    $('dcDate').value = date;
    const m = ShiftCloseUI.mountMatrix($('dcMatrix'), $('dcDetail'), date);
    const go = d => {
      $('dcDate').value = d;
      const u = new URL(location.href); u.searchParams.set('date', d); history.replaceState(null, '', u);
      $('dcEntryLink').href = `scrap-entry.html?date=${d}${window.qdEmulator ? '&qdEmulator=1' : ''}`;
      m.setDate(d);
    };
    $('dcEntryLink').href = `scrap-entry.html?date=${date}${window.qdEmulator ? '&qdEmulator=1' : ''}`;
    $('dcDate').addEventListener('change', () => { if ($('dcDate').value) go($('dcDate').value); });
    $('dcPrev').addEventListener('click', () => go(shift($('dcDate').value, -1)));
    $('dcNext').addEventListener('click', () => go(shift($('dcDate').value, 1)));
    $('dcReload').addEventListener('click', () => m.refresh());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
