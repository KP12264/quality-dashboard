# Rules Diff (generated)

Generated with git from the repository files. Nothing is published.

## 1. Candidate changes in Phase 9 (`emulator/firestore.rules` @ c0b64b1 → this commit)

```diff
@@ -235,6 +235,14 @@ service cloud.firestore {
       allow delete: if qdCanWriteSlot(resource.data.line, resource.data.shift)
         && qdInWindow(resource.data.date)
         && qdLedgerRecords(qdSlotId(resource.data), 'deletes', id);
+      // Privacy migration (Phase 9): an old public record loses ONLY its recordedBy, and only when the
+      // same value is in scrapLogPrivate/{id} after the commit, written under an authorised run.
+      // Scrap data, ledger counts and close fingerprints are unaffected (recordedBy is in none of them).
+      allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['recordedBy'])
+        && !('recordedBy' in request.resource.data)
+        && existsAfter(/databases/$(database)/documents/scrapLogPrivate/$(id))
+        && getAfter(/databases/$(database)/documents/scrapLogPrivate/$(id)).data.recordedBy == resource.data.recordedBy
+        && qdOpAuthorized(getAfter(/databases/$(database)/documents/scrapLogPrivate/$(id)).data.get('opId', ''), 'PRIVACY_MIGRATION');
     }
 
     // ---- Slot: ledger + import marker + shift close ----
@@ -344,6 +352,20 @@ service cloud.firestore {
         && qdNotFuture(n.date) && qdInWindow(n.date) && qdShiftEnded(n.date, n.shift)
         && existsAfter(qdCloseEventPath(slotId, n.closeRevision));
     }
+    // ---- Operations authorisation (Phase 9) ----
+    // A go-live write step (reconcile, baseline, baseline gate, privacy migration) must name an
+    // operation run that the SAME admin opened in qdOpsLog (stage START, same action) within the
+    // last 12 hours. The audit record is therefore a precondition enforced here, not a UI courtesy;
+    // the client-side lock (QD_OPS_WRITE_ENABLED) only prevents accidents.
+    function qdOpAuthorized(opId, action) {
+      return qdAdmin() && opId is string && opId.size() > 0
+        && exists(/databases/$(database)/documents/qdOpsLog/$(opId))
+        && get(/databases/$(database)/documents/qdOpsLog/$(opId)).data.stage == 'START'
+        && get(/databases/$(database)/documents/qdOpsLog/$(opId)).data.action == action
+        && get(/databases/$(database)/documents/qdOpsLog/$(opId)).data.by == qdEmail()
+        && get(/databases/$(database)/documents/qdOpsLog/$(opId)).data.at > request.time - duration.value(12, 'h');
+    }
+
     // ---- Ledger baseline (Phase 5 migration) ----
     // Before go-live an Admin creates every slot that already has scrap logs ("baseline": logVersion 0,
     // legacyCount = the logs counted by the migration, audit event b1), then sets
@@ -359,9 +381,10 @@ service cloud.firestore {
     }
     function qdValidBaselineEvent(slotId, eventId, e) {
       return eventId == 'b1'
-        && e.keys().hasOnly(['type', 'migrationId', 'legacyCount', 'scrapQty', 'logIds', 'fingerprint', 'at', 'by'])
+        && e.keys().hasOnly(['type', 'migrationId', 'opId', 'legacyCount', 'scrapQty', 'logIds', 'fingerprint', 'at', 'by'])
         && e.type == 'BASELINE'
         && e.migrationId is string && e.migrationId.size() > 0
+        && qdOpAuthorized(e.opId, 'BASELINE_APPLY')
         && e.legacyCount == getAfter(qdSlotPath(slotId)).data.legacyCount
         && getAfter(qdSlotPath(slotId)).data.logVersion == 0
         && e.logIds is list && e.logIds.size() == e.legacyCount
@@ -370,8 +393,9 @@ service cloud.firestore {
     match /qdConfig/{id} {
       allow read: if qdActive();
       allow write: if qdAdmin() && id == 'ledger'
-        && request.resource.data.keys().hasOnly(['baselineComplete', 'migrationId', 'at', 'by'])
+        && request.resource.data.keys().hasOnly(['baselineComplete', 'migrationId', 'opId', 'at', 'by'])
         && request.resource.data.baselineComplete is bool
+        && qdOpAuthorized(request.resource.data.opId, 'BASELINE_GATE')
         && request.resource.data.at == request.time && request.resource.data.by == qdEmail();
     }
 
@@ -485,8 +509,8 @@ service cloud.firestore {
     // actually stored. Audited with the full id list, fingerprint, previous count and a reason; it
     // raises logVersion, so a closed shift becomes CHANGED and must be reconfirmed.
     function qdValidReconcileEvent(e) {
-      return qdAdmin()
-        && e.keys().hasOnly(['type', 'version', 'at', 'by', 'logIds', 'fingerprint', 'scrapQty', 'before', 'reason'])
+      return qdOpAuthorized(e.opId, 'RECONCILE')
+        && e.keys().hasOnly(['type', 'version', 'at', 'by', 'opId', 'logIds', 'fingerprint', 'scrapQty', 'before', 'reason'])
         && e.logIds is list && e.fingerprint is string && e.scrapQty is number
         && e.before is int && e.reason is string && e.reason.size() >= 3 && e.reason.size() <= 300;
     }
@@ -533,8 +557,9 @@ service cloud.firestore {
       allow read: if qdActive();
       allow create, update: if existsAfter(qdLogPath(id))
         && qdCanWriteSlot(getAfter(qdLogPath(id)).data.line, getAfter(qdLogPath(id)).data.shift)
-        && request.resource.data.keys().hasOnly(['recordedBy'])
-        && request.resource.data.recordedBy is string && request.resource.data.recordedBy.size() <= 64;
+        && request.resource.data.keys().hasOnly(['recordedBy', 'opId'])
+        && request.resource.data.recordedBy is string && request.resource.data.recordedBy.size() <= 64
+        && (!('opId' in request.resource.data) || qdOpAuthorized(request.resource.data.opId, 'PRIVACY_MIGRATION'));
       // removed together with its scrap log (or by an admin)
       allow delete: if qdAdmin()
         || (exists(qdLogPath(id)) && !existsAfter(qdLogPath(id))
@@ -545,8 +570,11 @@ service cloud.firestore {
     match /qdOpsLog/{id} {
       allow read: if qdAdmin();
       allow create: if qdAdmin()
-        && request.resource.data.keys().hasOnly(['action', 'projectId', 'database', 'approvalRef', 'reason', 'summary', 'at', 'by'])
-        && request.resource.data.action in ['RECONCILE', 'BASELINE_APPLY', 'BASELINE_GATE', 'CLEAR_IMPORT_MARKER']
+        && request.resource.data.keys().hasOnly(['action', 'stage', 'runOf', 'projectId', 'database', 'approvalRef', 'reason', 'summary', 'at', 'by'])
+        && request.resource.data.action in ['RECONCILE', 'BASELINE_APPLY', 'BASELINE_GATE', 'CLEAR_IMPORT_MARKER', 'PRIVACY_MIGRATION']
+        && request.resource.data.stage in ['START', 'RESULT']
+        && (request.resource.data.stage == 'START' || request.resource.data.runOf is string)
+        && request.resource.data.summary is string && request.resource.data.summary.size() <= 4000
         && request.resource.data.approvalRef is string && request.resource.data.approvalRef.size() >= 3
         && request.resource.data.reason is string && request.resource.data.reason.size() >= 3
         && request.resource.data.at == request.time && request.resource.data.by == qdEmail();
@@ -557,7 +585,7 @@ service cloud.firestore {
       allow read: if qdActive();
       allow write: if qdAdmin()
         && (request.resource == null
-            || (request.resource.data.keys().hasOnly(['owners', 'updatedAt'])
+            || (request.resource.data.keys().hasOnly(['owners', 'updatedAt', 'opId'])
                 && request.resource.data.owners is list && request.resource.data.owners.size() <= 20));
     }
     match /scrapModelMappings/{id} {
```

## 2. Production snapshot → candidate (block list)

| Match block | Production snapshot | Candidate |
|---|---|---|
| `productionLogs` | present | present |
| `prodV2_authorizedUsers` | present | present |
| `{collection}/{doc}` | present | present |
| `qdUsers` | — | present |
| `qdConfig` | — | present |
| `scrapLogs` | present | present |
| `scrapLogPrivate` | — | present |
| `scrapSlots` | — | present |
| `events` | — | present |
| `scrapCloseSummary` | — | present |
| `targetMaster` | present | present |
| `improvements` | present | present |
| `improvementOwners` | — | present |
| `scrapModelMappings` | present | present |
| `scrapWeeklyPlans` | — | present |
| `qdOpsLog` | — | present |
| `{document=**}` (default deny) | present | present |

PV2 + legacy blocks are byte-identical (checked by `tests/rules/rules.test.js`). Full behavioural comparison: `docs/phase6/generated/compatibility-matrix.md` (regenerated by the rules suite).
