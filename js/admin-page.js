/**
 * admin-page.js
 * ------------------------------------------------------------------
 * Page 6 — Admin / Master Data. Only Target Management is wired to
 * Firestore in this phase (via js/target-adapter.js, which already
 * existed and is already covered by offline tests). Every other tab
 * (Line/Model/Defect Master, Defect Mapping, 4M Master, Audit Log,
 * Permission/PIN) is a static placeholder — no Firestore calls, no
 * collections created for them yet. See each tab's placeholder text
 * for what's deferred and why.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }
  function showBanner(kind, message) {
    const el = $('connectionBanner');
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }

  // ---- Tabs ---------------------------------------------------------------

  function switchTab(tab) {
    $('adminTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.qd-admin-section').forEach(sec => {
      sec.style.display = sec.id === 'tab-' + tab ? '' : 'none';
    });
  }

  // ---- Target Management (functional) --------------------------------------

  async function loadTargets() {
    const tbody = $('targetTableBody');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading…</td></tr>';
    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Data unavailable.</td></tr>';
      return;
    }
    try {
      const [day, night] = await Promise.all(SHIFTS.map(s => TargetAdapter.getTargetHistory(window.qdDb, s.code)));
      const all = day.map(r => ({ ...r })).concat(night.map(r => ({ ...r })));
      all.sort((a, b) => (b.effectiveDate || '') < (a.effectiveDate || '') ? -1 : 1);
      if (all.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No target history yet — using the default of ${DEFAULT_TARGET_PER_SHIFT_PCS['เช้า']} pcs/shift for both shifts until a target is added below.</td></tr>`;
        return;
      }
      tbody.innerHTML = all.map(r => `
        <tr>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td class="num">${fmt(r.targetQty)}</td>
          <td>${escapeHtml(r.effectiveDate)}</td>
          <td>${escapeHtml(r.note || '–')}</td>
        </tr>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load target history:', e);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Could not load target history.</td></tr>';
    }
  }

  function showTargetMessage(kind, text) {
    const el = $('targetMessage');
    el.className = 'qd-form-message ' + kind;
    el.textContent = text;
    el.style.display = 'block';
  }

  $('targetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('targetMessage').style.display = 'none';
    const payload = {
      shift: $('tShift').value,
      targetQty: $('tQty').value,
      effectiveDate: $('tEffectiveDate').value,
      note: $('tNote').value
    };
    if (!payload.effectiveDate || !(parseFloat(payload.targetQty) > 0)) {
      showTargetMessage('error', 'Enter a Target Qty greater than 0 and an Effective Date.');
      return;
    }
    try {
      await TargetAdapter.setTarget(window.qdDb, payload);
      showTargetMessage('success', `Saved: ${shiftLabel(payload.shift)} shift target = ${payload.targetQty} pcs, effective ${payload.effectiveDate}.`);
      $('tQty').value = '';
      $('tNote').value = '';
      loadTargets();
    } catch (err) {
      console.error('Quality Dashboard: failed to save target:', err);
      showTargetMessage('error', '⚠ Could not save: ' + (err && err.message ? err.message : String(err)));
    }
  });

  // ---- Read-only master lists (Defect / 4M — from config.js) ---------------

  function renderStaticLists() {
    $('defectMasterList').innerHTML = DEFECT_TYPES.map(d => `<li>${escapeHtml(d)}</li>`).join('');
    $('fourMMasterList').innerHTML = FOUR_M_TYPES.map(m => `<li>${escapeHtml(m)}</li>`).join('');
  }

  // ---- Init ---------------------------------------------------------------

  function init() {
    const today = new Date();
    $('tEffectiveDate').value = today.toISOString().slice(0, 10);

    $('adminTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });

    renderStaticLists();
    loadTargets();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
