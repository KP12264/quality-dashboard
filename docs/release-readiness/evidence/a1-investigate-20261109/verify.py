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
M_WRITE = "firestore.googleapis.com/document/write_count"
M_DELETE = "firestore.googleapis.com/document/delete_count"
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
    hourly, series = collections.Counter(), []
    for key, pts in merged.items():
        seen, dups, conflict, offgrid, badlen, outside = {}, 0, 0, 0, 0, 0
        for pt in pts:
            try: e = ts(pt["interval"]["endTime"])
            except (KeyError, ValueError) as ex: fails.append(f"{name}: bad point interval ({ex})"); continue
            v = pt.get("value", {})
            if "int64Value" in v: v = int(v["int64Value"])
            elif "doubleValue" in v and ix["valueType"] == "DOUBLE": v = float(v["doubleValue"])
            else: fails.append(f"{name}: unsupported point value {v}"); continue
            if v < 0 and ix["metricKind"] != "GAUGE": fails.append(f"{name}: negative value at {iso(e)}")
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
        for e, v in seen.items(): hourly[e] += v
        series.append({"metricLabels": lbl[0], "resourceLabels": lbl[2], "points": len(seen), "total": sum(seen.values()),
                       "hourly": {iso(e): v for e, v in sorted(seen.items())}})
    return {"ix": ix, "hourly": hourly, "series": series}

INDEX = [json.loads(l) for l in open(f"{OUT}/datasets.jsonl") if l.strip()]
DS = {}
for ix in INDEX:
    if ix.get("noData"): p(f"metric with no series in window: {ix['metric']} ({ix['role']})"); continue
    DS[(ix["metric"], ix["resourceType"])] = load(ix)
for m in (M_WRITE, M_DELETE):
    ent = [ix for ix in INDEX if ix["metric"] == m]
    if not ent: notes.append(f"{m} is not in the metric list: hours cannot be classified by it")
    elif all(ix.get("noData") for ix in ent): warns.append(f"{m} has no series in the window (no data at all)")
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

p("## 2. Per UTC day: total for DELTA/CUMULATIVE, maximum hourly value for GAUGE (per metric and resource type)")
days = sorted({(h - H).date() for h in HOURS})
for (m, rt), d in sorted(DS.items()):
    tot = collections.Counter()
    kind = d["ix"]["metricKind"]
    for e, v in d["hourly"].items():
        k = (e - H).date()
        tot[k] = max(tot[k], v) if kind == "GAUGE" else tot[k] + v
    p(f"  {m.split('/',1)[1]} [{rt}] ({kind}/{d['ix']['aligner']}): " + ", ".join(f"{x:%d %b}={round(tot[x],2)}" for x in days)
      + f"; hours with a point={len(d['hourly'])}/{len(HOURS)}")
    for s in sorted(d["series"], key=lambda s: -s["total"])[:8]:
        p(f"     {s['metricLabels']}: total={round(s['total'],2)} hours={s['points']}")

p(f"## 3. Fact table: flagged hours (Update 2 list + reads >= {THRESH}); UTC bucket end and Thailand time")
order = {M_WRITE: 0, M_DELETE: 1}
cols = sorted([k for k in DS if k != (M_READ, REF_RT)], key=lambda k: (order.get(k[0], 2), k))
def short(k): return f"{k[0].split('/',1)[1]}[{k[1]}]"
flag = sorted({ts(x) for x in FLAGGED} | {h for h in HOURS if reads.get(h, 0) >= THRESH})
p("  legend: '0?' = no point in that hour (treated as 0, NOT verified); GAUGE columns are the sum of per-series hourly maxima")
p("  " + " | ".join(["UTC hour ending", "Thailand", "reads"] + [short(k) for k in cols] + ["pattern"]))
table = []
for h in flag:
    row = {"utcEnd": iso(h), "thailand": ict(h), "reads": reads.get(h, 0)}
    cells = []
    for k in cols:
        hv = DS[k]["hourly"]
        cells.append(str(round(hv[h], 2)) if h in hv else "0?")
        row[short(k)] = hv.get(h)
    w = DS.get((M_WRITE, REF_RT)) or next((DS[k] for k in DS if k[0] == M_WRITE), None)
    dl = DS.get((M_DELETE, REF_RT)) or next((DS[k] for k in DS if k[0] == M_DELETE), None)
    wv = w["hourly"].get(h) if w else None; dv = dl["hourly"].get(h) if dl else None
    pat = "reads" + ("+writes" if wv else "") + ("+deletes" if dv else "")
    unv = [n for n, x in (("writes", w), ("deletes", dl)) if x is not None and h not in x["hourly"]]
    miss = [n for n, x in (("write_count", w), ("delete_count", dl)) if x is None]
    if unv: pat += " (" + "/".join(unv) + " 0? unverified)"
    if miss: pat += " (metric not collected: " + "/".join(miss) + ")"
    row["pattern"] = pat; table.append(row)
    p("  " + " | ".join([iso(h), ict(h), str(reads.get(h, 0))] + cells + [pat]))

p("## 4. Hypotheses to test per pattern (NOT conclusions)")
p("  - reads only: viewing/reporting, a reading script or export-like job, or listener traffic; needs owner records.")
p("  - reads+writes: import, migration, bulk edit or a sync job; compare with owners' import logs.")
p("  - reads+deletes: cleanup or data reset job.")
p("  - listener/connection metrics high in the same hour (if collected): supports long-lived listeners (QD has none in code).")
p("  - rules metrics high in the same hour (if collected): supports protected reads/writes (rules get()/exists()).")

p("## 5. Interpretation limits")
p("  - Cloud Monitoring values, not the Spark quota ledger. No app/client/user/collection labels unless listed in collect-log.txt.")
p("  - '0?' cells are hours with no point: Cloud Monitoring omits empty buckets, so they are most likely 0 but not verified.")
p("  - GAUGE values are hourly maxima summed across series: an approximation, not a count.")

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
