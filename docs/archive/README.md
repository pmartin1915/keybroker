# docs/archive

Retired reference material kept for historical context. Nothing in this
directory is built, served, or imported by the broker or the web UI.

## Files

### `Prototype.html`

The original single-file React prototype that drove Phase 4.0's UI parity
work. Mock data, no backend. Retired on **2026-05-11** when Phase 4.0
closed out — the bundled `/ui` dashboard now covers every operator
surface the prototype exercised.

One affordance from the prototype did **not** port: the "Recovery —
Batch Re-issue" modal that opens after `rotateAll`. The prototype's
`rotateAll` is revoke-only, so the recovery modal exists to mint
replacements as a separate step. The broker's `POST /admin/tokens/rotate`
revokes *and* reissues atomically (`buildReissueArgs` runs inside the
same transaction), so there is no two-step gap for a recovery modal to
fill. The prototype's UI shape was specific to its mock backend.

Kept for diff reference and as a record of the design vocabulary that
informed the dashboard.
