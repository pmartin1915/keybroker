# Handoff — 2026-05-16 — operator-onramp docs

This session landed four operator-facing artifacts in the keybroker
repo plus one cross-repo dispatcher change. All work is allowed under
the validation-experiment freeze (`memory/project_validation_experiment_state.md`)
— docs and infra-example class, no new product features.

## What landed this session

### keybroker (this repo)

1. **`HANDOFF-2026-05-14-post-path-a-fixes.md`** (`2154046`) — committed
   the previously-untracked handoff with an inline RESOLVED note on
   item #1 (the budget.json hoist was already shipped in dispatcher
   `2279be8` the same afternoon the handoff was written; future readers
   should not re-investigate).

2. **README re-lead** (this commit) — added two paragraphs after the
   existing tagline that surface the verified-secret-scanner wedge and
   the "single-binary on 127.0.0.1" operational story. The previous
   lede led with token brokering only; the scanner — keybroker's actual
   differentiator per `docs/POSITIONING.md` and the Gemini Deep Research
   audit — was buried in the per-token enforcement table. Re-lead is
   minimal-surgery: no other section was touched, no claims invented,
   the pre-1.0 disclaimer link is now load-bearing.

3. **`examples/systemd/keybroker.service`** (this commit) — paste-and-go
   systemd unit for running the broker as a long-lived daemon on a
   Linux host. Hardened defaults (PrivateTmp, ProtectSystem=strict,
   NoNewPrivileges, etc.), dedicated `keybroker` system user,
   loopback-only binding documented. Install commands included in the
   file's header comment.

4. **`examples/nginx-front.conf`** (this commit) — TLS termination +
   auth front-end for when an operator needs remote access. Covers
   both basic-auth (homelab) and mTLS (per-developer client certs)
   shapes, with the streaming-friendly `proxy_buffering off` and a
   25 MB body cap sized for vision payloads. Cross-references the
   in-broker brk_ JWT enforcement so a reader understands the layered
   trust.

5. **`docs/asciinema-script.md`** (this commit) — a ~60-second
   recordable script for the verified-scanner demo. The asset
   `docs/hour-2-posts.md` calls out as missing ("lead with one
   screenshot or terminal snippet"). Crucially: uses a syntactically
   valid but **inactive** `ghp_…` so the recording demonstrates
   detection + verification without polluting a real GitHub audit log.
   Voice-over instructions cover the `scan_verified=0` vs `=1`
   distinction honestly.

### claude-budget-dispatcher (cross-repo, for context)

6. **Per-machine broker routing opt-in** (`0acedb6` in dispatcher) —
   `brokerRoutingEnabled()` now reads `cfg.keybroker.enabled` with env
   override precedence. This laptop's `config/budget.json` (gitignored,
   local) was flipped `enabled: true`. The dispatcher will start
   minting broker tokens for gemini/mistral on the next cycle on this
   machine; other fleet machines without `enabled: true` keep using
   direct SDK. This produces the "I dogfood this every day" audit
   telemetry that the validation experiment's eventual sequel post
   will want as a concrete number.

## Why these four

The session opened with the operator asking "how would I or someone
actually find this useful?" The honest take landed on three points:

1. **The pitch fights itself.** README led with brokering (LiteLLM
   territory); POSITIONING.md led with verified scanning (the wedge).
   The re-lead aligns them: brokering is the broader problem,
   scanning is the differentiator.
2. **Outside operators need an onramp.** The realistic first-time
   user wants `systemctl enable keybroker` + nginx + 5 minutes, not
   a quickstart that ends at `npx tsx src/cli.ts serve`. systemd
   unit + nginx config close that gap with zero feature work.
3. **The validation-experiment posts are text-only.** A 60-second
   asciinema beats three post variants combined. The script makes
   the recording a one-take affair when the operator chooses to do
   it.

The dispatcher change is the "useful to *you*" answer: become your
own lighthouse user before asking strangers to be one.

## Verification done

- `npm run typecheck` clean
- `npx vitest run` — 630/630 pass on second run; first run hit the
  known Windows keychain flake (`trap_test_subprocess_flake_windows.md`),
  no changes I made could affect it (docs only)
- Dispatcher: `node --test scripts/lib/__tests__/{broker-token,keybroker}.test.mjs`
  — 25/25 pass

No build was required (docs-only changes here; the dispatcher tests
covered the cross-repo edit).

## What I did NOT do (next instance picks up)

### Easy follow-ups (~15-30 min each)

- **Record the asciinema demo.** The script in
  `docs/asciinema-script.md` is one-take ready, but recording is
  operator-only — needs a human at the terminal. Once recorded,
  paste the asciinema URL into:
  - `README.md` (above Quickstart)
  - `docs/hour-2-posts.md` (each of the three post variants)
- **Add a "Deploying as a daemon" section to the README** pointing at
  `examples/systemd/keybroker.service` and `examples/nginx-front.conf`.
  Right now they're discoverable only by `ls examples/`. Two paragraphs,
  no claims to verify, ~5 min.
- **Verify the systemd unit on an actual Linux box.** I wrote it from
  systemd docs + memory; the dispatcher-class hardening flags should be
  correct but I haven't booted it. If the operator has any Linux host
  available, `systemd-analyze verify examples/systemd/keybroker.service`
  is the fast check.

### Medium follow-ups

- **Validation experiment +7d check-in.** Per
  `memory/project_validation_experiment_state.md`, the playbook
  posting happened on/around 2026-05-13. The +7d window closes
  ~2026-05-20 (this Wednesday). On or after that date, the operator
  should log the invest/park/shelve decision and the next instance
  should update memory with the outcome.
- **Watch for first audit telemetry from the dispatcher dogfooding.**
  After a dispatch cycle has run on this laptop with `enabled: true`,
  `~/.keybroker/store.db calls` table should start showing rows with
  `mch="perryslenovo"`, real `latency_ms`, real `actual_cost_usd`.
  If nothing shows up after a few cycles, check the dispatcher log for
  `[broker-token]` warnings — the spawn may be failing if
  `dist/cli.js` isn't where the dispatcher expects (it expects
  `C:/Users/perry/DevProjects/keybroker/dist/cli.js` per
  `dispatcher/scripts/lib/keybroker.mjs:21`).

### Deliberately deferred (DO NOT pick up without operator OK)

- **No Pro-tier features** (RS256, basic auth on broker, multi-tenant,
  SSO, Docker compose). The validation freeze is the binding
  constraint; the decision criteria haven't fired. See
  `memory/project_validation_experiment_state.md` for the gate logic.
- **No new handoff files for trivial follow-ups.** Roll into the next
  commit body. This file exists because we're at a clean stopping
  point with five distinct artifacts and a known unfinished item
  (the recording) that the operator needs to do.

## Git state at handoff

- Branch: `main`, **2 commits ahead of `origin/main`** (both local —
  user hasn't asked to push).
- HEAD will be the operator-onramp-docs commit after this file is
  committed alongside it. Previous: `2154046 docs: handoff for post
  Path-A fixes (2026-05-14)`.
- Working tree: clean except untracked `.claude/` (settings.local.json,
  historically not committed).
- Dispatcher repo: 1 commit ahead of `origin/main`
  (`0acedb6 feat(broker-token): per-machine opt-in`). Also unpushed.

— Claude Opus 4.7 (1M context), 2026-05-16 evening
