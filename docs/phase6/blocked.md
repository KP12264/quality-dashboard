# BLOCKED (Phase 6)

| Code | Item | What is needed / who |
|---|---|---|
| G1 | Snapshot not yet confirmed as the **published** rules of database `(default)`; publish time unknown | Owner: in the Console confirm the database selector shows `(default)` and note "Last published"; re-copy on the deploy day and compare the SHA-256 |
| G2 | Approval of candidate + bridge by PV2 and QD owners; who publishes | Owners |
| G4 | Public read: `scrapLogs`, `targetMaster`, `improvements`, `scrapModelMappings` (as today) + **new** `scrapCloseSummary`, `scrapWeeklyPlans` | Management / IT |
| P6-1 | Closing public write on the 4 QD collections (63 permissions) — intended, but a behaviour change for anyone writing without sign-in today | Approve together with the sequence in deployment-safety.md |
| P6-2 | Legacy page copies (`dashboard.html`, `js/scrap-entry.html`, `dashboard-classic.html`) | Decide remove / redirect before the candidate is published |
| P6-3 | Bridge weakens nothing vs today but cannot enforce the Leader window / field validation on `scrapLogs` while public write is open | Keep the bridge period short (steps 2→6) |
| B1 / B2 | `QD_CLOSE_REQUIRED_FROM` date; first admin + roles | Release owner / QD owner |
| M1 / M2 | Migration on real data; production migration runner | Permission; next phase |
| C1 / C2 | Rules read billing; region pricing | Firebase owner |
| L2 | `prodV2_authorizedUsers` is publicly readable; `prodV2_*` sub-collections are not covered by the PV2 rule (comment says they are) | PV2 owner (not changed — PV2 is out of scope) |
| MCP | Firebase MCP: no read-only credential approved (not used in this phase) | Owner decision |
