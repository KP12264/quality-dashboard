# O1: Firestore single-field index check (VIEW ONLY, owner)

**Goal.** Confirm that `prodV2_actualLogs.date` in database `(default)` of project `daily-production-report-46b60` has its automatic single-field index. In other words, confirm that **no exemption** turns off indexing for that field. The O1 query `where("date","==",date)` (one equality filter, no `orderBy`) relies on this index.

**Do not change anything.**
- Do not click *Add exemption*, *Edit*, *Delete*, *Create index*, or change *Automatic index settings*.
- **Do not open Firestore → Data**: it reads documents and counts against the quota.
- No audit logs, no setting changes.
- These pages show index definitions, not documents. No document reads are expected, but this is **not verified** for this project. Stop if any page shows documents.

## Option A: Console (preferred)

1. Open the Firebase Console for project `daily-production-report-46b60` → **Firestore Database** → database `(default)`.
2. Open the **Indexes** tab → **Single field** (also called "Automatic index settings" / "Exemptions").
3. Note the **automatic index settings**. The default is Ascending, Descending and Array-contains enabled for all fields.
4. Look at the **Exemptions** list for a row with collection `prodV2_actualLogs` and field `date` (scope *Collection* or *Collection group*).
5. Record:
   - (a) whether the automatic settings are the default;
   - (b) "no exemption for `prodV2_actualLogs.date`", or the exact exemption row as shown.

   Take a screenshot with the date and time visible. Mask nothing except personal e-mail addresses, if any appear.

The same page also exists in the Google Cloud Console: **Firestore → Indexes → Single field**.

## Option B: Cloud Shell (read-only `gcloud`, if preferred)

Both commands only read index configuration. They do not read documents and change nothing.

```bash
gcloud firestore indexes fields list --project=daily-production-report-46b60 --database="(default)"
```

```bash
gcloud firestore indexes fields describe date --collection-group=prodV2_actualLogs --project=daily-production-report-46b60 --database="(default)"
```

- The first lists only fields whose settings differ from the default, plus the database-wide default (`*`).
- The second shows the settings that apply to `prodV2_actualLogs.date`. It either says the field uses the default (ancestor) configuration, or it lists ASCENDING / DESCENDING indexes that are `READY`.

Send the text output; it contains no secrets.

## How to read the result

| Finding | Meaning for O1 |
|---|---|
| Automatic settings are the default and there is no exemption for `prodV2_actualLogs.date` (or `describe` shows the default / ASCENDING READY) | the O1 query needs **no new index** → requirement met |
| An exemption turns off ascending / descending indexing for `date` (or the defaults are turned off) | the O1 query would fail with `FAILED_PRECONDITION` → **stop**; O1 cannot be proposed as tested |
| Page or command not available | record that, and do not change any setting to find out |

**A1 = HIGH. G2 = NOT APPROVED.**
