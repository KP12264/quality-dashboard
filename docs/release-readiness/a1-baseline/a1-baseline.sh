#!/usr/bin/env bash
# A1 read baseline per Firestore QUOTA DAY (Pacific time) - READ-ONLY. Version 1 (2026-11-11).
# NOT RUN by the assistant; the project owner runs it in Cloud Shell after approval.
#
#   bash a1-baseline.sh [DAYS] [LAST_QUOTA_DAY]
#     DAYS            number of quota days, default 7
#     LAST_QUOTA_DAY  last complete quota day (YYYY-MM-DD, Pacific date); default: yesterday in Pacific time
#
# A quota day D runs from D 00:00 to D+1 00:00 America/Los_Angeles (daylight saving handled), i.e.
# 15:00 -> 15:00 Thailand time in winter (14:00 -> 14:00 in summer). Output per quota day:
#   document reads  : firestore.googleapis.com/document/read_count, total and by label "type"
#   requests        : firestore.googleapis.com/api/request_count by api_method (RunQuery, BatchGetDocuments,
#                     Listen, ListDocuments, ...); "queries" = RunQuery + RunAggregationQuery + ListDocuments
#   billed reads    : NOT available from these metrics (billable_* metrics had no data, A1 Update 4). Copy the
#                     Firebase Console -> Firestore -> Usage figure by hand into the table.
# Only HTTP GET calls to the Cloud Monitoring API v3 (timeSeries.list). No document is read; nothing is
# created, changed or deleted; no gcloud configuration is changed. The access token stays in a shell
# variable, is sent to curl on stdin, never printed or written, and redacted from error text.
set +x
set -euo pipefail
umask 077

PROJECT="daily-production-report-46b60"
DAYS="${1:-7}"
LAST="${2:-}"
API="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
# Offline test only: A1_TEST_API may point the script at a local mock (http://127.0.0.1:<port>/...).
if [ -n "${A1_TEST_API:-}" ]; then [[ "$A1_TEST_API" =~ ^http://127\.0\.0\.1:[0-9]+/ ]] || { echo "A1_TEST_API must be http://127.0.0.1:<port>/..."; exit 1; }; API="$A1_TEST_API"; fi
OUT="$HOME/a1-baseline-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT/raw"
LOG="$OUT/collect-log.txt"
TOKEN=""

say()    { printf '%s\n' "$*" | tee -a "$LOG"; }
redact() { local s="$1"; [ -z "$TOKEN" ] || s="${s//"$TOKEN"/[REDACTED]}"; printf '%s' "$s" | sed -E 's/ya29\.[A-Za-z0-9._-]+/[REDACTED]/g'; }
die()    { say "STOP: $*"; exit 1; }
enc()    { jq -rn --arg v "$1" '$v|@uri'; }
leak_check() {
  local hit=""
  if [ -n "$TOKEN" ] && grep -rlFf <(printf '%s\n' "$TOKEN") "$OUT" >/dev/null 2>&1; then hit=1; fi
  if grep -rlE 'ya29\.|Bearer ' "$OUT" >/dev/null 2>&1; then hit=1; fi
  [ -z "$hit" ] || { printf '%s\n' "SECURITY: a token-like string was found under $OUT - do NOT share these files." >&2; return 1; }
}
on_exit() { local rc=$?; leak_check || rc=9; TOKEN=""; unset TOKEN; exit "$rc"; }
trap on_exit EXIT

for c in jq python3 curl gcloud; do command -v "$c" >/dev/null || die "$c not found"; done
[[ "$DAYS" =~ ^[1-9][0-9]?$ ]] || die "DAYS must be 1..99"
[ -z "$LAST" ] || [[ "$LAST" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || die "LAST_QUOTA_DAY must be YYYY-MM-DD"

# Quota-day windows (UTC) from the Pacific calendar, DST-aware.
WIN="$(python3 -I - "$DAYS" "$LAST" <<'PY'
import sys, json, datetime as dt
from zoneinfo import ZoneInfo
pt, utc = ZoneInfo("America/Los_Angeles"), dt.timezone.utc
n = int(sys.argv[1]); last = sys.argv[2]
now_pt = dt.datetime.now(pt)
lastday = dt.date.fromisoformat(last) if last else (now_pt.date() - dt.timedelta(days=1))
if lastday >= now_pt.date(): sys.exit("LAST_QUOTA_DAY must be a complete quota day (before today in Pacific time)")
days = []
for i in range(n - 1, -1, -1):
    d = lastday - dt.timedelta(days=i)
    s = dt.datetime(d.year, d.month, d.day, tzinfo=pt); e = s + dt.timedelta(days=1)
    e = dt.datetime(e.year, e.month, e.day, tzinfo=pt)
    days.append({"quotaDay": d.isoformat(), "startUtc": s.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "endUtc": e.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "hours": int((e.astimezone(utc) - s.astimezone(utc)).total_seconds() // 3600)})   # in UTC: 23 / 25 h on DST days
print(json.dumps(days))
PY
)" || die "could not compute quota-day windows"
printf '%s\n' "$WIN" > "$OUT/quota-days.json"
START="$(jq -r '.[0].startUtc' "$OUT/quota-days.json")"
END="$(jq -r '.[-1].endUtc' "$OUT/quota-days.json")"

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || die "gcloud auth print-access-token failed (run: gcloud auth login)"
[ -n "$TOKEN" ] || die "empty access token"
case "$TOKEN" in *[[:space:]]*) die "access token contains whitespace";; esac
say "script  : a1-baseline.sh v1 (read-only)"
say "project : $PROJECT"
say "quota days (Pacific): $(jq -r 'map(.quotaDay)|join(", ")' "$OUT/quota-days.json")"
say "window  : $START -> $END (UTC)"

api_get() {
  local url="$1" out="$2" code
  code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 \
          -o "$out" -w '%{http_code}' -H @- "$url" 2>"$out.err")" || { say "transport error: $(redact "$(head -c 300 "$out.err")")"; rm -f "$out.err"; die "network failure. Nothing was changed."; }
  rm -f "$out.err"
  if [ "$code" != "200" ] || ! jq -e 'type=="object" and (has("error")|not)' "$out" >/dev/null 2>&1; then
    say "HTTP $code: $(redact "$(jq -r '.error.message? // empty' "$out" 2>/dev/null | head -c 300)")"; rm -f "$out"; die "API call failed. Nothing was changed."
  fi
}
# ts NAME METRIC RESOURCE_TYPE [groupByField...]   hourly sums (ALIGN_SUM 3600s, REDUCE_SUM)
ts() {
  local name="$1" metric="$2" rtype="$3"; shift 3
  local filter="metric.type=\"$metric\" AND resource.type=\"$rtype\""
  local base="$API/timeSeries?filter=$(enc "$filter")&interval.startTime=$(enc "$START")&interval.endTime=$(enc "$END")&view=FULL&pageSize=10000"
  base="$base&aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM"
  local g; for g in "$@"; do base="$base&aggregation.groupByFields=$(enc "$g")"; done
  local page=0 tok="" prev="" url f
  while :; do
    page=$((page+1)); [ "$page" -le 200 ] || die "$name: too many pages"
    url="$base"; [ -z "$tok" ] || url="$url&pageToken=$(enc "$tok")"
    f="$OUT/raw/$name-p$(printf %03d "$page").json"; api_get "$url" "$f"
    jq -e '((.timeSeries // [])|type=="array") and ((.executionErrors // [])|length==0)' "$f" >/dev/null || die "$name: unexpected response or execution errors"
    prev="$tok"; tok="$(jq -r '.nextPageToken // empty' "$f")"; [ -z "$tok" ] && break; [ "$tok" != "$prev" ] || die "$name: repeated page token"
  done
  jq -s '{timeSeries:(map(.timeSeries // [])|add)}' "$OUT/raw/$name"-p*.json > "$OUT/$name.json"
  say "$name: series=$(jq '.timeSeries|length' "$OUT/$name.json")"
}
ts reads_total   "firestore.googleapis.com/document/read_count" "firestore_instance"
ts reads_by_type "firestore.googleapis.com/document/read_count" "firestore_instance" "metric.label.type"
ts requests_by_method "firestore.googleapis.com/api/request_count" "firestore.googleapis.com/Database" "metric.label.api_method"

python3 -I - "$OUT" <<'PY'
import sys, json, datetime as dt, os
from zoneinfo import ZoneInfo
out = sys.argv[1]; th = ZoneInfo("Asia/Bangkok")
days = json.load(open(os.path.join(out, "quota-days.json")))
def points(name, label=None):
    res = []
    for s in json.load(open(os.path.join(out, name + ".json"))).get("timeSeries", []):
        key = (s.get("metric", {}).get("labels", {}) or {}).get(label, "(none)") if label else "total"
        for p in s.get("points", []):
            v = p["value"]; n = int(v.get("int64Value", v.get("doubleValue", 0)))
            res.append((key, p["interval"]["endTime"], n))
    return res
def utc(t): return dt.datetime.strptime(t[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
def day_of(t):
    for d in days:
        if utc(d["startUtc"]) < utc(t) <= utc(d["endUtc"]): return d["quotaDay"]   # point endTime closes its hour
    return None
rows = {d["quotaDay"]: {"reads": 0, "hours": set(), "maxHour": (0, ""), "byType": {}, "byMethod": {}} for d in days}
for _, t, n in points("reads_total"):
    q = day_of(t)
    if not q: continue
    r = rows[q]; r["reads"] += n; r["hours"].add(t)
    if n > r["maxHour"][0]: r["maxHour"] = (n, utc(t).astimezone(th).strftime("%d %b %H:%M ICT (hour ending)"))
for k, t, n in points("reads_by_type", "type"):
    q = day_of(t)
    if q: rows[q]["byType"][k] = rows[q]["byType"].get(k, 0) + n
for k, t, n in points("requests_by_method", "api_method"):
    q = day_of(t)
    if q: rows[q]["byMethod"][k] = rows[q]["byMethod"].get(k, 0) + n
QUERY = ("RunQuery", "RunAggregationQuery", "ListDocuments")
lines = ["| Quota day (PT) | Window (ICT) | Document reads | % of 50,000 | Highest hour | Hours with data | Query requests | Other requests | Reads by type | Billed reads (Console, by hand) |",
         "|---|---|---|---|---|---|---|---|---|---|"]
csv = ["quota_day,start_utc,end_utc,document_reads,pct_of_50000,highest_hour_reads,highest_hour,hours_with_data,hours_in_day,query_requests,other_requests,reads_by_type,requests_by_method,billed_reads_console"]
for d in days:
    q = d["quotaDay"]; r = rows[q]
    qr = sum(v for k, v in r["byMethod"].items() if k in QUERY); other = sum(v for k, v in r["byMethod"].items() if k not in QUERY)
    win = f"{utc(d['startUtc']).astimezone(th):%d %b %H:%M} → {utc(d['endUtc']).astimezone(th):%d %b %H:%M}"
    bt = "; ".join(f"{k} {v}" for k, v in sorted(r["byType"].items())) or "–"
    bm = "; ".join(f"{k} {v}" for k, v in sorted(r["byMethod"].items())) or "–"
    miss = "" if len(r["hours"]) == d["hours"] else " (gaps)"
    lines.append(f"| {q} | {win} | {r['reads']:,} | {r['reads']/500:.1f} % | {r['maxHour'][0]:,} at {r['maxHour'][1] or '–'} | {len(r['hours'])}/{d['hours']}{miss} | {qr:,} | {other:,} | {bt} | (fill in) |")
    csv.append(",".join(map(str, [q, d["startUtc"], d["endUtc"], r["reads"], f"{r['reads']/500:.1f}", r["maxHour"][0], f'"{r["maxHour"][1]}"', len(r["hours"]), d["hours"], qr, other, f'"{bt}"', f'"{bm}"', ""])))
open(os.path.join(out, "baseline.md"), "w").write("\n".join(lines) + "\n")
open(os.path.join(out, "baseline.csv"), "w").write("\n".join(csv) + "\n")
print("\n".join(lines))
PY
say ""
say "Written: $OUT/baseline.md, baseline.csv (raw API responses in raw/). Limits: reads are for the whole project"
say "(QD, Production V2, the legacy app and any script share one key and one quota): they cannot be split by app."
( cd "$OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )
