# katari-registry

Centralized snapshot registry for the [Katari](https://github.com/katari-lang/katari)
ecosystem. A **snapshot** is a curated set of (package, version) pairs
that are guaranteed to compile together.

This repo is **the source of truth for resolution**. The Katari CLI
(`katari add`, `katari build`, ...) reads a snapshot from here, fetches
the listed packages, and uses them to satisfy `[dependencies]` in a
project's `katari.toml`.

## Layout

```
packages/                            # SSoT: one file per (package, version)
  <pkg>/
    <version>.toml                   # metadata (repo, ref, sha256, ...)
package-sets/
  staging.toml                       # next snapshot candidate (= mutable)
  snapshots/
    snapshot-<date>-<hash>.toml      # immutable; cut from staging by CI
scripts/                             # CI helpers (TS via pnpm + tsx)
.github/
  PULL_REQUEST_TEMPLATE.md           # proposal template (PR body)
  workflows/
    pr.yml                           # PR verify (no commit)
    merge.yml                        # apply proposal on merge → commit to main
    nightly.yml                      # full verify + cut snapshot
```

A downstream project pins a snapshot by name:

```toml
# katari.toml in a downstream project
[dependencies]
registry = "https://raw.githubusercontent.com/katari-lang/katari-registry/main"
snapshot = "snapshot-2026-05-25-abc123"   # or "staging" for early access
```

## Snapshot semantics

A snapshot is a **consistent set**: every package listed compiles
against every other package in the same snapshot, using the
`katari_compiler` version declared in the snapshot. Once cut, a
snapshot file is **immutable** (= append-only).

New packages or version bumps land in `staging.toml` first via PR
merge, then get promoted to a fresh
`snapshots/snapshot-<date>-<hash>.toml` by the nightly CI when the
full set still builds.

Compiler-version compatibility is declared at the **snapshot level**
only — each snapshot is pinned to one `katari_compiler` version.
Compiler upgrades are handled by cutting a fresh snapshot built
against the new compiler, leaving older snapshots frozen.

## Adding / updating / removing a package (= PR flow)

Open a PR. The PR description **IS** the proposal — the
[`PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
gives you a TOML block to fill in:

````markdown
## Proposal

```toml
kind = "add"                                       # "add" | "update" | "remove"
name = "list_utils"
version = "1.0.0"                                  # omit for "remove"
repo = "https://github.com/katari-lang/katari-list-utils"  # omit for "remove"
ref = "v1.0.0"                                     # omit for "remove"
```
````

The PR CI (`.github/workflows/pr.yml`) will:

1. Extract the TOML fence from the PR body.
2. Resolve `ref` → compute `sha256` of the GitHub tarball.
3. Write `packages/<name>/<version>.toml` (the new per-version metadata).
4. Update `package-sets/staging.toml` to point `<name>` at the new version.
5. Verify the staging set: scaffold a synthetic project importing every
   package, `katari add` it (fetches each pinned tarball, verifies its
   sha256 against the pin, and writes `katari.lock`), then `katari check`
   typechecks the locked closure.

The applied files **are not pushed to the PR branch** — they live only
inside the CI run. After the PR is merged, `.github/workflows/merge.yml`
re-extracts the proposal from the merged PR's description, applies it to
`main`, and pushes the resulting commit. You as the PR author only ever
edit the PR description.

Editing the PR description re-runs the PR CI.

## Snapshot cut (= what happens after merge)

PR merge promotes the changes into `staging.toml` only — it is **not**
a new snapshot. The nightly CI (`.github/workflows/nightly.yml`)
verifies the full staging set against a fresh build of the Katari
compiler and, if all packages compile, cuts an immutable
`snapshots/snapshot-<date>-<hash>.toml`.

If a package fails the full build (e.g. because another package was
bumped to an incompatible version), the nightly CI errors out and
leaves staging un-cut. The maintainer of the offending package is
expected to file a fix (or have their package removed via an explicit
`kind = "remove"` PR after a grace period).

## File formats

### Per-package metadata — `packages/<name>/<version>.toml`

```toml
name           = "list_utils"
version        = "1.0.0"
repo           = "https://github.com/katari-lang/katari-list-utils"
ref            = "abc1234..."         # resolved commit SHA
sha256         = "0000..."            # tarball SHA-256
published_time = "2026-05-25T10:30:00Z"
```

These files are the source of truth and **immutable** — once written,
they are never overwritten. Bumping a package's version always creates
a fresh file.

### Staging — `package-sets/staging.toml`

```toml
katari_compiler = "0.1.0"

[packages.list_utils]
version = "1.0.0"
repo    = "https://github.com/katari-lang/katari-list-utils"
ref     = "abc1234..."
sha256  = "0000..."
```

The Katari CLI reads the (repo, ref, sha256) triple directly from the
staging/snapshot file, so consumer toolchains don't have to walk
`packages/` to resolve a dependency. The data here is denormalized
from the per-package metadata files at apply-proposal time.

### Snapshot — `package-sets/snapshots/snapshot-<date>-<hash>.toml`

Same shape as `staging.toml`, just frozen. The `<hash>` is the leading
8 hex characters of `sha256(staging.toml)` at cut time, giving cuts a
unique identity even when multiple are made on the same day.

## Why a separate repo

The registry has a different release cadence from the compiler and a
different audit surface from individual package repos. Keeping it in
its own repo lets the registry move at its own pace and lets
contributors PR a single description edit without touching the
compiler or any package source.

## Running scripts locally

```sh
cd scripts
pnpm install
# Write the proposal TOML directly to a file (= what the PR body would carry):
cat > /tmp/proposal.toml <<EOF
kind = "add"
name = "list_utils"
version = "1.0.0"
repo = "https://github.com/katari-lang/katari-list-utils"
ref = "v1.0.0"
EOF
pnpm tsx src/apply-proposal.ts /tmp/proposal.toml
# Then optionally verify (needs the katari binary on PATH, or KATARI_BIN pointing at one,
# and network access to fetch the pinned tarballs):
pnpm tsx src/verify.ts staging
```

CI exercises the same entry points (`scripts/src/apply-proposal.ts` /
`scripts/src/verify.ts` / `scripts/src/cut-snapshot.ts`), with the
extra step of extracting the proposal TOML from the PR body via
`scripts/src/extract-proposal.ts`.
