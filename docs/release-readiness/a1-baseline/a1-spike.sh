#!/usr/bin/env bash
# A1 spike detail, 7 Nov 2026 01:00-06:00 UTC (= 08:00-13:00 Thailand time) - READ-ONLY. Version 1.1 (2026-11-12).
# Run by the project owner in Google Cloud Shell, after approval. Usage:  bash a1-spike.sh
#
# Step 1: metricDescriptors.get for each metric; a metric whose descriptor is missing, or that does not list
#         the resource type used below, is NOT queried (reported as MISSING).
# Step 2: timeSeries.list, 5-minute buckets (alignmentPeriod 300s), window fixed to 5 hours = 60 buckets:
#   reads        firestore.googleapis.com/document/read_count          firestore_instance                 ALIGN_SUM, by type
#   rules        firestore.googleapis.com/rules/evaluation_count       firestore.googleapis.com/Database  ALIGN_SUM, by request_method, result
#   listeners    firestore.googleapis.com/network/snapshot_listeners   firestore.googleapis.com/Database  ALIGN_MAX (gauge)
#   connections  firestore.googleapis.com/network/active_connections   firestore.googleapis.com/Database  ALIGN_MAX (gauge)
#   fsrequests   firestore.googleapis.com/api/request_count            firestore.googleapis.com/Database  ALIGN_SUM, by api_method, response_code
#   byCredential serviceruntime.googleapis.com/api/request_count       consumed_api (service = Firestore) ALIGN_SUM, by credential_id, method, response_code
#                optional: if it fails (e.g. 400 / 403) it is recorded as UNAVAILABLE and the script continues.
#                credential_id is MASKED (type + last 4 characters) immediately after each page is saved; it
#                identifies a key / OAuth client / service account, NOT a person.
# Output (~/a1-spike-<time>/): spike-5min.csv (all 60 buckets; NO_POINT = no data point, which is NOT zero),
# coverage.json, collect-log.txt, raw/, MANIFEST.sha256. No home path, account, e-mail or token is written.
# Limits: at most 30 HTTP requests in total (curl does not retry on its own); at most 5 pages per query.
# Only HTTP GET to the Cloud Monitoring API v3 (metricDescriptors.get, timeSeries.list). Nothing is created or
# changed; no logging, IAM or Firebase / Firestore setting is touched. The access token stays in a shell
# variable, is sent to curl on stdin, never printed or written, and is redacted from any error text.
set +x
set -euo pipefail
umask 077

PROJECT="daily-production-report-46b60"
START="2026-11-07T01:00:00Z"
END="2026-11-07T06:00:00Z"
API="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
if [ -n "${A1_TEST_API:-}" ]; then [[ "$A1_TEST_API" =~ ^http://127\.0\.0\.1:[0-9]+/ ]] || { echo "A1_TEST_API must be http://127.0.0.1:<port>/..."; exit 1; }; API="$A1_TEST_API"; fi
NAME="a1-spike-$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HOME/$NAME"
SHOW="~/$NAME"            # what is printed / logged instead of the real home path
mkdir -p "$OUT/raw"
LOG="$OUT/collect-log.txt"
TOKEN=""; REQS=0; MAXREQ=30

say()    { printf '%s\n' "$*" | tee -a "$LOG"; }
redact() { local s="$1"; [ -z "$TOKEN" ] || s="${s//"$TOKEN"/[REDACTED]}"; s="${s//"$HOME"/\~}"; printf '%s' "$s" | sed -E 's/ya29\.[A-Za-z0-9._-]+/[REDACTED]/g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[EMAIL]/g'; }
die()    { say "STOP: $*"; exit 1; }
enc()    { jq -rn --arg v "$1" '$v|@uri'; }
mask_raw() {   # mask credential_id in one saved JSON file (type + last 4 characters)
  python3 -I - "$1" <<'PY'
import json, sys
p = sys.argv[1]
def mask(c):
    c = str(c or ""); k, _, v = c.partition(":")
    return (k + ":…" + v[-4:]) if v else ("…" + c[-4:] if c else "")
d = json.load(open(p))
for s in d.get("timeSeries", []):
    r = (s.get("resource") or {}).get("labels") or {}
    if "credential_id" in r: r["credential_id"] = mask(r["credential_id"])
json.dump(d, open(p, "w"))
PY
}
leak_check() {
  local hit=""
  if [ -n "$TOKEN" ] && grep -rlFf <(printf '%s\n' "$TOKEN") "$OUT" >/dev/null 2>&1; then hit=1; fi
  if grep -rlE 'ya29\.|Bearer ' "$OUT" >/dev/null 2>&1; then hit=1; fi
  [ -z "$hit" ] || { printf '%s\n' "SECURITY: a token-like string was found under $SHOW - do NOT share these files." >&2; return 1; }
}
on_exit() { local rc=$?; leak_check || rc=9; TOKEN=""; unset TOKEN; exit "$rc"; }
trap on_exit EXIT
for c in jq python3 curl gcloud; do command -v "$c" >/dev/null || die "$c not found"; done

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || die "gcloud auth print-access-token failed (run: gcloud auth login)"
[ -n "$TOKEN" ] || die "empty access token"
case "$TOKEN" in *[[:space:]]*) die "access token contains whitespace";; esac
say "script : a1-spike.sh v1.1 (read-only)"; say "project: $PROJECT"
say "window : $START -> $END (UTC) = 7 Nov 2026 08:00-13:00 Thailand time; 5-minute buckets"

# HTTP GET. Returns 0 on 200; otherwise prints the (redacted) error and returns the HTTP code class:
# 2 = 404, 3 = any other HTTP error. A transport failure stops the script.
LAST_CODE=""
get() {
  local url="$1" out="$2" code
  REQS=$((REQS+1)); [ "$REQS" -le "$MAXREQ" ] || die "request limit ($MAXREQ) reached"
  code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS --connect-timeout 20 --max-time 120 \
          -o "$out" -w '%{http_code}' -H @- "$url" 2>"$out.err")" || { say "transport error: $(redact "$(head -c 300 "$out.err")")"; rm -f "$out.err"; die "network failure. Nothing was changed."; }
  rm -f "$out.err"; LAST_CODE="$code"
  [ "$code" = "200" ] && return 0
  say "  HTTP $code: $(redact "$(jq -r '.error.message? // empty' "$out" 2>/dev/null | head -c 300)")"; rm -f "$out"
  [ "$code" = "404" ] && return 2
  return 3
}

# ---- Step 1: descriptors ----
declare -A HAS=()
say ""; say "== Step 1: metric descriptors =="
check() {   # check METRIC RESOURCE_TYPE
  local m="$1" rt="$2" f
  [[ "$m" =~ ^[a-z.]+\.googleapis\.com/[a-z_/]+$ ]] || die "unexpected metric type $m"
  f="$OUT/raw/descriptor__$(printf '%s' "$m" | tr -c 'A-Za-z0-9._-' '_').json"
  local rc=0; get "$API/metricDescriptors/$m" "$f" || rc=$?     # metric type in the path as is (no %2F)
  if [ "$rc" -ne 0 ]; then say "  MISSING $m (descriptor not available: HTTP $LAST_CODE; not queried)"; return 0; fi
  say "  FOUND   $m  kind=$(jq -r .metricKind "$f")/$(jq -r .valueType "$f")  labels=[$(jq -r '[.labels[]?.key]|join(",")' "$f")]  resources=[$(jq -r '(.monitoredResourceTypes//[])|join(",")' "$f")]"
  if jq -e --arg rt "$rt" '(.monitoredResourceTypes // []) | index($rt)' "$f" >/dev/null; then HAS[$m]=1
  else say "  NOTE    $m does not list resource type $rt; not queried"; fi
}
check firestore.googleapis.com/document/read_count          firestore_instance
check firestore.googleapis.com/rules/evaluation_count       firestore.googleapis.com/Database
check firestore.googleapis.com/network/snapshot_listeners   firestore.googleapis.com/Database
check firestore.googleapis.com/network/active_connections   firestore.googleapis.com/Database
check firestore.googleapis.com/api/request_count            firestore.googleapis.com/Database
check serviceruntime.googleapis.com/api/request_count       consumed_api

# ---- Step 2: time series ----
declare -A STATE=()
# ts NAME METRIC RESOURCE_TYPE ALIGNER OPTIONAL(0/1) EXTRA_FILTER [groupBy...]
ts() {
  local name="$1" metric="$2" rtype="$3" al="$4" optional="$5" extra="$6"; shift 6
  if [ -z "${HAS[$metric]:-}" ]; then STATE[$name]="MISSING"; say "  $name: MISSING (not queried)"; return 0; fi
  local filter="metric.type=\"$metric\" AND resource.type=\"$rtype\""; [ -z "$extra" ] || filter="$filter AND $extra"
  local red="REDUCE_SUM"; [ "$al" = "ALIGN_MAX" ] && red="REDUCE_MAX"
  local base="$API/timeSeries?filter=$(enc "$filter")&interval.startTime=$(enc "$START")&interval.endTime=$(enc "$END")&view=FULL&pageSize=5000&aggregation.alignmentPeriod=300s&aggregation.perSeriesAligner=$al&aggregation.crossSeriesReducer=$red"
  local g; for g in "$@"; do base="$base&aggregation.groupByFields=$(enc "$g")"; done
  local page=0 tok="" prev="" url f rc
  while :; do
    page=$((page+1)); [ "$page" -le 5 ] || die "$name: more than 5 pages"
    url="$base"; [ -z "$tok" ] || url="$url&pageToken=$(enc "$tok")"
    f="$OUT/raw/$name-p$page.json"; rc=0; get "$url" "$f" || rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$optional" = "1" ]; then STATE[$name]="UNAVAILABLE (HTTP $LAST_CODE)"; say "  $name: UNAVAILABLE (HTTP $LAST_CODE); continuing"; return 0; fi
      die "$name: HTTP $LAST_CODE"
    fi
    [ "$name" != "byCredential" ] || mask_raw "$f"
    prev="$tok"; tok="$(jq -r '.nextPageToken // empty' "$f")"; [ -z "$tok" ] && break
    [ "$tok" != "$prev" ] || die "$name: repeated page token"
  done
  jq -s '{timeSeries:(map(.timeSeries // [])|add)}' "$OUT/raw/$name"-p*.json > "$OUT/$name.json"
  STATE[$name]="OK"
  say "  $name: series=$(jq '.timeSeries|length' "$OUT/$name.json") points=$(jq '[.timeSeries[].points|length]|add // 0' "$OUT/$name.json")"
}
say ""; say "== Step 2: 5-minute data =="
ts reads        firestore.googleapis.com/document/read_count         firestore_instance                 ALIGN_SUM 0 "" metric.label.type
ts rules        firestore.googleapis.com/rules/evaluation_count      firestore.googleapis.com/Database  ALIGN_SUM 0 "" metric.label.request_method metric.label.result
ts listeners    firestore.googleapis.com/network/snapshot_listeners  firestore.googleapis.com/Database  ALIGN_MAX 0 ""
ts connections  firestore.googleapis.com/network/active_connections  firestore.googleapis.com/Database  ALIGN_MAX 0 ""
ts fsrequests   firestore.googleapis.com/api/request_count           firestore.googleapis.com/Database  ALIGN_SUM 0 "" metric.label.api_method metric.label.response_code
ts byCredential serviceruntime.googleapis.com/api/request_count      consumed_api                       ALIGN_SUM 1 'resource.label.service="firestore.googleapis.com"' resource.label.credential_id resource.label.method metric.label.response_code

STATES="$(for k in reads rules listeners connections fsrequests byCredential; do printf '%s=%s\n' "$k" "${STATE[$k]:-MISSING}"; done)"
python3 -I - "$OUT" "$START" "$END" "$STATES" <<'PY'
import json, os, sys, datetime as dt
from zoneinfo import ZoneInfo
out, start, end, states = sys.argv[1], sys.argv[2], sys.argv[3], dict(l.split("=", 1) for l in sys.argv[4].splitlines() if l)
th, utc = ZoneInfo("Asia/Bangkok"), dt.timezone.utc
P = lambda t: dt.datetime.strptime(t[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=utc)
def load(n):
    p = os.path.join(out, n + ".json")
    return json.load(open(p))["timeSeries"] if os.path.exists(p) else None
def label(s, keys):
    m = (s.get("metric") or {}).get("labels") or {}; r = (s.get("resource") or {}).get("labels") or {}
    return "/".join(str(m.get(k, r.get(k, ""))) for k in keys)
buckets = []; t = P(start) + dt.timedelta(minutes=5)
while t <= P(end): buckets.append(t); t += dt.timedelta(minutes=5)
cols, cells, cover = [], {}, {}
spec = [("reads", "reads", ["type"]), ("rules", "rules", ["request_method", "result"]), ("listeners", "listeners_max", []),
        ("connections", "connections_max", []), ("fsrequests", "fs_requests", ["api_method", "response_code"]),
        ("byCredential", "cred_requests", ["credential_id", "method", "response_code"])]
for src, prefix, keys in spec:
    series = load(src)
    if series is None:
        cover[src] = {"state": states.get(src, "MISSING"), "series": 0, "buckets_with_point": 0, "buckets_without_point": len(buckets)}
        continue
    have = set()
    for s in series:
        col = prefix + (":" + label(s, keys) if keys else "")
        cols.append(col)
        for p in s.get("points", []):
            e = P(p["interval"]["endTime"]); v = p["value"]
            cells[(e, col)] = int(v.get("int64Value", v.get("doubleValue", 0))); have.add(e)
    if not series: cols.append(prefix + ":(no series)")
    inwin = have & set(buckets)
    cover[src] = {"state": states.get(src, "OK"), "series": len(series), "buckets_with_point": len(inwin), "buckets_without_point": len(buckets) - len(inwin)}
with open(os.path.join(out, "spike-5min.csv"), "w") as f:
    f.write("bucket_end_utc,bucket_start_thailand," + ",".join(cols) + "\n")
    for e in buckets:
        s = (e - dt.timedelta(minutes=5)).astimezone(th)
        f.write(f"{e:%Y-%m-%dT%H:%MZ},{s:%Y-%m-%d %H:%M ICT}," + ",".join(str(cells[(e, c)]) if (e, c) in cells else "NO_POINT" for c in cols) + "\n")
json.dump({"window_utc": [start, end], "buckets": len(buckets), "alignment": "300s",
           "note": "NO_POINT = Monitoring returned no data point for that bucket; it is not a zero.",
           "metrics": cover, "columns": cols}, open(os.path.join(out, "coverage.json"), "w"), indent=1)
for k, v in cover.items(): print(f"  {k}: {v}")
PY
say ""
say "Written: $SHOW/spike-5min.csv (60 buckets; NO_POINT = no data point, not zero), coverage.json, raw/ (credential ids masked)."
say "HTTP requests used: $REQS (limit $MAXREQ)"
( cd "$OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )
