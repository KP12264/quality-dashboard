/**
 * shift-close-ui.js
 * ------------------------------------------------------------------
 * Shift Scrap Close UI (Phase 3): the close panel (Scrap Entry), the confirm sheet and the
 * Daily Confirmation matrix (daily-confirmation.html). Uses js/shift-close.js for status and
 * the close transaction; Firestore Rules are the real permission check, the buttons here only
 * reflect them.
 *
 * Runs only while sign-in is enforced (QD_AUTH_MODE "enforce" / local emulator). With sign-in
 * "off" the panel stays hidden and the matrix page shows a "not enabled" notice, so nothing
 * here reaches real users before approval.
 * ------------------------------------------------------------------
 */
(function () {
  const SC = window.ShiftClose;
  const S = SC.STATUS;
  const LABEL = {
    PENDING: "Pending", SUBMITTED: "Submitted", CONFIRMED_ZERO: "Confirmed Zero",
    NO_PRODUCTION: "No Production", CHANGED: "Changed", CONFLICT: "Conflict"
  };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lineLabel = c => ((typeof LINES !== "undefined" ? LINES : []).find(l => l.code === c) || {}).label || c;
  const shiftLabel = c => ((typeof SHIFTS !== "undefined" ? SHIFTS : []).find(s => s.code === c) || {}).label || c;
  const enabled = () => window.qdAuthMode === "enforce" && !!window.QDAuth;
  const domain = typeof QD_EMPLOYEE_EMAIL_DOMAIN === "string" ? QD_EMPLOYEE_EMAIL_DOMAIN : "@prodv2.local";
  const who = email => email ? String(email).replace(domain, "").toUpperCase() : "—";
  const pcs = n => `${Number(n || 0).toLocaleString()} pcs`;
  // Times are shown in Thailand time (UTC+7), like every Shift Close date.
  function when(t) {
    const d = t && typeof t.toDate === "function" ? t.toDate() : (t instanceof Date ? t : null);
    if (!d) return "—";
    const off = typeof QD_TZ_OFFSET_HOURS === "number" ? QD_TZ_OFFSET_HOURS : 7;
    const b = new Date(d.getTime() + off * 3600000);
    const p = n => String(n).padStart(2, "0");
    return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
  }
  function chip(status) { return `<span class="sc-chip sc-${esc(status)}" data-status="${esc(status)}">${esc(LABEL[status] || status)}</span>`; }
  const opts = () => {
    const st = QDAuth.getState();
    return { email: st.email, serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp() };
  };
  function errorText(e) {
    const c = e && e.code ? String(e.code) : "";
    if (/permission/i.test(c) && !c.startsWith("qd/")) return "The server refused this close (no permission for this Line/Shift or date, or the data changed). Nothing was saved.";
    return (e && e.message) || String(e);
  }

  // What this person may do on a slot right now. Returns { actions: [...], blocked: "why not" }.
  function allowedActions(slot) {
    const st = QDAuth.getState();
    const info = slot.info;
    if (!st.user) return { actions: [], blocked: "Sign in to close this shift." };
    if (st.checking) return { actions: [], blocked: "Checking your role…" };
    const profile = st.profile;
    const ctx = { line: slot.line, shift: slot.shift, date: slot.date };
    if (!QDAuth.can("shift.close", ctx)) {
      const windowDays = typeof QD_LEADER_EDIT_WINDOW_DAYS === "number" ? QD_LEADER_EDIT_WINDOW_DAYS : 7;
      let why = "You cannot close this Line/Shift.";
      if (!profile || profile.active !== true) why = "Your account has no active Quality Dashboard role.";
      else if (profile.role === "viewer") why = "Viewers cannot close shifts.";
      else if (profile.role === "leader" && !(profile.slots || []).includes(`${slot.line}_${slot.shift}`)) why = "This Line/Shift is not assigned to you.";
      else if (profile.role === "leader") why = `Leaders can close only the last ${windowDays} days.`;
      return { actions: [], blocked: why };
    }
    const admin = profile && profile.role === "admin";
    if (info.status === S.CONFLICT) {
      const acts = admin && slot.slot && slot.slot.importPending ? ["clear-import"] : [];
      return { actions: acts, blocked: "Resolve the conflict first. Closing is not allowed." };
    }
    if (!SC.shiftEnded(slot.date, slot.shift)) {
      const end = SC.shiftEnd(slot.date, slot.shift);
      return { actions: [], blocked: `This shift ends ${end ? when(end) : "later"}. It can be closed after it ends.` };
    }
    const closedNow = [S.SUBMITTED, S.CONFIRMED_ZERO, S.NO_PRODUCTION].includes(info.status);
    if (closedNow && !admin) return { actions: [], blocked: "" };
    const acts = info.count > 0 ? ["SUBMITTED"] : ["CONFIRMED_ZERO", "NO_PRODUCTION"];
    return { actions: acts, reconfirm: closedNow || info.status === S.CHANGED, blocked: "" };
  }

  const ACTION_TEXT = {
    SUBMITTED: (r, i) => `${r ? "Reconfirm" : "Submit"} scrap (${i.count} record${i.count === 1 ? "" : "s"}, ${pcs(i.qty)})`,
    CONFIRMED_ZERO: r => r ? "Reconfirm: zero scrap" : "Confirm zero scrap",
    NO_PRODUCTION: r => r ? "Reconfirm: no production" : "No production",
    "clear-import": () => "Clear import marker"
  };

  function closedLine(info) {
    if (!info.closed) return "";
    const c = info.closed;
    return `<div class="sc-who" data-role="closed-by">Last confirmed: <b>${esc(LABEL[c.state])}</b> by <b>${esc(who(c.by))}</b> · ${esc(when(c.at))} · revision ${esc(c.revision)} · ledger v${esc(c.version)}${c.state === S.SUBMITTED ? ` · ${c.count} records, ${pcs(c.qty)}` : ""}${c.reason ? ` · reason: ${esc(c.reason)}` : ""}${c.note ? ` · note: ${esc(c.note)}` : ""}</div>`;
  }
  function statusNotes(slot) {
    const info = slot.info;
    let h = "";
    if (info.status === S.PENDING) h += `<div class="sc-note info">Not closed yet. A shift that is not closed is never counted as zero scrap.</div>`;
    if (info.status === S.CHANGED) h += `<div class="sc-note warn" data-role="changed">Scrap changed after this shift was confirmed (confirmed v${esc(info.closed.version)}, now v${esc(info.version)}: ${info.count} records, ${pcs(info.qty)}). Reconfirm is required.</div>`;
    if (info.status === S.CONFLICT) h += `<div class="sc-note err" data-role="conflict">Conflict — this shift cannot be closed:<ul>${info.reasons.map(r => `<li>${esc(SC.REASONS[r] || r)}</li>`).join("")}</ul></div>`;
    return h;
  }

  // ---- confirm sheet --------------------------------------------------------------------------
  function openSheet(slot, action, reconfirm, done) {
    const info = slot.info;
    const back = document.createElement("div");
    back.className = "sc-sheet-back";
    const title = action === "clear-import" ? "Clear import marker" : ACTION_TEXT[action](reconfirm, info);
    const body = action === "clear-import"
      ? `<p>The import <b>${esc(slot.slot.importPending.importId)}</b> did not finish for this shift (${esc(slot.slot.importPending.rows)} rows expected). Check the records in Scrap Detail first; clearing only removes the block — it does not add or delete records.</p>`
      : action === S.SUBMITTED
        ? `<p>You confirm that <b>${info.count} scrap record${info.count === 1 ? "" : "s"} (${pcs(info.qty)})</b> is the complete scrap of this shift.</p>`
        : action === S.CONFIRMED_ZERO
          ? `<p>You confirm that the line <b>ran</b> and had <b>no scrap</b> this shift.</p>`
          : `<p>You confirm that the line <b>did not run</b> this shift. Give the reason (Actual = 0 or a missing plan is not enough).</p>`;
    back.innerHTML = `<div class="sc-sheet" role="dialog" aria-modal="true" aria-labelledby="scSheetTitle">
      <h3 id="scSheetTitle">${esc(title)}</h3>
      <p><b>${esc(lineLabel(slot.line))} · ${esc(shiftLabel(slot.shift))} · ${esc(slot.date)}</b> · ledger v${esc(info.version)}</p>
      ${body}
      ${action === S.NO_PRODUCTION ? `<label for="scReason">Reason (required)</label><input id="scReason" maxlength="200" placeholder="e.g. planned maintenance, holiday">` : ""}
      ${action !== "clear-import" ? `<label for="scNote">Note (optional)</label><textarea id="scNote" rows="2" maxlength="300"></textarea>` : ""}
      <div class="sc-note err" id="scSheetErr" hidden></div>
      <div class="sc-actions"><button type="button" class="sc-btn" id="scCancel">Cancel</button><button type="button" class="sc-btn primary" id="scConfirm">Confirm</button></div>
    </div>`;
    document.body.appendChild(back);
    const $ = s => back.querySelector(s);
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    $("#scCancel").onclick = close;
    back.addEventListener("click", e => { if (e.target === back) close(); });
    (action === S.NO_PRODUCTION ? $("#scReason") : $("#scConfirm")).focus();
    $("#scConfirm").onclick = async () => {
      const btn = $("#scConfirm"), err = $("#scSheetErr");
      err.hidden = true;
      const reason = action === S.NO_PRODUCTION ? $("#scReason").value.trim() : "";
      if (action === S.NO_PRODUCTION && reason.length < 3) { err.textContent = "Enter the reason (at least 3 characters)."; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        let result;
        if (action === "clear-import") {
          QDAuth.assertCan("scrap.import", {});
          result = await ScrapLedger.clearImportMarker(window.qdDb, slot.id, opts());
        } else {
          QDAuth.assertCan("shift.close", { line: slot.line, shift: slot.shift, date: slot.date });
          result = await SC.closeSlot(window.qdDb, {
            date: slot.date, line: slot.line, shift: slot.shift, state: action,
            note: $("#scNote") ? $("#scNote").value : "", reason,
            expectedVersion: info.version, expectedRevision: slot.slot ? slot.slot.closeRevision || 0 : 0,
            reconfirm
          }, opts());
        }
        close();
        done(null, result);
      } catch (e) {
        console.error("Quality Dashboard: shift close failed:", e);
        err.textContent = errorText(e); err.hidden = false;
        btn.disabled = false; btn.textContent = "Confirm";
        done(e);
      }
    };
  }

  // ---- panel (one slot) ------------------------------------------------------------------------
  function renderSlotBody(slot, host, reload, message) {
    const info = slot.info;
    const allowed = allowedActions(slot);
    host.innerHTML = `
      <div class="sc-head">
        <h2>Shift Scrap Close</h2>${chip(info.status)}
        <span class="sc-sub">${esc(lineLabel(slot.line))} · ${esc(shiftLabel(slot.shift))} · ${esc(slot.date)}</span>
        <span class="sc-spacer"></span>
        <a class="sc-link" href="daily-confirmation.html?date=${encodeURIComponent(slot.date)}${window.qdEmulator ? "&qdEmulator=1" : ""}">Daily Confirmation →</a>
      </div>
      <div class="sc-facts">
        <div class="sc-fact"><small>Scrap records</small><b data-role="count">${info.count}</b></div>
        <div class="sc-fact"><small>Scrap qty</small><b data-role="qty">${pcs(info.qty)}</b></div>
        <div class="sc-fact"><small>Ledger version</small><b>v${info.version}</b></div>
      </div>
      ${closedLine(info)}${statusNotes(slot)}
      ${message ? `<div class="sc-note ${message.kind}" role="status">${esc(message.text)}</div>` : ""}
      ${allowed.blocked ? `<div class="sc-note info" data-role="blocked">${esc(allowed.blocked)}</div>` : ""}
      <div class="sc-actions">${allowed.actions.map(a => `<button type="button" class="sc-btn ${a === "clear-import" ? "warn" : a === "SUBMITTED" || a === "CONFIRMED_ZERO" ? "primary" : ""}" data-action="${a}">${esc(ACTION_TEXT[a](allowed.reconfirm, info))}</button>`).join("")}</div>
      <details class="sc-history"><summary>History</summary><ol data-role="history"><li>Loading…</li></ol></details>`;
    host.querySelectorAll("[data-action]").forEach(b => b.addEventListener("click", () => {
      openSheet(slot, b.dataset.action, !!allowed.reconfirm, (err, res) => {
        if (err) return;
        const ok = b.dataset.action === "clear-import" ? { kind: "ok", text: "Import marker cleared." }
          : res && res.verified ? { kind: "ok", text: `Saved: ${LABEL[b.dataset.action]} (revision ${res.revision}).` }
            : { kind: "warn", text: "Saved, but the records changed right after closing — check the status below." };
        reload(ok);
      });
    }));
    const det = host.querySelector(".sc-history");
    det.addEventListener("toggle", async () => {
      if (!det.open) return;
      const ol = det.querySelector("ol");
      try {
        const list = await SC.loadHistory(window.qdDb, slot.id);
        ol.innerHTML = list.length ? list.map(e => e.type === "CLOSE"
          ? `<li><b>${esc(LABEL[e.closeState])}</b> rev ${esc(e.revision)} at v${esc(e.version)} by ${esc(who(e.by))} · ${esc(when(e.at))}${e.previous ? ` (was ${esc(LABEL[e.previous.state])} v${esc(e.previous.version)})` : ""}${e.noProductionReason ? " · " + esc(e.noProductionReason) : ""}</li>`
          : `<li>Scrap v${esc(e.version)} by ${esc(who(e.by))} · ${esc(when(e.at))} · +${e.creates.length + e.movesIn.length} / ~${e.updates.length} / −${e.deletes.length + e.movesOut.length}</li>`).join("") : "<li>No history yet.</li>";
      } catch (e) { ol.innerHTML = `<li>${esc(errorText(e))}</li>`; }
    });
  }

  /**
   * mountPanel(host, getCtx) — Scrap Entry panel. getCtx() → { date, line, shift }.
   * Returns refresh(); call it after a save or when the Date/Line/Shift changes.
   */
  function mountPanel(host, getCtx) {
    let seq = 0;
    async function refresh(message) {
      if (!enabled()) { host.hidden = true; return; }
      host.hidden = false;
      const ctx = getCtx();
      if (!ctx.date || !ctx.line || !ctx.shift) {
        host.innerHTML = `<div class="sc-head"><h2>Shift Scrap Close</h2></div><div class="sc-note info">Select a date, shift and line to see whether that shift is closed.</div>`;
        return;
      }
      const st = QDAuth.getState();
      if (!st.user) {
        host.innerHTML = `<div class="sc-head"><h2>Shift Scrap Close</h2></div><div class="sc-note info">Sign in to see and close this shift.</div>`;
        return;
      }
      const my = ++seq;
      try {
        const slot = await SC.loadSlot(window.qdDb, ctx.date, ctx.line, ctx.shift);
        if (my !== seq) return;
        renderSlotBody(slot, host, m => refresh(m), message);
      } catch (e) {
        if (my !== seq) return;
        host.innerHTML = `<div class="sc-head"><h2>Shift Scrap Close</h2></div><div class="sc-note err">Could not load the close status: ${esc(errorText(e))}</div>`;
      }
    }
    if (window.QDAuth) QDAuth.onChange(() => refresh());
    refresh();
    return refresh;
  }

  // ---- Daily Confirmation matrix ---------------------------------------------------------------
  function mountMatrix(host, detailHost, date) {
    let current = date;
    let seq = 0;
    async function refresh(message) {
      if (!enabled()) {
        host.innerHTML = `<div class="sc-note info">Shift Scrap Close is not enabled yet. It is being tested and will be switched on after approval.</div>`;
        detailHost.hidden = true;
        return;
      }
      if (!QDAuth.getState().user) { host.innerHTML = `<div class="sc-note info">Sign in to see the daily confirmation.</div>`; detailHost.hidden = true; return; }
      const my = ++seq;
      host.innerHTML = `<div class="sc-note info">Loading…</div>`;
      try {
        const lines = (typeof LINES !== "undefined" ? LINES : []).map(l => l.code);
        const shifts = (typeof SHIFTS !== "undefined" ? SHIFTS : []).map(s => s.code);
        const slots = await SC.loadDay(window.qdDb, current, lines, shifts);
        if (my !== seq) return;
        const by = {};
        slots.forEach(s => { by[s.id] = s; });
        const counts = {};
        slots.forEach(s => { counts[s.info.status] = (counts[s.info.status] || 0) + 1; });
        host.innerHTML = `<table class="sc-matrix" data-role="matrix"><thead><tr><th class="sc-row"></th>${shifts.map(s => `<th>${esc(shiftLabel(s))}</th>`).join("")}</tr></thead><tbody>
          ${lines.map(l => `<tr><th class="sc-row" scope="row">${esc(lineLabel(l))}</th>${shifts.map(sh => {
            const s = by[SC.slotIdOf({ date: current, line: l, shift: sh })];
            const c = s.info.closed;
            return `<td data-shift="${esc(shiftLabel(sh))}"><button type="button" class="sc-cell" data-slot="${esc(s.id)}" aria-label="${esc(lineLabel(l))} ${esc(shiftLabel(sh))}: ${esc(LABEL[s.info.status])}">
              ${chip(s.info.status)}
              <div class="sc-cell-qty">${s.info.count} record${s.info.count === 1 ? "" : "s"} · ${pcs(s.info.qty)}</div>
              <div class="sc-cell-who">${c ? `${esc(who(c.by))} · ${esc(when(c.at))}` : "Not closed"}</div></button></td>`;
          }).join("")}</tr>`).join("")}
          </tbody></table>
          <div class="sc-legend">${Object.keys(LABEL).filter(k => counts[k]).map(k => `${chip(k)}<small>×${counts[k]}</small>`).join(" ")}</div>`;
        host.querySelectorAll("[data-slot]").forEach(b => b.addEventListener("click", () => {
          detailHost.hidden = false;
          renderSlotBody(by[b.dataset.slot], detailHost, m => { refresh(m).then(() => { const again = host.querySelector(`[data-slot="${b.dataset.slot}"]`); if (again) again.click(); }); }, null);
          detailHost.scrollIntoView({ block: "nearest" });
        }));
        if (message) { const n = document.createElement("div"); n.className = `sc-note ${message.kind}`; n.textContent = message.text; host.prepend(n); }
      } catch (e) {
        if (my !== seq) return;
        host.innerHTML = `<div class="sc-note err">Could not load: ${esc(errorText(e))}</div>`;
      }
    }
    if (window.QDAuth) QDAuth.onChange(() => refresh());
    refresh();
    return { refresh, setDate: d => { current = d; detailHost.hidden = true; return refresh(); } };
  }

  window.ShiftCloseUI = { mountPanel, mountMatrix, allowedActions, LABEL };
})();
