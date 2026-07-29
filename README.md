# katari-registry

Centralized snapshot registry for the [Katari](https://github.com/katari-lang/katari)
ecosystem. A **snapshot** is a curated set of (package, version) pairs
that are guaranteed to compile together.

This repo is **the source of truth for resolution**. The Katari CLI
(`katari lock`, `katari add`, `katari update`, ...) reads a snapshot from
here, fetches the listed packages, and uses them to satisfy
`[dependencies]` in a project's `katari.toml`.

## Layout

```
packages/                            # SSoT: one file per (package, version)
  <pkg>/
    <version>.toml                   # metadata (repo, ref, sha256, ...)
package-sets/
  staging.toml                       # next snapshot candidate (= mutable)
  index.toml                         # every cut and when it was made (append-only)
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
full set still builds. Every cut is also recorded in
[`package-sets/index.toml`](#the-snapshot-index--package-setsindextoml),
which is how a client finds the newest one.

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
   typechecks the locked closure. `check` resolves offline from that
   lock and refuses if it disagrees with `katari.toml`, so the resolve
   has to come first.
6. Verify the **README examples**: every ` ```katari ` fence in every
   fetched package's `README.md` becomes one more module in that same
   project and `katari check` runs again. See below.

### The README example gate

A package's README is the first Katari a new user runs, so a fence in one
is not a picture of code — it is code, compiled against the very versions
the snapshot pins. Two rules follow, and they are the package author's:

- **A ` ```katari ` block must be a whole module.** Its own `import`
  lines, its own declarations. A snippet that only reads inside a
  surrounding agent has to grow that agent — which is usually the better
  example anyway, since the effect row is half of what a reader came for.
- **A block that continues the one above it is fenced ` ```katari
  continues `**, and is compiled with every earlier block of the same
  README prepended. That is the only way two fences share a scope, and it
  is declared rather than inferred: "this one happens to reference that
  one" is not something a reader can see or a checker should guess.

Anything that is **not Katari source** — a signature listing, a shell
transcript, a rendered error message — takes some other info string
(` ```text `) and is never compiled. That is the whole opt-out, and it is
machine-readable on purpose: `katari` means *this compiles*.

A failure names the package's README and the line inside it, not the
synthetic module the block was compiled as. The implementation is
[`scripts/src/readme-examples.ts`](scripts/src/readme-examples.ts), and
`scripts/src/readme-examples.test.ts` holds its tests — including the one
that matters, a fixture README with a stale example that has to turn the
check red.

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

### The snapshot index — `package-sets/index.toml`

```toml
version = 1

[[snapshots]]
name            = "snapshot-2026-07-26-a7cc1e51"
cut_time        = "2026-07-26T18:46:13Z"
katari_compiler = "0.1.0"
```

This is how a consumer answers "which snapshots exist, and which is the
newest" — `katari update` reads it to re-pin a project. It has to be a
published file: the CLI reaches a registry through a plain raw-file base
URL, which has no directory listing, and teaching it to call a *host's*
listing API would tie it to GitHub.

**`cut_time` is the order, and the name is not.** A snapshot's `<hash>`
tail is content, not time: `snapshot-2026-07-26-a7cc1e51` sorts before
`snapshot-2026-07-26-bcc95cb3` while being the *newer* cut. Sorting the
names would silently hand a consumer an older package set, so the order
is carried as data instead. `cut_time` is always UTC in exactly
`YYYY-MM-DDTHH:MM:SSZ` — one fixed width, so a client can order the set
with a string comparison and needs no date parser.

Entries are written oldest-first as a courtesy to readers; that file
order carries no meaning, and clients order on `cut_time`.

The file is **append-only**. `cut-snapshot.ts` records each cut it makes
from the same clock reading that names the file, so the entry's date and
the filename's date always agree. Entries for the snapshots cut before
the index existed were backfilled by
[`scripts/src/rebuild-index.ts`](#running-scripts-locally) from the
authored date of the commit that added each snapshot file — the only
honest record left of when those cuts happened. A recovered timestamp is
never allowed to overwrite a recorded one.

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
# and network access to fetch the pinned tarballs). This also checks every ```katari example
# in the fetched packages' READMEs:
pnpm tsx src/verify.ts staging
# The scripts' own tests. The README gate's end-to-end half needs a katari binary and skips
# with a notice when there is none; everything else runs anywhere:
pnpm test
# Repair package-sets/index.toml if a cut ever lands without its entry. Idempotent, and it
# only ever ADDS: it recovers a missing cut_time from git, and leaves recorded ones alone.
pnpm tsx src/rebuild-index.ts --dry-run
```

CI exercises the same entry points (`scripts/src/apply-proposal.ts` /
`scripts/src/verify.ts` / `scripts/src/cut-snapshot.ts`) plus `pnpm test`,
with the extra step of extracting the proposal TOML from the PR body via
`scripts/src/extract-proposal.ts`.
