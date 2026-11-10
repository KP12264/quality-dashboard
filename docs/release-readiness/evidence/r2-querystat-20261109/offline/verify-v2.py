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
VERIFIER = "verify v2 (unit rule: {not_a_unit} checked against descriptor, series count and sibling counts)"
PREFIX = "firestore.googleapis.com/"
fails, warns, notes, lines = [], [], [], []
try:
    MDS = {m["type"]: m for m in json.load(open(f"{OUT}/metric-list.json"))["metricDescriptors"]}
except (OSError, ValueError, KeyError) as ex:
    MDS = None; fails.append(f"metric-list.json unreadable ({ex}): descriptors needed for the unit check")
UNIT_WARN = []   # (metric, resource type, name) whose unit was only taken from the descriptor
def slug(x): return re.sub(r"[^A-Za-z0-9._-]", "_", x)
def unit_check(name, ix, d, nseries):
    """Response unit vs descriptor. {not_a_unit} is never treated as a valid unit:
       mixed units / descriptor mismatch -> FAIL; cannot be verified -> INCOMPLETE;
       exactly one series of one metric (HEADERS and FULL) with a descriptor unit -> WARNING."""
    units = d["units"]; m = ix["metric"]; rt = ix["resourceType"]
    desc = (MDS or {}).get(m)
    if len(units) > 1:
        fails.append(f"{name}: response units {units} differ between pages (mixed units)"); return
    if desc is None:
        notes.append(f"{name}: no descriptor for {m}: unit cannot be checked"); return
    du = desc.get("unit")
    if desc.get("valueType") != ix["valueType"] or desc.get("metricKind") != ix["metricKind"]:
        fails.append(f"{name}: descriptor {desc.get('metricKind')}/{desc.get('valueType')} differs from collected {ix['metricKind']}/{ix['valueType']}"); return
    if "{not_a_unit}" not in units:
        if units and du is not None and units[0] != du: warns.append(f"{name}: response unit {units[0]!r} differs from descriptor unit {du!r}")
        return
    if not du:
        notes.append(f"{name}: API reported unit {{not_a_unit}} and the descriptor has no unit: unit unknown, values not usable as a measure"); return
    try:
        hdr = [x for x in json.load(open(f"{OUT}/headers__{slug(m[len(PREFIX):])}.json"))["timeSeries"] if x.get("resource", {}).get("type") == rt]
    except (OSError, ValueError, KeyError):
        hdr = None
    if hdr is None:
        notes.append(f"{name}: API reported unit {{not_a_unit}}; HEADERS file missing, series count cannot be checked"); return
    if nseries != 1 or len(hdr) != 1:
        notes.append(f"{name}: API reported unit {{not_a_unit}} over {nseries} series (HEADERS {len(hdr)}): agreement of units cannot be verified"); return
    UNIT_WARN.append((m, rt, name))
    warns.append(f"{name}: API reported unit {{not_a_unit}}; descriptor unit is {du!r}; one series of one metric and one resource type (HEADERS and FULL), so no mixing is possible. The unit is NOT verified: values are reported with the descriptor unit as a caveat")
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
    unit_check(name, ix, d, len(merged))
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
p(f"verifier: {VERIFIER}")
for m, rt, name in UNIT_WARN:
    if m in (M_QS, M_QI) and (M_QR, rt) in DS:
        a, b = DS[(m, rt)]["hourly"], DS[(M_QR, rt)]["hourly"]
        diff = [h for h in HOURS if a.get(h, 0) != b.get(h, 0)]
        if diff: notes.append(f"{name}: unit taken from the descriptor, but its query counts differ from result_counts in {len(diff)} hours: data consistency not shown")
        else: p(f"unit caveat {name}: query counts equal to result_counts in all {len(HOURS)} hours (same queries measured)")
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

p("## 5. Coverage of query_stat (facts)")
qr_rts = [k for k in DS if k[0] == M_QR]
if qr_rts:
    meth = by_label(M_QR, "method")
    p("  queries by method: " + ", ".join(f"{k}={sum(c.values())}" for k, (c, sm) in sorted(meth.items())))
    qh = set().union(*[set(DS[k]["hourly"]) for k in qr_rts])
    gap = [h for h in flag if reads.get(h, 0) > 0 and h not in qh]
    p(f"  flagged hours with reads but no query_stat point: {len(gap)} of {len(flag)}")
    if gap: notes.append(f"query_stat has no point in {len(gap)} of {len(flag)} flagged hours that have reads: the apps' queries are not covered by these metrics, so R2 does not show whether the spikes were large or many small queries")
p("## 5b. What each result would support (hypotheses, NOT conclusions)")
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
summary = {"verifier": VERIFIER, "window": [START, END], "status": status, "failures": fails, "warnings": warns, "notes": notes,
           "flaggedHours": table,
           "datasets": {f"{m}|{rt}": {"name": d["ix"]["name"], "role": d["ix"]["role"], "metricKind": d["ix"]["metricKind"],
                                      "valueType": d["ix"]["valueType"], "aligner": d["ix"]["aligner"], "series": d["series"],
                                      "hourlyTotal": {iso(h): v for h, v in sorted(d["hourly"].items())}} for (m, rt), d in DS.items()}}
json.dump(summary, open(f"{OUT}/verify-summary.json", "w"), indent=1)
open(f"{OUT}/verify-report.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit({"PASS": 0, "INCOMPLETE": 3, "FAIL": 2}[status])
