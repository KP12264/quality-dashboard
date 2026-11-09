#!/usr/bin/env bash
# A1/A2 usage collection v4 (U1h, U1t, U2, U2m, U2t per resource type) - READ-ONLY.
# Only HTTP GET calls to the Cloud Monitoring API v3:
#   metricDescriptors.get, monitoredResourceDescriptors.get, timeSeries.list.
# Nothing is created, changed or deleted; no gcloud configuration is changed.
# The access token is held only in a shell variable, passed to curl on stdin,
# never printed, never written to disk, and redacted from any error text.
#
# v4: every timeSeries query is restricted to ONE monitored resource type
# (filter: metric.type AND resource.type), because request_count is reported
# under several resource types (e.g. datastore_request and
# firestore.googleapis.com/Database). Totals are never added across types.
set +x
set -euo pipefail
umask 077

PROJECT="daily-production-report-46b60"
# Window: UTC days 26 Oct .. 1 Nov 2026 (168 hours). Covers the Pacific quota
# days 26..31 Oct completely (31 Oct PDT = 07:00Z 31 Oct -> 07:00Z 1 Nov) and
# all U1 reference days 26 Oct .. 1 Nov. PT 1 Nov (25 h, DST ends) is partial.
START="2026-10-26T00:00:00Z"
END="2026-11-02T00:00:00Z"
API="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
M_READ="firestore.googleapis.com/document/read_count"
M_REQ="firestore.googleapis.com/api/request_count"
OUT="$HOME/a1-usage-$(date -u +%Y%m%dT%H%M%SZ)"
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
# Resource type names as returned by the API, e.g. "firestore_instance",
# "datastore_request", "firestore.googleapis.com/Database". Only URL-safe
# characters are accepted, so the name can be placed in the path as-is
# (the API path template is v3/{+name}: '/' is NOT percent-encoded).
valid_rt() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] && [[ "$1" != *..* ]] && [[ "$1" != *//* ]] && [[ "$1" != */ ]]; }

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

say "script  : a1-collect.sh v4 (read-only)"
say "account : $(gcloud config get-value account 2>/dev/null)"
say "project : $PROJECT"
say "window  : $START -> $END"
say "curl    : $CURLV"

# api_fetch URL OUTFILE -> 0 on success; 1 on HTTP/API error (redacted summary logged, body removed).
# Transport failures always STOP.
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
    rm -f "$out"   # raw error body is not kept; only the redacted summary above is logged
    return 1
  fi
  return 0
}
api_get() { api_fetch "$1" "$2" || die "API call failed (see above). Nothing was changed."; }

# ---------- Step 1: descriptors ----------
say ""; say "== Step 1: metric and resource descriptors =="
api_get "$API/metricDescriptors/$M_READ" "$OUT/raw/desc-read_count.json"
api_get "$API/metricDescriptors/$M_REQ"  "$OUT/raw/desc-request_count.json"
for f in read_count request_count; do
  d="$OUT/raw/desc-$f.json"
  jq -r --arg f "$f" '"\($f): type=\(.type) kind=\(.metricKind) value=\(.valueType) unit=\(.unit // "") labels=[\([.labels[]?.key]|join(","))] resources=[\((.monitoredResourceTypes // [])|join(","))]"' "$d" | tee -a "$LOG"
  [ "$(jq -r .metricKind "$d")" = "DELTA" ] || die "$f is not DELTA; ALIGN_SUM would be wrong"
  [ "$(jq -r .valueType "$d")" = "INT64" ] || die "$f is not INT64"
done
[ "$(jq -r .type "$OUT/raw/desc-read_count.json")" = "$M_READ" ] || die "descriptor type mismatch for read_count"
[ "$(jq -r .type "$OUT/raw/desc-request_count.json")" = "$M_REQ" ] || die "descriptor type mismatch for request_count"

mapfile -t DECL_RTS < <(jq -r '(.monitoredResourceTypes // [])[]' "$OUT"/raw/desc-*.json | sort -u)
[ "${#DECL_RTS[@]}" -gt 0 ] || die "descriptors list no monitored resource types"
[ "${#DECL_RTS[@]}" -le 10 ] || die "more than 10 resource types declared; refusing"
for rt in "${DECL_RTS[@]}"; do
  valid_rt "$rt" || die "resource type name has characters that are not URL-safe: $rt"
  # Descriptor lookup is informational only (labels are also taken from real data in Step 2),
  # so an API error here is logged and collection continues.
  if api_fetch "$API/monitoredResourceDescriptors/$rt" "$OUT/raw/resdesc-$(slug "$rt").json"; then
    jq -r --arg rt "$rt" '"resource \($rt): type=\(.type) labels=[\([.labels[]?.key]|join(","))]"' "$OUT/raw/resdesc-$(slug "$rt").json" | tee -a "$LOG"
    [ "$(jq -r '.type // empty' "$OUT/raw/resdesc-$(slug "$rt").json")" = "$rt" ] || say "note: descriptor for $rt returned a different .type"
  else
    say "note: monitoredResourceDescriptors.get failed for $rt (see above); continuing with labels seen in data"
  fi
done

# Exact metric label names only; no guessing.
REQ_KEYS="$(jq -c '[.labels[]?.key]' "$OUT/raw/desc-request_count.json")"
pick() { jq -r --argjson k "$REQ_KEYS" -n "$1"; }
CODE_KEY="$(pick '[$k[]|select(.=="response_code")][0] // empty')"
METHOD_KEY="$(pick '([$k[]|select(.=="api_method")] + [$k[]|select(.=="method")])[0] // empty')"
[ -n "$CODE_KEY" ]   || die "request_count has no label named response_code (labels: $REQ_KEYS). Send this log."
[ -n "$METHOD_KEY" ] || die "request_count has no label named api_method or method (labels: $REQ_KEYS). Send this log."
mapfile -t READ_KEYS < <(jq -r '.labels[]?.key' "$OUT/raw/desc-read_count.json")

# ---------- paginated timeSeries.list ----------
# list_ts NAME KIND METRIC RTYPE VIEW AGG(yes|no) [groupByField ...]   (RTYPE "" = no resource filter)
list_ts() {
  local name="$1" kind="$2" metric="$3" rtype="$4" view="$5" agg="$6"; shift 6
  local filter="metric.type=\"$metric\""
  [ -z "$rtype" ] || filter="$filter AND resource.type=\"$rtype\""
  local base="$API/timeSeries?filter=$(enc "$filter")&interval.startTime=$(enc "$START")&interval.endTime=$(enc "$END")&view=$view&pageSize=10000"
  local aligner="" reducer="" period=""
  if [ "$agg" = "yes" ]; then
    aligner="ALIGN_SUM"; reducer="REDUCE_SUM"; period="3600s"
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
  jq -s --arg n "$name" --arg k "$kind" --arg m "$metric" --arg rt "$rtype" --arg flt "$filter" --arg v "$view" \
        --arg s "$START" --arg e "$END" --arg al "$aligner" --arg rd "$reducer" --arg ap "$period" \
        --argjson g "$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(length>0))')" \
     '{name:$n, kind:$k, metric:$m, resourceType:$rt, filter:$flt, view:$v, startTime:$s, endTime:$e,
       alignmentPeriod:$ap, perSeriesAligner:$al, crossSeriesReducer:$rd, groupByFields:$g,
       pages:length, units:(map(.unit // empty)|unique),
       executionErrors:(map(.executionErrors // [])|add),
       unreachable:(map(.unreachable // [])|add),
       timeSeries:(map(.timeSeries // [])|add)}' "$OUT/raw/$name"-p*.json > "$OUT/$name.json"
  say "$name: pages=$page rawSeries=$(jq '.timeSeries|length' "$OUT/$name.json") executionErrors=$(jq '.executionErrors|length' "$OUT/$name.json") unreachable=$(jq '.unreachable|length' "$OUT/$name.json") units=$(jq -c '.units' "$OUT/$name.json")"
  if [ "$view" = "FULL" ]; then
    jq -nc --arg n "$name" --arg k "$kind" --arg m "$metric" --arg rt "$rtype" '{name:$n, kind:$k, metric:$m, resourceType:$rt}' >> "$INDEX"
  fi
}

# ---------- Step 2: resource types and labels present in real data (HEADERS) ----------
say ""; say "== Step 2: resource types and labels present in real series (view=HEADERS) =="
list_ts headers-read_count    headers "$M_READ" "" HEADERS no
list_ts headers-request_count headers "$M_REQ"  "" HEADERS no
for n in headers-read_count headers-request_count; do
  [ "$(jq '.timeSeries|length' "$OUT/$n.json")" -gt 0 ] || die "$n: no series in window (wrong project, no permission scope, or data past retention)"
  [ "$(jq '.executionErrors|length' "$OUT/$n.json")" -eq 0 ] || die "$n: API reported executionErrors (data may be incomplete)"
  [ "$(jq '.unreachable|length' "$OUT/$n.json")" -eq 0 ] || die "$n: API reported unreachable regions (data may be incomplete)"
  jq -r --arg n "$n" '.timeSeries | group_by(.resource.type)[] |
     "\($n): resource.type=\(.[0].resource.type) series=\(length) metric.types=[\([.[].metric.type]|unique|join(","))] metric labels=[\([.[].metric.labels // {} | keys[]]|unique|join(","))] resource labels=[\([.[].resource.labels // {} | keys[]]|unique|join(","))]"' \
     "$OUT/$n.json" | tee -a "$LOG"
  [ "$(jq '[.timeSeries[].metric.type // empty] | unique | length' "$OUT/$n.json")" -le 1 ] || die "$n: series of more than one metric.type returned"
done
mapfile -t READ_RTS < <(jq -r '[.timeSeries[].resource.type]|unique[]' "$OUT/headers-read_count.json")
mapfile -t REQ_RTS  < <(jq -r '[.timeSeries[].resource.type]|unique[]' "$OUT/headers-request_count.json")
for rt in "${READ_RTS[@]}" "${REQ_RTS[@]}"; do
  valid_rt "$rt" || die "resource type in data has characters that are not URL-safe: $rt"
  printf '%s\n' "${DECL_RTS[@]}" | grep -qxF -- "$rt" || say "note: resource type $rt present in data but not declared by the metric descriptor"
done
for rt in "${DECL_RTS[@]}"; do
  printf '%s\n' "${READ_RTS[@]}" "${REQ_RTS[@]}" | grep -qxF -- "$rt" || say "note: declared resource type $rt has no series in the window; not queried"
done

ALL_RTS=("${READ_RTS[@]}" "${REQ_RTS[@]}")
[ "$(for rt in "${ALL_RTS[@]}"; do slug "$rt"; echo; done | sort | uniq -d | wc -l)" -eq 0 ] \
  || die "two resource types map to the same file name; refusing to continue"

# label helpers restricted to one resource type
mlabel_in() { jq -e --arg rt "$2" --arg k "$3" '[.timeSeries[]|select(.resource.type==$rt)|.metric.labels // {} | keys[]] | index($k) != null' "$OUT/$1.json" >/dev/null; }
rlabel_in() { jq -e --arg rt "$2" --arg k "$3" '[.timeSeries[]|select(.resource.type==$rt)|.resource.labels // {} | keys[]] | index($k) != null' "$OUT/$1.json" >/dev/null; }

# ---------- Step 3: hourly aggregated data, one query per (metric, resource type) ----------
say ""; say "== Step 3: hourly data (alignmentPeriod=3600s, ALIGN_SUM, REDUCE_SUM), per resource type =="
for rt in "${READ_RTS[@]}"; do
  s="$(slug "$rt")"
  G=("resource.type")
  rlabel_in headers-read_count "$rt" database_id && G+=("resource.label.database_id")
  for k in "${READ_KEYS[@]}"; do mlabel_in headers-read_count "$rt" "$k" && G+=("metric.label.$k"); done
  say "read_count [$rt] groupBy: ${G[*]}"
  list_ts "U1h-read_count-hourly__$s" U1h "$M_READ" "$rt" FULL yes "${G[@]}"
  list_ts "U1t-read_count-total__$s"  U1t "$M_READ" "$rt" FULL yes "resource.type"
done
for rt in "${REQ_RTS[@]}"; do
  s="$(slug "$rt")"
  B=("resource.type")
  rlabel_in headers-request_count "$rt" database_id && B+=("resource.label.database_id")
  mlabel_in headers-request_count "$rt" "$CODE_KEY"   || say "note: [$rt] series carry no $CODE_KEY label; U2 for this type will show one unlabelled group"
  mlabel_in headers-request_count "$rt" "$METHOD_KEY" || say "note: [$rt] series carry no $METHOD_KEY label; U2m for this type will show one unlabelled group"
  say "request_count [$rt] base groupBy: ${B[*]}"
  list_ts "U2-request_count-by-code__$s"    U2  "$M_REQ" "$rt" FULL yes "${B[@]}" "metric.label.$CODE_KEY"
  list_ts "U2m-request_count-by-method__$s" U2m "$M_REQ" "$rt" FULL yes "${B[@]}" "metric.label.$METHOD_KEY"
  list_ts "U2t-request_count-total__$s"     U2t "$M_REQ" "$rt" FULL yes "resource.type"
done

# ---------- Step 4: verification ----------
say ""; say "== Step 4: verification =="
cat > "$OUT/verify.py" <<'PY'
import json, sys, re, datetime as dt, collections
OUT, START, END = sys.argv[1], sys.argv[2], sys.argv[3]
UTC = dt.timezone.utc
ICT = dt.timezone(dt.timedelta(hours=7))
H = dt.timedelta(hours=1)
_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$")
def ts(s):
    m = _TS.match(s)
    if not m: raise ValueError(f"unsupported timestamp format: {s!r}")
    t = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    frac = (m.group(2) or "0").ljust(9, "0")
    return t + dt.timedelta(microseconds=int(frac) // 1000) + (dt.timedelta(microseconds=1) if int(frac) % 1000 else dt.timedelta(0))
def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ")
def bucket(e):  # "(start..end] UTC | ICT"
    return f"{iso(e-H)}..{e:%H:%M}Z | ICT {(e-H).astimezone(ICT):%d %b %H:%M}-{e.astimezone(ICT):%H:%M}"
S, E = ts(START), ts(END)
HOURS = [S + H * (i + 1) for i in range(int((E - S) / H))]   # bucket END times; bucket = (end-1h, end]
M_READ = "firestore.googleapis.com/document/read_count"
M_REQ = "firestore.googleapis.com/api/request_count"

# Reference: docs/release-readiness/evidence/u1-reads.json
# sha256 5231d15a871457d13e4581286a93f68028784ef2cf1a2fd2f84fa794cc5ebbd9
# one series, metric read_count, resource.type firestore_instance; intervals used as written.
REF_RT = "firestore_instance"
U1_REF = [
 ("2026-10-24T00:00:00Z","2026-10-25T00:00:00Z",323), ("2026-10-25T00:00:00Z","2026-10-26T00:00:00Z",323),
 ("2026-10-26T00:00:00Z","2026-10-27T00:00:00Z",5088), ("2026-10-27T00:00:00Z","2026-10-28T00:00:00Z",49720),
 ("2026-10-28T00:00:00Z","2026-10-29T00:00:00Z",5424), ("2026-10-29T00:00:00Z","2026-10-30T00:00:00Z",21375),
 ("2026-10-30T00:00:00Z","2026-10-31T00:00:00Z",6437), ("2026-10-31T00:00:00Z","2026-11-01T00:00:00Z",335),
 ("2026-11-01T00:00:00Z","2026-11-02T00:00:00Z",335), ("2026-11-02T00:00:00Z","2026-11-03T00:00:00Z",7509),
 ("2026-11-03T00:00:00Z","2026-11-04T00:00:00Z",5958), ("2026-11-04T00:00:00Z","2026-11-05T00:00:00Z",12595),
 ("2026-11-05T00:00:00Z","2026-11-06T00:00:00Z",6161), ("2026-11-06T00:00:00Z","2026-11-07T00:00:00Z",8474)]

fails, warns, notes, lines = [], [], [], []
def p(x=""): lines.append(x)
def rng(hs):
    hs = sorted(hs)
    if not hs: return "none"
    out, a, b = [], hs[0], hs[0]
    for h in hs[1:]:
        if h - b == H: b = h
        else: out.append((a, b)); a = b = h
    out.append((a, b))
    return ", ".join(f"{iso(x-H)}..{iso(y)}" for x, y in out)

def load(ix):
    name, kind, metric, rt = ix["name"], ix["kind"], ix["metric"], ix["resourceType"]
    d = json.load(open(f"{OUT}/{name}.json"))
    want_filter = f'metric.type="{metric}" AND resource.type="{rt}"'
    if d["metric"] != metric or d["resourceType"] != rt or d["filter"] != want_filter:
        fails.append(f"{name}: query is not restricted to metric {metric} and resource.type {rt}")
    if (kind.startswith("U1") and metric != M_READ) or (kind.startswith("U2") and metric != M_REQ):
        fails.append(f"{name}: dataset {kind} uses the wrong metric {metric}")
    if (d["startTime"], d["endTime"]) != (START, END): fails.append(f"{name}: query window differs")
    if d["view"] != "FULL" or d["alignmentPeriod"] != "3600s" or d["perSeriesAligner"] != "ALIGN_SUM" or d["crossSeriesReducer"] != "REDUCE_SUM":
        fails.append(f"{name}: aggregation parameters differ from 3600s/ALIGN_SUM/REDUCE_SUM")
    if d["executionErrors"]: fails.append(f"{name}: API executionErrors present: {d['executionErrors']}")
    if d["unreachable"]: fails.append(f"{name}: API reported unreachable regions: {d['unreachable']}")
    if len(d["units"]) > 1: fails.append(f"{name}: mixed units {d['units']}")
    if "{not_a_unit}" in d["units"]: fails.append(f"{name}: API reported unit {{not_a_unit}}")
    if not d["timeSeries"]: fails.append(f"{name}: no time series returned")
    merged = collections.OrderedDict()
    for s in d["timeSeries"]:
        mt = s.get("metric", {}).get("type")
        srt = s.get("resource", {}).get("type")
        if mt is not None and mt != metric: fails.append(f"{name}: series metric.type {mt} != {metric}")
        if srt != rt: fails.append(f"{name}: series resource.type {srt!r} != filtered type {rt!r} (types would be mixed)")
        if s.get("metricKind") not in (None, "DELTA"): fails.append(f"{name}: series metricKind {s.get('metricKind')}")
        if s.get("valueType") not in (None, "INT64"): fails.append(f"{name}: series valueType {s.get('valueType')}")
        key = json.dumps([s.get("metric", {}).get("labels", {}), srt, s.get("resource", {}).get("labels", {})], sort_keys=True)
        merged.setdefault(key, []).extend(s.get("points", []))
    hourly, series = collections.Counter(), []
    for key, pts in merged.items():
        seen, dups, conflict, offgrid, badlen, outside = {}, 0, 0, 0, 0, 0
        for pt in pts:
            try:
                e = ts(pt["interval"]["endTime"])
            except (KeyError, ValueError) as ex:
                fails.append(f"{name}: bad point interval ({ex})"); continue
            v = pt.get("value", {})
            if "int64Value" not in v: fails.append(f"{name}: non-INT64 point {v}"); continue
            v = int(v["int64Value"])
            if v < 0: fails.append(f"{name}: negative value at {iso(e)}")
            if (E - e) % H or e.microsecond: offgrid += 1; continue
            st = pt["interval"].get("startTime")
            if st and e - ts(st) != H: badlen += 1
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
        for e, v in seen.items(): hourly[e] += v
        series.append({"metricLabels": lbl[0], "resourceType": lbl[1], "resourceLabels": lbl[2],
                       "points": len(seen), "total": sum(seen.values()),
                       "hourly": {iso(e): v for e, v in sorted(seen.items())}})
    return {"ix": ix, "d": d, "hourly": hourly, "series": series}

INDEX = [json.loads(l) for l in open(f"{OUT}/datasets.jsonl") if l.strip()]
DS = {(ix["kind"], ix["resourceType"]): load(ix) for ix in INDEX}
READ_RTS = sorted({rt for k, rt in DS if k.startswith("U1")})
REQ_RTS = sorted({rt for k, rt in DS if k.startswith("U2")})
p(f"window {START} .. {END} = {len(HOURS)} hourly buckets")
p(f"read_count resource types   : {READ_RTS}")
p(f"request_count resource types: {REQ_RTS}")
p("RULE: totals are kept per resource type and are never added across resource types.")

def same_dataset(a, b):
    da, db = DS[a]["d"], DS[b]["d"]
    keys = ["metric", "resourceType", "filter", "startTime", "endTime", "alignmentPeriod", "perSeriesAligner", "crossSeriesReducer", "units"]
    diff = [k for k in keys if da[k] != db[k]]
    if diff: fails.append(f"{a} vs {b}: not the same dataset ({', '.join(diff)}); totals not compared")
    return not diff
def compare(a, b):
    if a not in DS or b not in DS:
        fails.append(f"missing dataset for comparison {a} / {b}"); return
    if not same_dataset(a, b): p(f"  {a[0]} vs {b[0]} [{a[1]}]: NOT COMPARED (different dataset)"); return
    ha, hb = DS[a]["hourly"], DS[b]["hourly"]
    bad = [h for h in HOURS if ha.get(h, 0) != hb.get(h, 0)]
    p(f"  {a[0]} vs {b[0]} [{a[1]}]: same metric/resource/window/aggregation; hours differing = {len(bad)} ({rng(bad)})")
    if bad: fails.append(f"{a[0]} vs {b[0]} [{a[1]}]: hourly totals differ in {len(bad)} hours")

p("## 1. Same-dataset checks and hour-by-hour totals (within one resource type)")
for rt in READ_RTS: compare(("U1h", rt), ("U1t", rt))
for rt in REQ_RTS:
    compare(("U2", rt), ("U2t", rt)); compare(("U2m", rt), ("U2t", rt))

p(f"## 2. U1 reference (u1-reads.json, resource.type {REF_RT}) vs hourly sums, reference intervals as written")
matched_ref = []
if ("U1t", REF_RT) not in DS:
    fails.append(f"read_count for resource.type {REF_RT} was not collected; reference cannot be compared")
    reads = collections.Counter()
else:
    reads = DS[("U1t", REF_RT)]["hourly"]
    compared = 0
    for st, en, ref in U1_REF:
        a, b = ts(st), ts(en)
        if (b - a) % H or (E - a) % H:
            p(f"  {st}..{en}: reference interval not on the hourly grid -> NOT COMPARABLE"); continue
        if a < S or b > E:
            p(f"  {st}..{en}: outside collected window -> not compared"); continue
        got = sum(v for e, v in reads.items() if a < e <= b)
        compared += 1
        ok = got == ref
        p(f"  {st}..{en}: hourly-sum={got} u1={ref} {'MATCH' if ok else 'MISMATCH'}")
        if ok: matched_ref.append((a, b))
        else: fails.append(f"U1 reference {st}..{en}: hourly sum {got} != {ref}")
    if compared == 0: fails.append("no U1 reference interval could be compared")
other_read = [rt for rt in READ_RTS if rt != REF_RT]
if other_read:
    notes.append(f"read_count also reported under {other_read}; quota figures below cover {REF_RT} only")

p("## 3. Hours with no data point (API omits empty buckets; absence is not proof of zero)")
m = [h for h in HOURS if h not in reads]
ok = [h for h in m if any(a < h <= b for a, b in matched_ref)]
un = [h for h in m if h not in ok]
p(f"  read_count [{REF_RT}]: no-point hours={len(m)}; inside a MATCHED U1 interval (consistent with zero)={len(ok)}; unverified={len(un)} ({rng(un)})")
any_req = set()
for rt in REQ_RTS:
    hr = DS[("U2t", rt)]["hourly"]; any_req |= set(hr)
    p(f"  request_count [{rt}]: hours with a point={len(hr)}/{len(HOURS)} (information only)")
r_unv = [h for h in HOURS if h not in any_req and h in reads]
p(f"  hours with reads>0 but no request point in ANY request resource type (unverified)={len(r_unv)} ({rng(r_unv)})")
p("  note: 'consistent with zero' means an independent query of the same backend agrees; it cannot rule out a gap present in both queries.")
if un: notes.append(f"{len(un)} read_count hours have no point and are not covered by a matched reference interval")
if r_unv: notes.append(f"{len(r_unv)} hours have reads but no request point in any request resource type")

p("## 4. request_count resource types side by side (NOT added together)")
if len(REQ_RTS) > 1:
    for i in range(len(REQ_RTS)):
        for j in range(i + 1, len(REQ_RTS)):
            A, B = DS[("U2t", REQ_RTS[i])]["hourly"], DS[("U2t", REQ_RTS[j])]["hourly"]
            both = [h for h in HOURS if h in A and h in B]
            equal = [h for h in both if A[h] == B[h]]
            p(f"  {REQ_RTS[i]} total={sum(A.values())} vs {REQ_RTS[j]} total={sum(B.values())}; hours with both={len(both)}; hours with identical values={len(equal)}")
    p("  note: whether the types overlap (same requests reported twice) cannot be decided from these numbers alone.")
for rt in REQ_RTS:
    p(f"  [{rt}] by {DS[('U2', rt)]['d']['groupByFields'][-1]}:")
    for s in sorted(DS[("U2", rt)]["series"], key=lambda s: -s["total"]):
        p(f"     {s['metricLabels']} {s['resourceLabels']}: total={s['total']} hours={s['points']}")
    p(f"  [{rt}] by {DS[('U2m', rt)]['d']['groupByFields'][-1]}:")
    for s in sorted(DS[("U2m", rt)]["series"], key=lambda s: -s["total"]):
        p(f"     {s['metricLabels']} {s['resourceLabels']}: total={s['total']} hours={s['points']}")

p(f"## 5. Pacific-time quota days for read_count [{REF_RT}] (America/Los_Angeles, DST-aware)")
quota = []
try:
    from zoneinfo import ZoneInfo
    LA = ZoneInfo("America/Los_Angeles")
    assert dt.datetime(2026,10,31,12,tzinfo=LA).utcoffset() == dt.timedelta(hours=-7)
    assert dt.datetime(2026,11,2,12,tzinfo=LA).utcoffset() == dt.timedelta(hours=-8)
    d = S.astimezone(LA).date()
    while True:
        a = dt.datetime(d.year, d.month, d.day, tzinfo=LA).astimezone(UTC)
        nd = d + dt.timedelta(days=1)
        b = dt.datetime(nd.year, nd.month, nd.day, tzinfo=LA).astimezone(UTC)
        if a >= E: break
        hrs = [h for h in HOURS if a < h <= b]
        complete = a >= S and b <= E
        tot = sum(reads.get(h, 0) for h in hrs)
        unv = [h for h in hrs if h in un]
        q = {"ptDate": str(d), "utcStart": iso(a), "utcEnd": iso(b), "hoursInDay": int((b - a) / H),
             "hoursCollected": len(hrs), "complete": complete, "reads": tot, "unverifiedNoPointHours": len(unv),
             "exact": complete and not unv,
             "over50000": (tot > 50000) if (complete and not unv) else (True if (complete and tot > 50000) else None)}
        quota.append(q)
        tag = "EXACT" if q["exact"] else ("LOWER BOUND (unverified gaps)" if complete else "PARTIAL DAY (not a full quota day)")
        p(f"  PT {d} [{iso(a)} .. {iso(b)}] {q['hoursInDay']}h: reads={tot}  {tag}" + (f"  >50,000={'UNDETERMINED' if q['over50000'] is None else q['over50000']}" if complete else ""))
        d = nd
except Exception as ex:
    warns.append(f"quota-day computation skipped: {ex!r}")
    p(f"  skipped: {ex!r}")

p(f"## 6. Hourly read_count [{REF_RT}] (UTC rows; columns = hour ending 01..24 UTC; '.' = no point)")
for day in sorted({(h - H).date() for h in HOURS}):
    row = []
    for hh in range(24):
        e = dt.datetime(day.year, day.month, day.day, tzinfo=UTC) + H * (hh + 1)
        row.append(str(reads[e]) if e in reads else ".")
    p(f"  {day} " + " ".join(row))
p("  top 15 hours by reads (UTC | ICT):")
for e, v in sorted(reads.items(), key=lambda kv: -kv[1])[:15]:
    reqs = {rt: DS[("U2t", rt)]["hourly"].get(e, 0) for rt in REQ_RTS}
    p(f"     {bucket(e)}: reads={v} requests={reqs}")

p("## 7. Interpretation limits (read before drawing conclusions)")
p("  - These are Cloud Monitoring metric values (document/read_count, api/request_count). They are NOT the Spark quota")
p("    ledger. Whether the free-tier quota was exceeded must be confirmed separately (Console usage/quota page or")
p("    RESOURCE_EXHAUSTED responses); RESOURCE_EXHAUSTED can also come from limits other than the daily quota.")
p("  - request_count is reported under more than one resource type; the types may overlap, so they are not added.")
p("  - Separation by app: only the labels listed in Step 1/2 of collect-log.txt exist. Unless one of them identifies")
p("    the app, client, user or collection, QD, PV2 and legacy tools on this project cannot be separated from these")
p("    files alone; any attribution needs timing correlation plus owner records.")

status = "FAIL" if fails else ("INCOMPLETE" if notes else "PASS")
p(""); p("WARNINGS:");  [p("  - " + w) for w in warns] or p("  none")
p("INCOMPLETE-EVIDENCE NOTES:"); [p("  - " + n) for n in notes] or p("  none")
p("FAILURES:");  [p("  - " + f) for f in fails] or p("  none")
p(f"VERIFY STATUS: {status}")
summary = {"window": [START, END], "status": status, "failures": fails, "warnings": warns, "notes": notes,
           "readResourceTypes": READ_RTS, "requestResourceTypes": REQ_RTS, "referenceResourceType": REF_RT,
           "readsNoPoint": {"consistentWithZero": [iso(h) for h in ok], "unverified": [iso(h) for h in un]},
           "readsWithoutAnyRequestPoint": [iso(h) for h in r_unv],
           "quotaDays": quota,
           "datasets": {f"{k}|{rt}": {"name": v["ix"]["name"], "groupByFields": v["d"]["groupByFields"], "pages": v["d"]["pages"],
                                      "series": v["series"], "hourlyTotal": {iso(h): x for h, x in sorted(v["hourly"].items())}}
                        for (k, rt), v in DS.items()}}
json.dump(summary, open(f"{OUT}/verify-summary.json", "w"), indent=1)
open(f"{OUT}/verify-report.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit({"PASS": 0, "INCOMPLETE": 3, "FAIL": 2}[status])
PY
set +e; python3 -I "$OUT/verify.py" "$OUT" "$START" "$END" 2>&1 | tee -a "$LOG"; VRC=${PIPESTATUS[0]}; set -e
case "$VRC" in 0|2|3) ;; *) VRC=4;; esac

# ---------- Step 5: token check + package ----------
leak_check || die "token-like string found; package NOT created"
say "token check: no token or token-like string in $OUT"
tar -czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT").tar.gz" ) | tee "$OUT.tar.gz.sha256"
say "package: $OUT.tar.gz"
case "$VRC" in
  0) say "RESULT: verification PASS";;
  3) say "RESULT: verification INCOMPLETE (data collected; some hours cannot be proven) - send the package; do not edit files";;
  2) say "RESULT: verification FAIL - send the package; do not edit files";;
  *) say "RESULT: verifier crashed (exit $VRC) - send the package and this log";;
esac
exit "$VRC"   # 0 PASS, 3 INCOMPLETE, 2 FAIL, 4 verifier crash; 1 = STOP before verification; 9 = token-like string found
