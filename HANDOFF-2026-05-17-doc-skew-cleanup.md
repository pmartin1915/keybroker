# Handoff — 2026-05-17 — doc-skew cleanup + asciinema foot-gun fix

Follow-up session to `HANDOFF-2026-05-16-operator-onramp-docs.md`. Five
commits landed in the validation-experiment-freeze-allowed class
(docs / config defaults / latent foot-gun fix) plus one auto-memory.
No new product features, no Pro-tier work, no roadmap drift.

## What shipped this session (all pushed to origin/main)

1. **`b92b798` docs(readme): surface examples/systemd and examples/nginx-front** —
   Two-paragraph "Deploying as a daemon" section in `README.md` between
   Quickstart and the per-token reference table. Closes the
   discoverability gap on the two example files that landed in
   `6da9a6a` (they were only findable by `ls examples/`).

2. **`930c359` fix(port): unify default broker port on 7843** — Closes
   the TODO at `HANDOFF-2026-05-12-commercialization-strategy.md:89`
   ("Default port is currently 7843 (TUI/web) / 8787 (older CLI
   examples). Pick one, update everywhere"). Changed `src/config.ts:129`,
   `src/cli.ts:125,130,163`, and four README references from 8787 to
   7843. The web/vite, TUI, dispatcher, asciinema script, systemd unit,
   nginx config, and README "Control plane" section were already on 7843;
   only the CLI fallback default and the README's top half were
   holdouts. Internal contradiction (Quickstart-vs-Control-plane) gone.

   The operator's `~/.keybroker/config.json` on this laptop still has
   `"port": 8787` pinned — file value beats default, so their existing
   tooling keeps working. They can drop the pin to pick up 7843.

   Verification: `npm run typecheck` clean (root + web/ + tui/), 630/630
   tests pass on second run (first run hit the documented Windows
   subprocess flake per `trap_test_subprocess_flake_windows.md`,
   unrelated to this change — the affected `beforeAll` hooks bind
   ephemeral ports).

3. **`e36a729` fix(asciinema): isolate demo from operator's real broker** —
   The pre-recording setup previously did `rm -rf ~/.keybroker/`,
   which removes config.json + store.db but leaves the OS-level
   keychain entries under service name `"keybroker"` intact. When
   `init` then runs:

   - Without `--force` → bails with "already initialized (keychain
     entry present)" per `src/cli.ts:109`.
   - With `--force` → **overwrites the real master key**, permanently
     breaking decryption of any upstream secrets the operator had
     already stored.

   Fix: scope the demo to `/tmp/keybroker-demo` for both data and
   keychain via `KEYBROKER_HOME` + `KEYBROKER_KEYCHAIN_PATH`. The
   `FileKeychain` path (`src/keychain.ts:116`) writes to a JSON file
   under the demo dir, untouched by the OS keychain. Real
   `~/.keybroker/` genuinely untouched throughout the recording.

   Also fixed: in-cast `sqlite3` command now reads `$KEYBROKER_HOME/store.db`
   (would have queried the wrong DB under isolated env); post-recording
   teardown stops the broker and unsets the env vars.

4. **`3a0166f` fix(hour-2-posts): correct broken SQL example + keychain overclaim** —
   Five factual errors in the validation-experiment post bodies that
   would have shipped to HN / r/devops / r/selfhosted:

   - `~/.keybroker/keybroker.db` → `~/.keybroker/store.db` (actual file)
   - `scan_blocked` column → `WHERE outcome = 'egress_blocked'` (real
     column per `src/server.ts:1553`)
   - `scan_detector` column → `reason` (real column per
     `src/server.ts:1554`; Phase 3.6 invariant: detector-name-only)
   - `aws_key` detector → `aws_access_key` (canonical name per
     `src/scanner.ts:98`)
   - Keychain copy: variants 1 and 3 described `KEYBROKER_KEYCHAIN_PATH`
     as an automatic "fallback for headless Linux." Per
     `src/keychain.ts:116` it is purely opt-in — no auto-detection.
     Softened to "set `$KEYBROKER_KEYCHAIN_PATH` to opt into a 0600
     JSON file."

   Anyone copy-pasting the original Show HN SQL would have hit
   `Error: no such column: scan_blocked`. Caught before the posting
   window opens.

5. **`df3462e` fix(readme): architecture diagram store.db not store.sqlite** —
   The Architecture diagram showed `~/.keybroker/store.sqlite`; the
   actual filename is `store.db` per `src/config.ts:125`. One-line fix;
   real users following the diagram to a `sqlite3` session would have
   hit "no such file."

## Memory added

- **`trap_dispatcher_broker_routing_setup.md`** — captures the two
  gotchas for turning on dispatcher → keybroker dogfooding:
  (1) the enable flip lives in dispatcher `local.json` NOT
  `budget.json` (legacy/ignored on `perryslenovo`); and
  (2) the broker daemon MUST be running before enabling because the
  broker-fetch path in `provider.mjs:270` has no SDK fall-through on
  connection refused. The 2026-05-16 handoff's claim that
  "config/budget.json was flipped enabled: true" was inaccurate in
  both ways. Verified by reading `loadConfig()` precedence and
  probing `/health` (curl exit 28 — broker not running).

## Repo state at handoff

- Branch: `main`, **clean and even with `origin/main` at `df3462e`**.
- Working tree: clean except untracked `.claude/` (settings.local.json,
  historically not committed; gitignored).
- `dist/` rebuilt locally with new 7843 defaults (gitignored).
- Dispatcher repo: **unchanged from session start**. The flip to
  `enabled: true` was attempted and reverted within seconds when
  `curl 127.0.0.1:7843/health` showed the broker daemon wasn't
  running (curl exit 28). No commits on the dispatcher this session.

## What the next instance picks up

### Operator-only (no Claude action available)

- **Record the asciinema.** Script in `docs/asciinema-script.md` is
  now isolated (via `KEYBROKER_HOME` + `KEYBROKER_KEYCHAIN_PATH`),
  schema-correct (`ts/reason/scan_verified` columns; full provider-
  prefixed paths), port-correct (7843 throughout). One-take ready.
  After recording, paste the asciinema URL into:
  - `README.md` (above Quickstart)
  - `docs/hour-2-posts.md` (each of three post variants — replaces
    the "lead with one screenshot or terminal snippet" placeholder)

- **`systemd-analyze verify examples/systemd/keybroker.service`** on
  any Linux host. Unit shape looks correct (Type/User/Group/ExecStart/
  hardening flags) but hasn't been booted.

- **Validation experiment +7d.** Per `project-validation-experiment-state`
  memory, the window closes on/around 2026-05-20 (3 days from
  handoff). On or after that date, the operator logs the
  invest/park/shelve decision; the next instance updates the memory
  with the outcome and unlocks/maintains the feature freeze
  accordingly.

### Operator decision required, then Claude can verify

- **Dispatcher routing flip.** Documented in detail in
  `trap_dispatcher_broker_routing_setup.md`. The right sequence is:
  1. Start the broker daemon
  2. Confirm `curl 127.0.0.1:7843/health` returns 200
  3. Add the `keybroker: {enabled: true, cap_usd: 1, ttl_seconds: 600, max_calls: 50}` block to dispatcher `local.json` (NOT `budget.json`)
  4. After next dispatch cycle, `npx tsx src/cli.ts logs -n 20` should show new `mch=perryslenovo` rows with post-flip timestamps

   If a future session is asked to do this, it MUST verify the broker
   is reachable on `/health` first. Flipping without a daemon running
   breaks gemini/mistral dispatch cycles (no SDK fall-through past
   the broker fetch).

### Deliberately NOT picked up (post-validation freeze)

- **No Pro-tier features** until validation criteria fire. RS256,
  basic auth on broker, Docker compose, rate limiter, SSO, multi-tenant
  — all blocked until `project-validation-experiment-state` is
  updated with an "invest" outcome.

- **No new handoff files for trivial follow-ups.** This file exists
  because it's a clean batch with distinct artifacts (5 commits + a
  memory) and a known unfinished item (the asciinema recording, the
  dogfooding flip) that needs operator presence. Subsequent micro-fixes
  should roll into commit bodies.

## Verification done this session

- `npm run typecheck` clean (root + web/ + tui/) after port change
- `npx vitest run` 630/630 pass on second run (first run hit the
  documented Windows test flake; second clean — confirms my changes
  didn't introduce real test failures)
- `npm run build` clean; `dist/cli.js` (24 files) rebuilt with 7843
  defaults; `grep "8787" dist/cli.js dist/config.js` returns empty
- All five commits pushed to `origin/main`; no dispatcher changes
  survive the session

## Useful pointers

- **Why 7843?** It was already used in more places than 8787 (web vite
  proxy, TUI default, dispatcher `DEFAULT_URL`, README Control plane,
  asciinema, systemd, nginx, 4 recent handoffs). 8787 was described in
  the commercialization-strategy handoff as "older CLI examples."
  Fewer files touched by picking 7843; no live tooling needed to change.

- **Why FileKeychain matters for the asciinema demo.** Top-level
  `import keytar from "keytar"` in `src/keychain.ts:1` means keytar
  dlopens libsecret at module-init time even if the OS keychain is
  never used. Setting `KEYBROKER_KEYCHAIN_PATH` switches `getKeychain()`
  to `FileKeychain` lazily, but does NOT skip the keytar dlopen — so
  on a bare Linux container without libsecret-1-dev, the broker fails
  to start regardless. See `trap_keytar_libsecret_load.md`. For the
  asciinema demo on the operator's Windows/macOS dev machine, this
  isn't a problem; for the systemd unit on a Linux host it would be
  (a `pre-install: apt-get install libsecret-1-dev` step belongs in
  the systemd install instructions; currently absent).

- **One real latent issue I did not fix:** the systemd unit's install
  instructions in `examples/systemd/keybroker.service` do not mention
  the libsecret-1-dev apt dependency. On a fresh Ubuntu install,
  following the unit's install header literally would produce a
  broker that fails to start with `Error: Cannot find module
  'libsecret-1.so.0'` or similar. This is the next docs follow-up
  for the operator-onramp story. Out of scope for this session
  because the operator hasn't booted the unit yet — the dependency
  surface should be validated against a real Linux smoke before
  enshrining it in the install header.

— Claude Opus 4.7 (1M context), 2026-05-17 mid-afternoon
