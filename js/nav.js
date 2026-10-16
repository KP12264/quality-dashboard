/**
 * nav.js
 * ------------------------------------------------------------------
 * Shared top navigation, injected into every page's <div id="navRoot">.
 * Each page sets `window.CURRENT_PAGE` (a string matching one of the
 * NAV_ITEMS keys below) before this script runs, so the matching link
 * gets the "active" state. This is the one place the 6-page nav
 * structure is defined, so every page stays in sync automatically.
 * ------------------------------------------------------------------
 */

(function () {
  const NAV_ITEMS = [
    { key: "dashboard", label: "Dashboard", href: "index.html" },
    { key: "scrap-entry", label: "Scrap Entry", href: "scrap-entry.html" },
    { key: "scrap-detail", label: "Scrap Detail", href: "scrap-detail.html" },
    { key: "improvement", label: "Improvement", href: "improvement.html" },
    { key: "executive-report", label: "Executive Report", href: "executive-report.html" },
    { key: "admin", label: "Admin", href: "admin.html" }
  ];

  function renderNav() {
    const root = document.getElementById("navRoot");
    if (!root) return;
    const current = window.CURRENT_PAGE || "";
    root.innerHTML = `
      <nav class="qd-nav">
        <div class="qd-nav-brand">Quality System</div>
        <button class="qd-nav-toggle" id="qdNavToggle" aria-label="Toggle menu">☰</button>
        <div class="qd-nav-links" id="qdNavLinks">
          ${NAV_ITEMS.map(item => `<a href="${item.href}" class="qd-nav-link${item.key === current ? ' active' : ''}">${item.label}</a>`).join('')}
        </div>
      </nav>`;
    const toggle = document.getElementById("qdNavToggle");
    const links = document.getElementById("qdNavLinks");
    if (toggle && links) {
      toggle.addEventListener("click", () => links.classList.toggle("open"));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderNav);
  } else {
    renderNav();
  }
})();
