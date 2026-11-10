import json, os, re, datetime as dt, urllib.parse as up
from http.server import BaseHTTPRequestHandler, HTTPServer
SC = os.environ["SCENARIO"]; TOKEN = os.environ["FAKE_TOKEN"]; LOG = os.environ["REQLOG"]
UTC = dt.timezone.utc; H = dt.timedelta(hours=1); S = dt.datetime(2026,10,26,tzinfo=UTC); N = 120
P = "firestore.googleapis.com/"; FI = "firestore_instance"; DB = "firestore.googleapis.com/Database"
REF = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ref.json")))
def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ")
def end(i): return S + H*(i+1)
def reads(i): return REF.get(iso(end(i)), 0) + (1 if SC == "readmismatch" and i == 28 else 0)
def ops_q(i): return reads(i)
def nq(i):
    if SC == "coverage_gap": return 2 if i % 24 == 18 else 0
    return (reads(i) // 20) if reads(i) else 0
UNITS = {"result_counts": "{result}", "scanned_documents_counts": "{document}", "scanned_index_entries_counts": "{index entry}"}
DIST = {"result_counts": lambda i: 15.0, "scanned_documents_counts": lambda i: 15.0, "scanned_index_entries_counts": lambda i: 16.0}
QS = ["result_counts", "scanned_documents_counts", "scanned_index_entries_counts"]
MD = [
 {"type": P+"document/read_count", "metricKind": "DELTA", "valueType": "INT64", "unit": "1", "labels": [{"key":"module"},{"key":"version"},{"key":"type"}], "monitoredResourceTypes": [FI]},
 {"type": P+"document/read_ops_count", "metricKind": "GAUGE" if SC == "wrongkind" else "DELTA", "valueType": "INT64", "unit": "1", "labels": [{"key":"type"}], "monitoredResourceTypes": [DB]},
] + [dict({"type": P+"query_stat/per_query/"+q, "metricKind": "DELTA", "valueType": "DISTRIBUTION"}, **({} if (SC == "notaunit_nodescunit" and q == "scanned_index_entries_counts") else {"unit": UNITS[q]}), labels=[{"key":"service"},{"key":"method"}], monitoredResourceTypes=[DB]) for q in QS] + [
 {"type": P+"api/request_count", "metricKind": "DELTA", "valueType": "INT64", "labels": [{"key":"api_method"},{"key":"response_code"}], "monitoredResourceTypes": ["datastore_request", DB]},
]
if SC == "noread": MD = [m for m in MD if not m["type"].endswith("read_count")]
if SC == "missing": MD = [m for m in MD if not m["type"].endswith("scanned_index_entries_counts")]
SV = "firestore.googleapis.com"
def spec(t):
    t = t[len(P):]
    if t == "document/read_count": return FI, [({"type": "QUERY", "module": "__unknown__", "version": "__unknown__"}, reads)]
    if t == "document/read_ops_count":
        if SC == "notaunit_multi": return DB, [({"type": "QUERY"}, ops_q), ({"type": "LOOKUP"}, lambda i: 1 if ops_q(i) else 0)]
        return DB, [({"type": "QUERY"}, ops_q)]
    if t.endswith("scanned_index_entries_counts") and SC == "notaunit_sibling": return DB, [({"service": SV, "method": "RunQuery"}, lambda i: nq(i) + (1 if i == 29 else 0))]
    if t.startswith("query_stat/per_query/"): return DB, [({"service": SV, "method": "RunQuery"}, nq)]
    return DB, [({}, lambda i: 0)]
RESL = {FI: {"project_id": "p"}, DB: {"project_id": "p", "database_id": "(default)", "location": "asia-southeast1"}}
def series(t, rt, labels, fn, md):
    pts = []
    for i in range(N):
        v = fn(i)
        if v:
            e = end(i)
            if md["valueType"] == "DISTRIBUTION":
                mean = DIST[t.rsplit("/", 1)[1]](i)
                if SC == "baddist" and i == 29: val = {"distributionValue": {"count": "-3", "mean": mean}}
                else: val = {"distributionValue": {"count": str(v), "mean": mean, "bucketOptions": {"exponentialBuckets": {"numFiniteBuckets": 10, "growthFactor": 2, "scale": 1}}, "bucketCounts": [str(v)]}}
            else: val = {"int64Value": str(v)}
            pts.append({"interval": {"startTime": iso(e - H), "endTime": iso(e)}, "value": val})
    return {"metric": {"type": t, "labels": labels}, "resource": {"type": rt, "labels": RESL[rt]}, "metricKind": md["metricKind"], "valueType": md["valueType"], "points": pts[::-1]}
def unit_for(t, md):
    if SC == "notaunit" and t.endswith("read_ops_count"): return "{not_a_unit}"
    if SC == "notaunit_multi" and t.endswith("read_ops_count"): return "{not_a_unit}"
    if SC in ("notaunit_single", "notaunit_nodescunit", "notaunit_sibling", "coverage_gap") and t.endswith("scanned_index_entries_counts"): return "{not_a_unit}"
    return md.get("unit", "1")
def build(q):
    m = re.fullmatch(r'metric\.type="([^"]+)"(?: AND resource\.type="([^"]+)")?', q["filter"][0])
    if not m: raise ValueError("bad filter")
    t, rt = m.group(1), m.group(2)
    md = next((x for x in MD if x["type"] == t), None)
    if md is None: raise ValueError("unknown metric " + t)
    srt, sl = spec(t)
    if q["view"][0] == "HEADERS":
        if SC in ("qs_nodata", "all_nodata") and "query_stat" in t: return {}
        if SC in ("ops_nodata", "all_nodata") and t.endswith("read_ops_count"): return {}
        hb = {"timeSeries": [{"metric": {"type": t, "labels": lb}, "resource": {"type": srt, "labels": RESL[srt]}} for lb, _ in sl], "unit": unit_for(t, md)}
        return hb
    assert rt == srt, "unexpected resource filter"
    emit = FI if (SC == "wrongrt" and srt == DB) else srt
    out = [x for x in (series(t, emit, lb, fn, md) for lb, fn in sl) if x["points"]]
    if SC == "dup_conflict" and t.endswith("read_ops_count") and out:
        x = json.loads(json.dumps(out[0]["points"][0])); x["value"]["int64Value"] = "1"; out[0]["points"].append(x)
    body = {"timeSeries": out, "unit": unit_for(t, md)}
    return body
class Hd(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        ok = self.headers.get("Authorization") == "Bearer " + TOKEN
        u = up.urlparse(self.path); q = up.parse_qs(u.query)
        open(LOG, "a").write(json.dumps({"path": u.path, "q": q, "auth_ok": ok, "method": self.command}) + "\n")
        if not ok: return self.send(401, {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "bad auth"}})
        if u.path.endswith("/metricDescriptors"):
            if SC == "api403": return self.send(403, {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "denied " + "ya" + "29.SHOULD_BE_REDACTED"}})
            if q.get("filter", [""])[0] != 'metric.type = starts_with("firestore.googleapis.com/")': return self.send(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "unexpected filter"}})
            if SC == "listshape": return self.send(200, {"metricDescriptors": "oops"})
            mds = MD + ([{"type": "compute.googleapis.com/x", "metricKind": "GAUGE", "valueType": "DOUBLE"}] if SC == "listforeign" else [])
            if SC == "listpage":
                if "pageToken" not in q: return self.send(200, {"metricDescriptors": mds[:2], "nextPageToken": "p2"})
                return self.send(200, {"metricDescriptors": mds[2:]})
            return self.send(200, {"metricDescriptors": mds})
        if u.path.endswith("/timeSeries"):
            full = q["view"][0] == "FULL"
            if SC == "html502" and full: return self.send(502, b"<html>Bad Gateway " + TOKEN.encode() + b"</html>", "text/html")
            if SC == "bad400" and full: return self.send(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "invalid groupBy"}})
            try: body = build(q)
            except Exception as ex: return self.send(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": str(ex)}})
            if SC == "loop_token": body["nextPageToken"] = "same"; return self.send(200, body)
            allpts = [(si, p) for si, s in enumerate(body.get("timeSeries", [])) for p in s.get("points", [])]
            off = int(q.get("pageToken", ["0"])[0]); chunk = allpts[off:off+40]
            out = dict(body); ts = []
            for si, s in enumerate(body.get("timeSeries", [])):
                if "points" not in s: ts.append(s); continue
                pts = [p for (sj, p) in chunk if sj == si]
                if pts: ts.append(dict(s, points=pts))
            if "timeSeries" in body: out["timeSeries"] = ts
            if off + 40 < len(allpts): out["nextPageToken"] = str(off + 40)
            if full and off == 0 and SC == "execerr": out["executionErrors"] = [{"code": 4, "message": "deadline"}]
            if full and SC == "unreachable": out["unreachable"] = ["asia-southeast1"]
            if full and SC == "mixedunits" and "scanned_index_entries_counts" in q["filter"][0] and off > 0: out["unit"] = "{not_a_unit}"
            return self.send(200, out)
        self.send(404, {"error": {"code": 404, "status": "NOT_FOUND", "message": "x"}})
srv = HTTPServer(("127.0.0.1", 0), Hd); print(srv.server_address[1], flush=True); srv.serve_forever()
