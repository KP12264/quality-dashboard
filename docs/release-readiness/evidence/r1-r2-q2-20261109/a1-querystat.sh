#!/usr/bin/env bash
# A1 read ops + query statistics v1 (R2) - READ-ONLY.
#   Step 1: confirm the metrics exist (metricDescriptors.list).
#   Step 2: hourly document/read_ops_count (by type) and the query_stat/per_query
#           distributions (result_counts, scanned_documents_counts,
#           scanned_index_entries_counts; by service / method) for 26-30 Oct 2026
#           (UTC), plus document/read_count as the anchor checked against earlier
#           evidence. A target metric without data makes the result INCOMPLETE.
# Only HTTP GET calls to the Cloud Monitoring API v3 (metricDescriptors.list,
# timeSeries.list). No audit logs are read. Nothing is created, changed or
# deleted; no gcloud configuration is changed. The access token is held only
# in a shell variable, passed to curl on stdin, never printed, never written
# to disk, and redacted from any error text. Every timeSeries query is
# restricted to ONE metric and ONE monitored resource type; totals are never
# added across metrics or resource types.
set +x
set -euo pipefail
umask 077

PROJECT="daily-production-report-46b60"
START="2026-10-26T00:00:00Z"   # 26 Oct 2026 00:00 UTC
END="2026-10-31T00:00:00Z"     # through 30 Oct 2026 23:59:59 UTC (120 hours)
API="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
PREFIX="firestore.googleapis.com/"
M_READ="firestore.googleapis.com/document/read_count"
TARGETS=("firestore.googleapis.com/document/read_ops_count"
         "firestore.googleapis.com/query_stat/per_query/result_counts"
         "firestore.googleapis.com/query_stat/per_query/scanned_documents_counts"
         "firestore.googleapis.com/query_stat/per_query/scanned_index_entries_counts")
OUT="$HOME/a1-querystat-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT/raw"
LOG="$OUT/collect-log.txt"
INDEX="$OUT/datasets.jsonl"
: > "$INDEX"
TOKEN=""

say()    { printf '%s\n' "$*" | tee -a "$LOG"; }
redact() { local s="$1"; [ -z "$TOKEN" ] || s="${s//"$TOKEN"/[REDACTED]}"; printf '%s' "$s" | sed -E 's/ya29\.[A-Za-z0-9._-]+/[REDACTED]/g'; }
die()    { say "STOP: $*"; exit 1; }
enc()    { jq -rn --arg v "$1" '$v|@uri'; }
slug()   { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
valid_rt() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] && [[ "$1" != *..* ]] && [[ "$1" != *//* ]] && [[ "$1" != */ ]]; }
valid_mt() { [[ "$1" =~ ^firestore\.googleapis\.com/[A-Za-z0-9._/-]{1,200}$ ]] && [[ "$1" != *..* ]] && [[ "$1" != *//* ]]; }

leak_check() {   # runs on every exit; pattern comes from a pipe, not argv
  local hit=""
  if [ -n "$TOKEN" ] && grep -rlFf <(printf '%s\n' "$TOKEN") "$OUT" >/dev/null 2>&1; then hit=1; fi
  if grep -rlE 'ya29\.|Bearer ' "$OUT" >/dev/null 2>&1; then hit=1; fi
  if [ -n "$hit" ]; then
    printf '%s\n' "SECURITY: a token-like string was found under $OUT - do NOT share these files." >&2
    return 1
  fi
  return 0
}
on_exit() { local rc=$?; leak_check || rc=9; TOKEN=""; unset TOKEN; exit "$rc"; }
trap on_exit EXIT

command -v jq >/dev/null      || die "jq not found"
command -v python3 >/dev/null || die "python3 not found"
command -v curl >/dev/null    || die "curl not found"
CURLV="$(curl --version | awk 'NR==1{print $2}')"
python3 -I -c 'import sys; v=tuple(int(x) for x in sys.argv[1].split(".")[:2]); sys.exit(0 if v>=(7,55) else 1)' "$CURLV" \
  || die "curl $CURLV is older than 7.55 (needed for -H @- header input)"

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || die "gcloud auth print-access-token failed (run: gcloud auth login)"
[ -n "$TOKEN" ] || die "empty access token"
case "$TOKEN" in *[[:space:]]*) die "access token contains whitespace; refusing to build header";; esac

say "script  : a1-querystat.sh v1 (R2, read-only)"
say "project : $PROJECT"
say "window  : $START -> $END"
say "curl    : $CURLV"

api_fetch() {
  local url="$1" out="$2" code body
  code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
          | curl -sS --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 \
                 -o "$out" -w '%{http_code}' -H @- "$url" 2>"$out.curlerr")" || {
    say "curl transport error for ${url%%\?*}: $(redact "$(head -c 300 "$out.curlerr")")"
    rm -f "$out.curlerr"; die "network/transport failure. Nothing was changed."; }
  rm -f "$out.curlerr"
  if [ "$code" != "200" ] || ! jq -e 'type=="object" and (has("error")|not)' "$out" >/dev/null 2>&1; then
    say "HTTP $code from ${url%%\?*}"
    if jq -e 'type=="object" and has("error")' "$out" >/dev/null 2>&1; then
      body="$(jq -r '.error | "  error.code=\(.code) status=\(.status)\n  message=\(.message)"' "$out")"
    else
      body="  non-JSON or unexpected body (first 300 bytes): $(head -c 300 "$out" | tr -d '\000')"
    fi
    say "$(redact "$body")"
    rm -f "$out"
    return 1
  fi
  return 0
}
api_get() { api_fetch "$1" "$2" || die "API call failed (see above). Nothing was changed."; }

# ---------- Step 1: which Firestore metrics exist ----------
say ""; say "== Step 1: metricDescriptors.list (filter: metric.type starts_with $PREFIX) =="
LFILTER="metric.type = starts_with(\"$PREFIX\")"
page=0; tok=""; prev=""
while :; do
  page=$((page+1)); [ "$page" -le 50 ] || die "metric list: more than 50 pages"
  url="$API/metricDescriptors?filter=$(enc "$LFILTER")&pageSize=1000"
  [ -z "$tok" ] || url="$url&pageToken=$(enc "$tok")"
  f="$OUT/raw/metric-list-p$(printf %03d "$page").json"
  api_get "$url" "$f"
  jq -e '((.metricDescriptors // []) | type=="array") and ((.nextPageToken // "") | type=="string")
         and all((.metricDescriptors // [])[]; type=="object" and (.type|type=="string"))' "$f" >/dev/null \
    || die "metric list page $page: response does not match ListMetricDescriptorsResponse shape"
  prev="$tok"; tok="$(jq -r '.nextPageToken // empty' "$f")"
  [ -z "$tok" ] && break
  [ "$tok" != "$prev" ] || die "metric list: same nextPageToken twice"
done
jq -s --arg p "$PREFIX" '{filter:("metric.type = starts_with(\"" + $p + "\")"), pages:length,
      metricDescriptors:(map(.metricDescriptors // [])|add|unique_by(.type))}' "$OUT"/raw/metric-list-p*.json > "$OUT/metric-list.json"
N_MD="$(jq '.metricDescriptors|length' "$OUT/metric-list.json")"
[ "$N_MD" -gt 0 ] || die "metric list is empty"
BAD="$(jq -r --arg p "$PREFIX" '[.metricDescriptors[].type | select(startswith($p)|not)] | length' "$OUT/metric-list.json")"
[ "$BAD" -eq 0 ] || die "metric list contains $BAD types outside $PREFIX (filter not applied as expected)"
jq -r '.metricDescriptors[] | "\(.type)\t\(.metricKind)\t\(.valueType)\t\(.unit // "")\tlabels=[\([.labels[]?.key]|join(","))]\tresources=[\((.monitoredResourceTypes // [])|join(","))]"' \
  "$OUT/metric-list.json" | sort > "$OUT/metric-list.txt"
say "Firestore metrics found: $N_MD (pages=$page) -> metric-list.txt"
sed 's/^/  /' "$OUT/metric-list.txt" | tee -a "$LOG" >/dev/null
has_metric() { jq -e --arg t "$1" 'any(.metricDescriptors[]; .type==$t)' "$OUT/metric-list.json" >/dev/null; }
has_metric "$M_READ" || die "$M_READ is not in the metric list; refusing to continue"

# Metric selection: read_count (anchor, checked against earlier evidence) and the two
# R2 target metrics. Nothing else is collected. A missing target metric is reported.
SEL="$OUT/selected-metrics.tsv"; : > "$SEL"
printf 'anchor\t%s\n' "$M_READ" >> "$SEL"
for m in "${TARGETS[@]}"; do
  if has_metric "$m"; then printf 'target\t%s\n' "$m" >> "$SEL"
  else say "note: $m is NOT in the metric list; not collected"; printf 'missing\t%s\n' "$m" >> "$SEL"; fi
done
say "selected:"; sed 's/^/  /' "$SEL" | tee -a "$LOG"
while IFS=$'\t' read -r _ t _; do valid_mt "$t" || die "metric type has characters that are not URL-safe: $t"; done < "$SEL"

# ---------- paginated timeSeries.list ----------
# list_ts NAME METRIC RTYPE VIEW ALIGNER [groupByField ...]   (RTYPE "" = no resource filter; ALIGNER "" = no aggregation)
list_ts() {
  local name="$1" metric="$2" rtype="$3" view="$4" aligner="$5"; shift 5
  local filter="metric.type=\"$metric\""
  [ -z "$rtype" ] || filter="$filter AND resource.type=\"$rtype\""
  local base="$API/timeSeries?filter=$(enc "$filter")&interval.startTime=$(enc "$START")&interval.endTime=$(enc "$END")&view=$view&pageSize=10000"
  local reducer="" period=""
  if [ -n "$aligner" ]; then
    reducer="REDUCE_SUM"; period="3600s"
    base="$base&aggregation.alignmentPeriod=$period&aggregation.perSeriesAligner=$aligner&aggregation.crossSeriesReducer=$reducer"
    local g; for g in "$@"; do base="$base&aggregation.groupByFields=$(enc "$g")"; done
  fi
  local page=0 tok="" prev="" url f
  while :; do
    page=$((page+1)); [ "$page" -le 500 ] || die "$name: more than 500 pages, stopping"
    url="$base"; [ -z "$tok" ] || url="$url&pageToken=$(enc "$tok")"
    f="$OUT/raw/$name-p$(printf %03d "$page").json"
    api_get "$url" "$f"
    jq -e '((.timeSeries // []) | type=="array")
           and ((.nextPageToken // "") | type=="string")
           and ((.executionErrors // []) | type=="array")
           and ((.unreachable // []) | type=="array")
           and all((.timeSeries // [])[]; type=="object" and ((.points // []) | type=="array"))' "$f" >/dev/null \
      || die "$name page $page: response does not match ListTimeSeriesResponse shape"
    prev="$tok"; tok="$(jq -r '.nextPageToken // empty' "$f")"
    [ -z "$tok" ] && break
    [ "$tok" != "$prev" ] || die "$name: API returned the same nextPageToken twice"
  done
  jq -s --arg n "$name" --arg m "$metric" --arg rt "$rtype" --arg flt "$filter" --arg v "$view" \
        --arg s "$START" --arg e "$END" --arg al "$aligner" --arg rd "$reducer" --arg ap "$period" \
        --argjson g "$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(length>0))')" \
     '{name:$n, metric:$m, resourceType:$rt, filter:$flt, view:$v, startTime:$s, endTime:$e,
       alignmentPeriod:$ap, perSeriesAligner:$al, crossSeriesReducer:$rd, groupByFields:$g,
       pages:length, units:(map(.unit // empty)|unique),
       executionErrors:(map(.executionErrors // [])|add),
       unreachable:(map(.unreachable // [])|add),
       timeSeries:(map(.timeSeries // [])|add)}' "$OUT/raw/$name"-p*.json > "$OUT/$name.json"
  say "$name: pages=$page rawSeries=$(jq '.timeSeries|length' "$OUT/$name.json") executionErrors=$(jq '.executionErrors|length' "$OUT/$name.json") unreachable=$(jq '.unreachable|length' "$OUT/$name.json") units=$(jq -c '.units' "$OUT/$name.json")"
}

# ---------- Step 2: hourly data per (metric, resource type) ----------
say ""; say "== Step 2: hourly data per metric and resource type (alignmentPeriod=3600s) =="
declare -A SEEN_SLUG=()
awk -F'\t' '$1=="missing"{print $2}' "$SEL" | while read -r m; do jq -nc --arg m "$m" '{metric:$m, role:"target", resourceType:null, name:null, noData:true, missing:true}' >> "$INDEX"; done
mapfile -t SELROWS < <(awk -F'\t' '$1=="anchor"||$1=="target"' "$SEL")
for row in "${SELROWS[@]}"; do
  role="${row%%$'\t'*}"; m="${row#*$'\t'}"
  kind="$(jq -r --arg t "$m" '.metricDescriptors[]|select(.type==$t)|.metricKind' "$OUT/metric-list.json")"
  vtype="$(jq -r --arg t "$m" '.metricDescriptors[]|select(.type==$t)|.valueType' "$OUT/metric-list.json")"
  case "$kind" in DELTA) al="ALIGN_SUM";; CUMULATIVE) al="ALIGN_DELTA";; GAUGE) al="ALIGN_MAX";; *) die "unsupported kind $kind for $m";; esac
  if [ "$role" = "anchor" ]; then [ "$kind" = "DELTA" ] && [ "$vtype" = "INT64" ] || die "metric $m is $kind/$vtype, expected DELTA/INT64"
  else [ "$kind" = "DELTA" ] && [[ "$vtype" =~ ^(INT64|DISTRIBUTION)$ ]] || die "metric $m is $kind/$vtype, expected DELTA/INT64 or DELTA/DISTRIBUTION"; fi
  ms="$(slug "${m#"$PREFIX"}")"
  hn="headers__$ms"
  list_ts "$hn" "$m" "" HEADERS ""
  [ "$(jq '.executionErrors|length' "$OUT/$hn.json")" -eq 0 ] || die "$hn: API reported executionErrors"
  [ "$(jq '.unreachable|length' "$OUT/$hn.json")" -eq 0 ] || die "$hn: API reported unreachable regions"
  [ "$(jq '[.timeSeries[].metric.type // empty] | unique | length' "$OUT/$hn.json")" -le 1 ] || die "$hn: series of more than one metric.type"
  mapfile -t RTS < <(jq -r '[.timeSeries[].resource.type]|unique[]' "$OUT/$hn.json")
  if [ "${#RTS[@]}" -eq 0 ]; then
    say "note: $m has no series in the window (no data); not queried"
    jq -nc --arg m "$m" --arg role "$role" '{metric:$m, role:$role, resourceType:null, name:null, noData:true}' >> "$INDEX"
    continue
  fi
  for rt in "${RTS[@]}"; do
    valid_rt "$rt" || die "resource type has characters that are not URL-safe: $rt"
    G=("resource.type")
    mapfile -t MK < <(jq -r --arg rt "$rt" '[.timeSeries[]|select(.resource.type==$rt)|.metric.labels // {} | keys[]]|unique[]' "$OUT/$hn.json")
    for k in "${MK[@]}"; do if [[ "$k" =~ ^[A-Za-z0-9_]+$ ]]; then G+=("metric.label.$k"); else say "note: label '$k' on $m not grouped (unexpected characters)"; fi; done
    n="ts__${ms}__$(slug "$rt")"
    [ -z "${SEEN_SLUG[$n]:-}" ] || die "two datasets map to the same file name: $n"
    SEEN_SLUG[$n]=1
    say "$m [$rt] kind=$kind value=$vtype aligner=$al groupBy: ${G[*]}"
    list_ts "$n" "$m" "$rt" FULL "$al" "${G[@]}"
    jq -nc --arg n "$n" --arg m "$m" --arg rt "$rt" --arg role "$role" --arg k "$kind" --arg v "$vtype" --arg al "$al" \
      '{name:$n, metric:$m, resourceType:$rt, role:$role, metricKind:$k, valueType:$v, aligner:$al, noData:false}' >> "$INDEX"
  done
done

# ---------- Step 3: verification and fact table ----------
say ""; say "== Step 3: verification and fact table =="
cat > "$OUT/verify.py" <<'PY'
import json, sys, re, datetime as dt, collections
OUT, START, END = sys.argv[1], sys.argv[2], sys.argv[3]
UTC = dt.timezone.utc; ICT = dt.timezone(dt.timedelta(hours=7)); H = dt.timedelta(hours=1)
_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$")
def ts(s):
    m = _TS.match(s)
    if not m: raise ValueError(f"unsupported timestamp format: {s!r}")
    t = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    frac = (m.group(2) or "0").ljust(9, "0")
    return t + dt.timedelta(microseconds=int(frac) // 1000) + (dt.timedelta(microseconds=1) if int(frac) % 1000 else dt.timedelta(0))
def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ")
def ict(e): return f"{(e-H).astimezone(ICT):%d %b %H:%M}-{e.astimezone(ICT):%H:%M}"
S, E = ts(START), ts(END)
HOURS = [S + H * (i + 1) for i in range(int((E - S) / H))]
M_READ = "firestore.googleapis.com/document/read_count"
M_OPS = "firestore.googleapis.com/document/read_ops_count"
M_QR = "firestore.googleapis.com/query_stat/per_query/result_counts"
M_QS = "firestore.googleapis.com/query_stat/per_query/scanned_documents_counts"
M_QI = "firestore.googleapis.com/query_stat/per_query/scanned_index_entries_counts"
TARGETS = (M_OPS, M_QR, M_QS, M_QI)
REF_RT = "firestore_instance"
# Reference 1: u1-reads.json (sha256 5231d15a...bd9), daily, UTC days.
U1_REF = [("2026-10-26T00:00:00Z","2026-10-27T00:00:00Z",5088), ("2026-10-27T00:00:00Z","2026-10-28T00:00:00Z",49720),
          ("2026-10-28T00:00:00Z","2026-10-29T00:00:00Z",5424), ("2026-10-29T00:00:00Z","2026-10-30T00:00:00Z",21375),
          ("2026-10-30T00:00:00Z","2026-10-31T00:00:00Z",6437)]
# Reference 2: Update 2 evidence (evidence/a1-usage-20261109/verify-summary.json, U1t|firestore_instance),
# hourly read_count for this window; hours not listed had no point there.
U1H_REF = json.loads('{"2026-10-26T02:00:00Z":496,"2026-10-26T04:00:00Z":489,"2026-10-26T05:00:00Z":1450,"2026-10-26T06:00:00Z":488,"2026-10-26T07:00:00Z":622,"2026-10-26T08:00:00Z":19,"2026-10-26T09:00:00Z":135,"2026-10-26T10:00:00Z":118,"2026-10-26T11:00:00Z":946,"2026-10-26T12:00:00Z":0,"2026-10-26T19:00:00Z":325,"2026-10-27T02:00:00Z":1308,"2026-10-27T03:00:00Z":1131,"2026-10-27T04:00:00Z":366,"2026-10-27T05:00:00Z":22636,"2026-10-27T06:00:00Z":715,"2026-10-27T07:00:00Z":113,"2026-10-27T08:00:00Z":109,"2026-10-27T09:00:00Z":6,"2026-10-27T10:00:00Z":127,"2026-10-27T11:00:00Z":6,"2026-10-27T12:00:00Z":6,"2026-10-27T13:00:00Z":125,"2026-10-27T18:00:00Z":9316,"2026-10-27T19:00:00Z":13701,"2026-10-27T20:00:00Z":0,"2026-10-27T21:00:00Z":55,"2026-10-28T01:00:00Z":2,"2026-10-28T02:00:00Z":1439,"2026-10-28T03:00:00Z":896,"2026-10-28T04:00:00Z":233,"2026-10-28T05:00:00Z":261,"2026-10-28T06:00:00Z":112,"2026-10-28T07:00:00Z":7,"2026-10-28T08:00:00Z":320,"2026-10-28T09:00:00Z":1091,"2026-10-28T10:00:00Z":319,"2026-10-28T12:00:00Z":8,"2026-10-28T13:00:00Z":339,"2026-10-28T14:00:00Z":0,"2026-10-28T16:00:00Z":62,"2026-10-28T19:00:00Z":335,"2026-10-29T01:00:00Z":34,"2026-10-29T02:00:00Z":1546,"2026-10-29T03:00:00Z":7408,"2026-10-29T04:00:00Z":990,"2026-10-29T05:00:00Z":118,"2026-10-29T06:00:00Z":107,"2026-10-29T07:00:00Z":124,"2026-10-29T08:00:00Z":187,"2026-10-29T09:00:00Z":199,"2026-10-29T10:00:00Z":124,"2026-10-29T11:00:00Z":128,"2026-10-29T12:00:00Z":7,"2026-10-29T14:00:00Z":120,"2026-10-29T18:00:00Z":329,"2026-10-29T19:00:00Z":497,"2026-10-29T20:00:00Z":359,"2026-10-29T21:00:00Z":2764,"2026-10-29T22:00:00Z":1878,"2026-10-29T23:00:00Z":3187,"2026-10-30T00:00:00Z":1269,"2026-10-30T01:00:00Z":23,"2026-10-30T02:00:00Z":4169,"2026-10-30T11:00:00Z":349,"2026-10-30T14:00:00Z":425,"2026-10-30T15:00:00Z":1136,"2026-10-30T19:00:00Z":335}')
# Hours flagged in Update 2 (bucket END times, UTC) + any hour with reads >= THRESH.
FLAGGED = ["2026-10-27T05:00:00Z", "2026-10-27T18:00:00Z", "2026-10-27T19:00:00Z", "2026-10-29T03:00:00Z",
           "2026-10-29T21:00:00Z", "2026-10-29T22:00:00Z", "2026-10-29T23:00:00Z", "2026-10-30T00:00:00Z",
           "2026-10-30T02:00:00Z"]
THRESH = 1000
fails, warns, notes, lines = [], [], [], []
def p(x=""): lines.append(x)

def load(ix):
    name, metric, rt = ix["name"], ix["metric"], ix["resourceType"]
    d = json.load(open(f"{OUT}/{name}.json"))
    if d["metric"] != metric or d["resourceType"] != rt or d["filter"] != f'metric.type="{metric}" AND resource.type="{rt}"':
        fails.append(f"{name}: query is not restricted to metric {metric} and resource.type {rt}")
    if (d["startTime"], d["endTime"]) != (START, END): fails.append(f"{name}: query window differs")
    if d["view"] != "FULL" or d["alignmentPeriod"] != "3600s" or d["perSeriesAligner"] != ix["aligner"] or d["crossSeriesReducer"] != "REDUCE_SUM":
        fails.append(f"{name}: aggregation parameters differ from 3600s/{ix['aligner']}/REDUCE_SUM")
    if d["executionErrors"]: fails.append(f"{name}: API executionErrors present: {d['executionErrors']}")
    if d["unreachable"]: fails.append(f"{name}: API reported unreachable regions: {d['unreachable']}")
    if len(d["units"]) > 1: fails.append(f"{name}: mixed units {d['units']}")
    if "{not_a_unit}" in d["units"]: fails.append(f"{name}: API reported unit {{not_a_unit}}")
    if not d["timeSeries"]: notes.append(f"{name}: no aggregated series returned (HEADERS showed series)")
    merged = collections.OrderedDict()
    for s in d["timeSeries"]:
        mt = s.get("metric", {}).get("type"); srt = s.get("resource", {}).get("type")
        if mt is not None and mt != metric: fails.append(f"{name}: series metric.type {mt} != {metric}")
        if srt != rt: fails.append(f"{name}: series resource.type {srt!r} != filtered type {rt!r}")
        key = json.dumps([s.get("metric", {}).get("labels", {}), srt, s.get("resource", {}).get("labels", {})], sort_keys=True)
        merged.setdefault(key, []).extend(s.get("points", []))
    hourly, hsum, series = collections.Counter(), collections.Counter(), []
    for key, pts in merged.items():
        seen, dups, conflict, offgrid, badlen, outside = {}, 0, 0, 0, 0, 0
        for pt in pts:
            try: e = ts(pt["interval"]["endTime"])
            except (KeyError, ValueError) as ex: fails.append(f"{name}: bad point interval ({ex})"); continue
            v = pt.get("value", {})
            if ix["valueType"] == "DISTRIBUTION":
                dv = v.get("distributionValue")
                if not isinstance(dv, dict): fails.append(f"{name}: expected distributionValue, got {v}"); continue
                try:
                    c = int(dv.get("count", "0")); mean = float(dv.get("mean", 0.0))
                except (TypeError, ValueError): fails.append(f"{name}: bad distribution {dv}"); continue
                if c < 0 or mean < 0: fails.append(f"{name}: negative distribution at {iso(e)}"); continue
                v = (c, round(c * mean, 6))      # (number of queries, sum of the measured values)
            elif "int64Value" in v and ix["valueType"] == "INT64": v = int(v["int64Value"])
            else: fails.append(f"{name}: unsupported point value {v}"); continue
            if not isinstance(v, tuple) and v < 0: fails.append(f"{name}: negative value at {iso(e)}")
            if (E - e) % H or e.microsecond: offgrid += 1; continue
            st = pt["interval"].get("startTime")
            if st and ix["metricKind"] != "GAUGE" and e - ts(st) != H: badlen += 1
            if e <= S or e > E: outside += 1; continue
            if e in seen:
                dups += 1
                if seen[e] != v: conflict += 1
                continue
            seen[e] = v
        lbl = json.loads(key)
        if offgrid: fails.append(f"{name}: {offgrid} points not on the hourly grid {lbl}")
        if badlen: fails.append(f"{name}: {badlen} points whose interval is not 1 hour {lbl}")
        if conflict: fails.append(f"{name}: {conflict} duplicate points with DIFFERENT values {lbl}")
        if dups - conflict: warns.append(f"{name}: {dups-conflict} identical duplicate points ignored {lbl}")
        if outside: warns.append(f"{name}: {outside} points outside the window excluded {lbl}")
        dist = ix["valueType"] == "DISTRIBUTION"
        for e, v in seen.items():
            if dist: hourly[e] += v[0]; hsum[e] += v[1]
            else: hourly[e] += v
        series.append({"metricLabels": lbl[0], "resourceLabels": lbl[2], "points": len(seen),
                       "total": sum(v[0] for v in seen.values()) if dist else sum(seen.values()),
                       "sum": round(sum(v[1] for v in seen.values()), 3) if dist else None,
                       "hourly": {iso(e): (list(v) if dist else v) for e, v in sorted(seen.items())}})
    return {"ix": ix, "hourly": hourly, "hsum": hsum, "series": series}

INDEX = [json.loads(l) for l in open(f"{OUT}/datasets.jsonl") if l.strip()]
DS = {}
for ix in INDEX:
    if ix.get("noData"): p(f"metric with no series in window: {ix['metric']} ({ix['role']})"); continue
    DS[(ix["metric"], ix["resourceType"])] = load(ix)
for m in TARGETS:
    ent = [ix for ix in INDEX if ix["metric"] == m]
    if not ent or any(ix.get("missing") for ix in ent): notes.append(f"{m} is not in the metric list: not collected")
    elif all(ix.get("noData") for ix in ent): notes.append(f"{m} has NO series in the window: no data is not zero; this question stays unanswered")
p(f"window {START} .. {END} = {len(HOURS)} hourly buckets; datasets = {len(DS)}")
p("RULE: values are kept per metric and per resource type; nothing is added across them.")

p("## 1. read_count consistency with earlier evidence")
rd = DS.get((M_READ, REF_RT))
if rd is None:
    fails.append(f"read_count for resource.type {REF_RT} not collected"); reads = collections.Counter()
else:
    reads = rd["hourly"]
    ref = {ts(k): v for k, v in U1H_REF.items()}
    bad = [h for h in HOURS if reads.get(h, 0) != ref.get(h, 0)]
    p(f"  hourly vs Update 2 evidence: hours differing = {len(bad)}" + (f" (first: {', '.join(iso(h) for h in bad[:5])})" if bad else ""))
    if bad: fails.append(f"read_count differs from Update 2 evidence in {len(bad)} hours")
    for st, en, r in U1_REF:
        a, b = ts(st), ts(en); got = sum(v for e, v in reads.items() if a < e <= b)
        p(f"  {st[:10]}: hourly-sum={got} u1={r} {'MATCH' if got == r else 'MISMATCH'}")
        if got != r: fails.append(f"read_count {st[:10]}: {got} != U1 {r}")
others = [k for k in DS if k[0] == M_READ and k[1] != REF_RT]
if others: notes.append(f"read_count also present on {[k[1] for k in others]}; table uses {REF_RT} only")

def by_label(m, key):
    """{label value [resource]: (Counter count/value per hour, Counter sum per hour)}; one resource type at a time."""
    out = {}
    for (mm, rt), d in DS.items():
        if mm != m: continue
        dist = d["ix"]["valueType"] == "DISTRIBUTION"
        for sr in d["series"]:
            k = f"{sr['metricLabels'].get(key, '?')} [{rt.split('/')[-1]}]"
            c, sm = out.setdefault(k, (collections.Counter(), collections.Counter()))
            for e, v in sr["hourly"].items():
                if dist: c[ts(e)] += v[0]; sm[ts(e)] += v[1]
                else: c[ts(e)] += v
    return out
days = sorted({(h - H).date() for h in HOURS})
short = lambda m: m.split("/", 1)[1]

p("## 2. Per UTC day, per metric and label (nothing added across resource types or metrics)")
for m in TARGETS:
    for (mm, rt), d in sorted(DS.items()):
        if mm != m: continue
        dist = d["ix"]["valueType"] == "DISTRIBUTION"
        tot, tsum = collections.Counter(), collections.Counter()
        for e, v in d["hourly"].items(): tot[(e - H).date()] += v
        for e, v in d["hsum"].items(): tsum[(e - H).date()] += v
        if dist:
            p(f"  {short(m)} [{rt}] queries per day: " + ", ".join(f"{x:%d %b}={tot[x]}" for x in days)
              + "; mean per query per day: " + ", ".join(f"{x:%d %b}={(tsum[x]/tot[x]) if tot[x] else float('nan'):.1f}" for x in days))
        else:
            p(f"  {short(m)} [{rt}]: " + ", ".join(f"{x:%d %b}={tot[x]}" for x in days) + f"; total={sum(d['hourly'].values())}")
    key = "type" if m == M_OPS else "method"
    for k, (c, sm) in sorted(by_label(m, key).items(), key=lambda kv: -sum(kv[1][0].values())):
        extra = f" mean={sum(sm.values())/sum(c.values()):.1f}" if sum(sm.values()) and sum(c.values()) else ""
        p(f"     by {key} {k}: total={sum(c.values())} hours={len(c)}{extra}")

p("## 3. read_ops_count vs read_count per hour (information; not expected to be equal)")
for (mm, rt), d in sorted(DS.items()):
    if mm == M_OPS:
        same = sum(1 for h in HOURS if d["hourly"].get(h, 0) == reads.get(h, 0))
        p(f"  read_ops_count[{rt}] total={sum(d['hourly'].values())} vs read_count={sum(reads.values())}; hours equal={same}/{len(HOURS)}")

p(f"## 4. Fact table: flagged hours (Updates 2/3 + reads >= {THRESH}); UTC bucket end and Thailand time")
p("  legend: 'no data' = the metric has no series at all; '0?' = the metric has series but no point this hour (NOT verified zero)")
flag = sorted({ts(x) for x in FLAGGED} | {h for h in HOURS if reads.get(h, 0) >= THRESH})
has = {m: any(k[0] == m for k in DS) for m in TARGETS}
ops_t = by_label(M_OPS, "type"); qr = by_label(M_QR, "method"); qs = by_label(M_QS, "method")
def cell(m, groups, h, dist):
    if not has[m]: return "no data"
    parts = []
    for k, (c, sm) in sorted(groups.items(), key=lambda kv: -kv[1][0].get(h, 0)):
        if h in c and c[h]: parts.append(f"{k}: {c[h]}" + (f" q, mean {sm[h]/c[h]:.1f}" if dist else ""))
    return "; ".join(parts) or "0?"
table = []
for h in flag:
    row = {"utcEnd": iso(h), "thailand": ict(h), "reads": reads.get(h, 0),
           "read_ops_by_type": cell(M_OPS, ops_t, h, False), "results_per_query": cell(M_QR, qr, h, True), "scanned_docs_per_query": cell(M_QS, qs, h, True)}
    table.append(row)
    p(f"  {iso(h)} | {ict(h)} | reads={row['reads']} | read_ops: {row['read_ops_by_type']} | results/query: {row['results_per_query']} | scanned/query: {row['scanned_docs_per_query']}")

p("## 5. What each result would support (hypotheses, NOT conclusions)")
p("  - many queries per hour with a small mean result: many small reads (e.g. repeated page opens).")
p("  - few queries with a large mean result: large queries (Pattern A in Update 3: many documents per rules evaluation).")
p("  - scanned documents per query much larger than results per query: queries that scan more than they return.")
p("  - 'service' / 'method' labels show the API surface; they do not identify the app, user or collection.")

p("## 6. Interpretation limits")
p("  - Cloud Monitoring values, not the Spark quota ledger. No metric here identifies the app, user or collection.")
p("  - Distribution means are hourly averages per query; they do not show single large queries inside an hour.")

status = "FAIL" if fails else ("INCOMPLETE" if notes else "PASS")
p(""); p("WARNINGS:"); [p("  - " + w) for w in warns] or p("  none")
p("INCOMPLETE-EVIDENCE NOTES:"); [p("  - " + n) for n in notes] or p("  none")
p("FAILURES:"); [p("  - " + f) for f in fails] or p("  none")
p(f"VERIFY STATUS: {status}")
summary = {"window": [START, END], "status": status, "failures": fails, "warnings": warns, "notes": notes,
           "flaggedHours": table,
           "datasets": {f"{m}|{rt}": {"name": d["ix"]["name"], "role": d["ix"]["role"], "metricKind": d["ix"]["metricKind"],
                                      "valueType": d["ix"]["valueType"], "aligner": d["ix"]["aligner"], "series": d["series"],
                                      "hourlyTotal": {iso(h): v for h, v in sorted(d["hourly"].items())}} for (m, rt), d in DS.items()}}
json.dump(summary, open(f"{OUT}/verify-summary.json", "w"), indent=1)
open(f"{OUT}/verify-report.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit({"PASS": 0, "INCOMPLETE": 3, "FAIL": 2}[status])
PY
set +e; python3 -I "$OUT/verify.py" "$OUT" "$START" "$END" 2>&1 | tee -a "$LOG"; VRC=${PIPESTATUS[0]}; set -e
case "$VRC" in 0|2|3) ;; *) VRC=4;; esac

# ---------- Step 4: token check + package ----------
leak_check || die "token-like string found; package NOT created"
say "token check: no token or token-like string in output"
tar -czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT").tar.gz" ) | tee "$OUT.tar.gz.sha256"
say "package: $OUT.tar.gz"
case "$VRC" in
  0) say "RESULT: verification PASS";;
  3) say "RESULT: verification INCOMPLETE - send the package; do not edit files";;
  2) say "RESULT: verification FAIL - send the package; do not edit files";;
  *) say "RESULT: verifier crashed (exit $VRC) - send the package and this log";;
esac
exit "$VRC"   # 0 PASS, 3 INCOMPLETE, 2 FAIL, 4 verifier crash; 1 = STOP before verification; 9 = token-like string found
