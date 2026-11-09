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
