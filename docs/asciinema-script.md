# Asciinema script — verified-secret-scanner demo (~60s)

Goal: a single-take recording that shows the verified-secret-scanner
catching a leaked credential in an outbound LLM prompt, returning 403,
and writing an audit row with the detector name and verification
result. This is the asset that the validation-experiment posts
(`docs/hour-2-posts.md`) currently lack.

## Honest disclosure (read first)

The dramatic demo would use a real leaked GitHub PAT and show
`scan_verified=1` (live credential confirmed). **Don't.** Live
verification calls upstream from the recording machine's IP and
creates an audit-log entry on the key owner's account.

Use a **syntactically valid but inactive** `ghp_…` string instead.
The scanner will still detect it (Layer 1), still call GitHub's
`/user` to verify (Layer 2), and the audit row will show
`scan_verified=0` — *"detected and confirmed inactive"*. That's the
honest demonstration: detection + verification both ran, and the
audit log distinguishes the two outcomes.

For the screencast voice-over: *"With a real leaked PAT you'd see
`scan_verified=1` instead — that's the row that separates an active
leak from a regex false-positive in your audit log."*

## Pre-recording setup (outside the cast)

**CRITICAL — isolate the demo from your real broker.** Without
`KEYBROKER_HOME` AND `KEYBROKER_KEYCHAIN_PATH` set, `init` writes the
master key to your OS keychain under the global service name
`"keybroker"` — overwriting your real broker's master key and
permanently breaking decryption of any upstream secrets you'd already
stored. The two env vars together pin the demo to a tmp dir for
both SQLite/config and the keychain.

```sh
# Isolated demo home — your real ~/.keybroker is untouched.
export KEYBROKER_HOME=/tmp/keybroker-demo
export KEYBROKER_KEYCHAIN_PATH=/tmp/keybroker-demo/keychain.json
export KEYBROKER_PORT=7843   # the default; set explicitly so it's visible in the recording

# Wipe just the demo dir (NOT ~/.keybroker — that's your real one).
rm -rf "$KEYBROKER_HOME"
cd /path/to/keybroker
npm install >/dev/null
npm run build >/dev/null

# Pre-create a fake-but-syntactically-valid ghp_ string. GitHub PATs
# are ghp_ + 36 base62 chars. This one is fake; substitute any random
# 36-char base62 string.
export FAKE_LEAKED_PAT='ghp_0000000000000000000000000000000000aa'

# Start asciinema with a sensible idle limit so the cast is tight.
asciinema rec --idle-time-limit 2 --title "keybroker verified scanner demo" demo.cast
```

The recording itself doesn't show the env-var exports (they're pre-set
in the parent shell that launches `asciinema rec`). If you want them
on-screen for transparency, move them inside the cast — but keep the
`KEYBROKER_HOME` / `KEYBROKER_KEYCHAIN_PATH` lines, not just the
`rm -rf`.

## The script (~60s, one terminal)

Time markers are rough; the recording should *flow*, not feel paced.

### 0:00 — init + secret + token (12s)

```sh
# 1. one-time setup. writes ~/.keybroker/{config.json,store.db}
npx tsx src/cli.ts init

# 2. store a fake "upstream" openai key — the broker won't actually
#    call openai in this demo, the request is blocked before egress.
KEYBROKER_SECRET='sk-not-real-anything' npx tsx src/cli.ts secret add openai

# 3. mint a developer token, scoped to chat completions.
TOKEN=$(npx tsx src/cli.ts token issue \
  --provider openai --scope 'POST:/v1/chat/completions' \
  --max-calls 10 --ttl 600 --label demo 2>/dev/null)
```

### 0:12 — start the broker (3s)

```sh
npx tsx src/cli.ts serve &
sleep 1   # let it bind
```

### 0:15 — clean call (10s)

Show a normal request that the scanner lets through. (It's blocked at
the upstream because the openai key is fake — that's fine, the point
is the SCANNER didn't fire.)

```sh
# Clean prompt — no secret pattern. Scanner allows; upstream returns
# 401 (because the openai key is fake). outcome="error", not
# "egress_blocked".
curl -s -X POST http://127.0.0.1:7843/openai/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  | head -c 200; echo
```

### 0:25 — leaked-secret call (15s)

The headline shot. A request whose prompt body contains a `ghp_…`
pattern. Layer 1 detects, Layer 2 calls GitHub's `/user`, GitHub
responds 401 (inactive credential), broker returns 403 with the
detector name and writes `scan_verified=0`.

```sh
# A user innocently pastes a config file into chat — the PAT comes
# along for the ride. Without keybroker this leaves your network in
# the clear.
curl -s -X POST http://127.0.0.1:7843/openai/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"why isn't this working: GITHUB_TOKEN=$FAKE_LEAKED_PAT\"}]}" \
  | head -c 200; echo
# → 403 { "error": "egress_blocked", "detector": "github_pat", ... }
```

### 0:40 — the audit row (15s)

This is the money shot. Show that the audit log captured the block
*and* that verification ran.

```sh
# Recent calls. The egress_blocked row carries the detector name.
npx tsx src/cli.ts logs -n 3

# scan_verified isn't surfaced in the default logs format — go to the
# audit table for the verification result. 0 = detected but inactive,
# 1 = detected and live, NULL = detected but not eligible for verify.
# (Path uses $KEYBROKER_HOME from the pre-setup; defaults to
# ~/.keybroker/store.db when KEYBROKER_HOME is unset.)
sqlite3 "$KEYBROKER_HOME/store.db" \
  "SELECT ts, outcome, reason, scan_verified FROM calls ORDER BY ts DESC LIMIT 3;"
```

### 0:55 — close (5s)

```sh
# Same data, prettier, in the bundled web UI.
echo "→ open http://127.0.0.1:7843/ui/  (Audit tab)"
```

## Post-recording

```sh
# Stop the broker (it's running in the background from the cast).
# Find the PID by port and kill it:
kill $(lsof -t -i:7843) 2>/dev/null || true

# Tear down the isolated demo state — your real ~/.keybroker is
# untouched.
rm -rf "$KEYBROKER_HOME"
unset KEYBROKER_HOME KEYBROKER_KEYCHAIN_PATH KEYBROKER_PORT FAKE_LEAKED_PAT

# Upload to asciinema.org or self-host (it's just JSON):
asciinema upload demo.cast

# Or embed locally:
#   <script src="https://asciinema.org/a/<ID>.js" id="asciicast-<ID>" async></script>
```

Paste the resulting URL into:
- README.md (above the Quickstart section)
- `docs/hour-2-posts.md` (each of the three post variants — replaces "lead with one screenshot or terminal snippet")
- Any future Show HN / r/selfhosted / r/devops post

## What to cut if it runs long

- The clean call (0:15) — nice for symmetry but not essential.
- The web UI close (0:55) — voice-over alone is fine.

What stays no matter what: init → token → leaked call → 403 → audit row with detector name and `scan_verified`. Everything else is gravy.
