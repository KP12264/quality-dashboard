/**
 * nav.js
 * ------------------------------------------------------------------
 * Shared left sidebar, injected into every page's <div id="navRoot">
 * (which sits inside <div class="qs-shell"> — see css/qs-theme.css).
 * Each page sets `window.CURRENT_PAGE` to one of the NAV_ITEMS keys
 * before this script runs, so the matching link is highlighted.
 * This is the one place the navigation is defined.
 * ------------------------------------------------------------------
 */

(function () {
  const ICONS = {
    dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
    'scrap-entry': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    'scrap-detail': '<path d="M4 6h16M4 12h16M4 18h10"/>',
    'plan-tracking': '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    'weekly-review': '<path d="M6 20V10M12 20V4M18 20v-6"/>',
    improvement: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    'executive-report': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'
  };
  const NAV_ITEMS = [
    { key: "dashboard", label: "Overview", href: "index.html" },
    { key: "scrap-entry", label: "Scrap Entry", href: "scrap-entry.html" },
    { key: "scrap-detail", label: "Scrap Detail", href: "scrap-detail.html" },
    { key: "plan-tracking", label: "Plan & Tracking", href: "plan-tracking.html" },
    { key: "weekly-review", label: "Weekly Review", href: "weekly-review.html" },
    { key: "improvement", label: "Improvement & 4M", href: "improvement.html" },
    { key: "executive-report", label: "Executive Report", href: "executive-report.html" },
    { key: "admin", label: "Admin", href: "admin.html" }
  ];

  function ruleText() {
    const t = typeof DAILY_TARGET_PCS !== 'undefined' ? DAILY_TARGET_PCS : 50;
    let from = '1 Oct 2026';
    if (typeof TARGET_DAILY_RULE_EFFECTIVE_DATE !== 'undefined') {
      const d = new Date(TARGET_DAILY_RULE_EFFECTIVE_DATE + 'T00:00:00Z');
      from = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    return `<b>Target ≤ ${t} pcs/day</b><span>Door A + B + C, Day + Night combined, from ${from}</span>`;
  }

  function renderNav() {
    const root = document.getElementById("navRoot");
    if (!root) return;
    const current = window.CURRENT_PAGE || "";
    root.innerHTML = `
      <nav class="qs-side" aria-label="Main">
        <div class="qs-brand">
          <div><b>Quality System</b><span>Door Foam · Kabinburi</span></div>
          <button type="button" class="qs-side-toggle" id="qsNavToggle" aria-label="Open menu" aria-expanded="false">☰</button>
        </div>
        <div class="qs-links" id="qsNavLinks">
          ${NAV_ITEMS.map(item => `<a href="${item.href}" class="qs-link${item.key === current ? ' on' : ''}"${item.key === current ? ' aria-current="page"' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[item.key] || ''}</svg>${item.label}</a>`).join('')}
        </div>
        <div class="qs-rule">${ruleText()}</div>
      </nav>`;
    const toggle = document.getElementById("qsNavToggle");
    const links = document.getElementById("qsNavLinks");
    if (toggle && links) {
      toggle.addEventListener("click", () => {
        const open = links.classList.toggle("open");
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderNav);
  } else {
    renderNav();
  }
})();
