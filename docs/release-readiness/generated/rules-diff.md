# Rules Diff since Phase 9 (generated)

Generated with git from the repository files. Nothing is published.

| File | sha256 |
|---|---|
| `emulator/production.firestore.rules.snapshot` | `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f` |
| `emulator/firestore.rules` | `6fa05b5a12ffb6cfe752d312ba8cdef65328b863635b7670a6965b46d2e45668` |
| `emulator/firestore.rules.bridge` | `d94383fa53726b55ed80c958456a57dd7a1f57775460af8d2c1aebdbb5e198e1` |

Production snapshot: unchanged (byte-exact Console copy). Bridge: regenerated from the candidate (`node tools/rules/build-bridge.js --check` passes).

## Candidate `emulator/firestore.rules`: Phase 9 (a8e4075) → now (Weekly Plan V5 only)

```diff
@@ -592,9 +592,52 @@ service cloud.firestore {
       allow read: if true;
       allow write: if qdAdmin() && qdNoNewPersonal();
     }
+    // Weekly Plan V5. Plan NUMBERS are public (Dashboard card); who changed a plan and why
+    // (history) and the review notes are signed-in only. Every plan change must write its history
+    // entry in the same commit (historyRev + 1, from = old value, to = new value); history is
+    // immutable. planOverride: whole pcs 0 … 350 (= 50 x 7) or null (= default 50 x days); the
+    // page also keeps it <= 50 x days of that week. Leader / Viewer: read-only.
+    function qdPlanPath(id) {
+      return /databases/$(database)/documents/scrapWeeklyPlans/$(id);
+    }
+    function qdValidWeeklyPlan(id, n) {
+      return n.keys().hasOnly(['ym', 'week', 'planOverride', 'historyRev', 'updatedAt'])
+        && n.keys().hasAll(['ym', 'week', 'planOverride', 'historyRev', 'updatedAt'])
+        && n.ym is string && n.ym.matches('^20[0-9]{2}-(0[1-9]|1[0-2])$')
+        && n.week is string && n.week.matches('^W[1-6]$')
+        && id == n.ym + '_' + n.week
+        && (n.planOverride == null || (n.planOverride is int && n.planOverride >= 0 && n.planOverride <= 350))
+        && n.historyRev is int && n.historyRev == (resource == null ? 0 : resource.data.get('historyRev', 0)) + 1
+        && n.updatedAt == request.time;
+    }
     match /scrapWeeklyPlans/{id} {
       allow read: if true;
-      allow write: if qdAdmin() && qdNoNewPersonal();          // Leader / Viewer: read-only
+      allow create, update: if qdAdmin() && qdValidWeeklyPlan(id, request.resource.data)
+        && existsAfter(/databases/$(database)/documents/scrapWeeklyPlans/$(id)/history/$(string(request.resource.data.historyRev)));
+      allow delete: if false;
+      match /history/{rev} {
+        allow read: if qdActive();
+        allow create: if qdAdmin()
+          && request.resource.data.keys().hasOnly(['from', 'to', 'reason', 'at', 'by'])
+          && request.resource.data.keys().hasAll(['from', 'to', 'reason', 'at', 'by'])
+          && string(getAfter(qdPlanPath(id)).data.historyRev) == rev
+          && request.resource.data.to == getAfter(qdPlanPath(id)).data.planOverride
+          && request.resource.data.from == (exists(qdPlanPath(id)) ? get(qdPlanPath(id)).data.get('planOverride', null) : null)
+          && request.resource.data.reason is string && request.resource.data.reason.size() >= 3 && request.resource.data.reason.size() <= 200
+          && request.resource.data.by == qdEmail() && request.resource.data.at == request.time;
+        allow update, delete: if false;
+      }
+    }
+    match /scrapWeeklyReviews/{id} {
+      allow read: if qdActive();
+      allow create, update: if qdAdmin()
+        && request.resource.data.keys().hasOnly(['ym', 'week', 'reviewNote', 'updatedAt', 'updatedBy'])
+        && request.resource.data.keys().hasAll(['ym', 'week', 'reviewNote', 'updatedAt', 'updatedBy'])
+        && request.resource.data.week is string && request.resource.data.week.matches('^W[1-6]$')
+        && id == request.resource.data.ym + '_' + request.resource.data.week
+        && request.resource.data.reviewNote is string && request.resource.data.reviewNote.size() <= 2000
+        && request.resource.data.updatedAt == request.time && request.resource.data.updatedBy == qdEmail();
+      allow delete: if qdAdmin();
     }
     // ===== END Quality Dashboard =====
 
```
