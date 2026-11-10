#!/bin/bash
# Mock test for collector/a1-querystat.sh: local HTTP mock of the Monitoring API + real curl + fake gcloud.
# usage: run-test.sh SCENARIO [TOKEN] [BINDIR]   (prints one summary line; work dir under $TMPDIR)
D="$(cd "$(dirname "$0")" && pwd)"; C="$D/../collector/a1-querystat.sh"
SC=$1; TOK=${2:-"ya""29.FAKE-TEST-TOKEN_abc123"}; BIN=${3:-bin}
T=$(mktemp -d "${TMPDIR:-/tmp}/qs-$SC-XXXX"); mkdir -p "$T/home"
export SCENARIO=$SC FAKE_TOKEN=$TOK REQLOG=$T/req.log NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
python3 "$D/server.py" > "$T/port" & SPID=$!
for i in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port")
sed "s#^API=.*#API=\"http://127.0.0.1:$PORT/v3/projects/\${PROJECT}\"#" "$C" > "$T/script.sh"
PATH="$D/$BIN:$PATH" HOME="$T/home" bash "$T/script.sh" > "$T/stdout" 2> "$T/stderr"; RC=$?
kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
LEAK=no; grep -rqF -- "$TOK" "$T/home" "$T/stdout" "$T/stderr" && LEAK=YES
grep -rqE 'ya''29\.' "$T/home" "$T/stdout" "$T/stderr" && LEAK=YES
NREQ=$(wc -l < "$T/req.log" 2>/dev/null || echo 0); BADAUTH=$(grep -c '"auth_ok": false' "$T/req.log" 2>/dev/null); NONGET=$(grep -vc '"method": "GET"' "$T/req.log" 2>/dev/null)
PKG=$(ls "$T/home"/*.tar.gz 2>/dev/null | wc -l)
ST=$(grep -m1 -E '^VERIFY STATUS' "$T/stdout"); STOP=$(grep -m1 -E '^STOP:' "$T/stdout" | cut -c1-100)
ARGV=""; [ -f "$T/curl-argv.log" ] && ARGV=" argvTokenHits=$(grep -cF -- "$TOK" "$T/curl-argv.log")"
echo "$SC | exit=$RC | ${ST:-$STOP} | requests=$NREQ nonGET=$NONGET authFail=$BADAUTH tokenLeak=$LEAK package=$PKG$ARGV"
