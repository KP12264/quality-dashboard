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
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No target history yet — dates before ${TARGET_DAILY_RULE_EFFECTIVE_DATE} use the default of ${DEFAULT_TARGET_PER_SHIFT_PCS['DAY']} pcs/shift; from that date the daily target (≤${DAILY_TARGET_PCS} pcs/day) applies instead.</td></tr>`;
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

  // ---- Users & Roles (qdUsers) ----------------------------------------------
  // Admin-only list/edit of Quality Dashboard roles, through QDAuth (js/qd-auth.js).
  // Firestore Rules allow these reads/writes only to an active QD admin.

  function usersStatus(kind, text) {
    const el = $('usersStatus');
    el.className = 'qd-form-message ' + kind;
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }
  function userMessage(kind, text) {
    const el = $('userMessage');
    el.className = 'qd-form-message ' + kind;
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }
  function slotLabel(k) { const [l, s] = k.split('_'); return `Door ${l} ${s === 'DAY' ? 'Day' : 'Night'}`; }

  function renderSlotBoxes(selected) {
    $('uSlots').innerHTML = QDAuth.ALL_SLOTS.map(k =>
      `<label style="display:inline-flex;align-items:center;gap:6px;min-height:36px;"><input type="checkbox" value="${k}"${selected.includes(k) ? ' checked' : ''}> ${slotLabel(k)}</label>`).join('');
  }

  async function loadUsers() {
    const body = $('usersBody');
    body.innerHTML = '<tr class="empty-row"><td colspan="7">Loading…</td></tr>';
    try {
      const users = await QDAuth.listUsers();
      body.innerHTML = users.length ? users.map(u => `
        <tr>
          <td>${escapeHtml(u.email.replace(QD_EMPLOYEE_EMAIL_DOMAIN, '').toUpperCase())}</td>
          <td>${escapeHtml(u.displayName || '–')}</td>
          <td>${escapeHtml(u.role)}</td>
          <td>${u.role === 'leader' ? escapeHtml((u.slots || []).map(slotLabel).join(', ') || '–') : 'All'}</td>
          <td>${u.active ? 'Active' : 'Disabled'}</td>
          <td>${escapeHtml(u.updatedBy ? u.updatedBy.replace(QD_EMPLOYEE_EMAIL_DOMAIN, '').toUpperCase() : '–')}</td>
          <td><button type="button" class="mini-add-btn" data-edit="${escapeHtml(u.email)}">Edit</button></td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No Quality Dashboard users yet.</td></tr>';
      body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
        const u = users.find(x => x.email === b.dataset.edit);
        $('uCode').value = u.email.replace(QD_EMPLOYEE_EMAIL_DOMAIN, '').toUpperCase();
        $('uName').value = u.displayName || '';
        $('uRole').value = u.role;
        $('uActive').value = u.active ? 'true' : 'false';
        renderSlotBoxes(u.slots || []);
        syncSlotField();
        $('uCode').focus();
      }));
    } catch (e) {
      console.error('Quality Dashboard: could not load users:', e);
      body.innerHTML = '<tr class="empty-row"><td colspan="7">Could not load users: ' + escapeHtml(e.message || String(e)) + '</td></tr>';
    }
  }

  function syncSlotField() { $('uSlotsField').hidden = $('uRole').value !== 'leader'; }

  function refreshUsersTab() {
    if (typeof QDAuth === 'undefined' || window.qdAuthMode !== 'enforce') {
      $('usersPanel').hidden = true;
      usersStatus('info', 'Sign-in is off on this site (QD_AUTH_MODE = "off" in js/config.js), so every page works as before and roles are not used yet. Roles are switched on only after the Firestore Security Rules are approved and published.');
      return;
    }
    const st = QDAuth.getState();
    if (!st.ready || st.checking) { $('usersPanel').hidden = true; usersStatus('info', 'Checking sign-in…'); return; }
    if (!QDAuth.can('users.manage')) {
      $('usersPanel').hidden = true;
      usersStatus('info', st.user ? 'Only a Quality Dashboard admin can manage users.' : 'Sign in as a Quality Dashboard admin to manage users.');
      return;
    }
    usersStatus('', '');
    $('usersPanel').hidden = false;
    loadUsers();
  }

  function wireUsersTab() {
    renderSlotBoxes([]);
    syncSlotField();
    $('uRole').addEventListener('change', syncSlotField);
    $('userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('uSave');
      btn.disabled = true;
      try {
        const email = await QDAuth.saveUser({
          code: $('uCode').value,
          displayName: $('uName').value,
          role: $('uRole').value,
          active: $('uActive').value === 'true',
          slots: Array.from($('uSlots').querySelectorAll('input:checked')).map(i => i.value)
        });
        userMessage('success', '✓ Saved ' + email.replace(QD_EMPLOYEE_EMAIL_DOMAIN, '').toUpperCase());
        loadUsers();
      } catch (err) {
        userMessage('error', '⚠ ' + (err && err.message ? err.message : String(err)));
      } finally {
        btn.disabled = false;
      }
    });
    if (typeof QDAuth !== 'undefined') QDAuth.onChange(refreshUsersTab);
    refreshUsersTab();
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
    wireUsersTab();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
