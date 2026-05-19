# katari-registry

Centralized snapshot registry for the [Katari](https://github.com/yukikurage/katari)
ecosystem. Each snapshot is a TOML file under `package-sets/` listing a
set of packages that are known to compile together at specific git refs.

This repo is **the source of truth for resolution**. The Katari CLI
(`katari add`, `katari build`, ...) reads a snapshot from here, fetches
the listed packages, and uses them to satisfy `[dependencies]` in a
project's `katari.toml`.

## Layout

```
package-sets/
  2026-05-01.toml      # one snapshot per file, named by date
  2026-06-01.toml
  ...
```

A project pins its snapshot by name:

```toml
# katari.toml in a downstream project
[snapshot]
version = "2026-05-01"
```

## Snapshot format

See [`package-sets/example.toml`](package-sets/example.toml).

Every snapshot declares:

- `katari_compiler` — the compiler version it was verified against.
  The CLI refuses to use a snapshot whose major version does not match
  the running compiler.
- `[packages.<name>]` — for each included package:
  - `repo` — git URL of the package's source
  - `ref` — git ref (tag or commit SHA) that the snapshot pins
  - (optional) `sha256` — content hash of the resolved tarball, written
    into downstream lockfiles when first observed

## Adding a package

1. Open a PR adding the package to the current open snapshot file
   (or starting a new snapshot if the current one is closed).
2. CI verifies the snapshot still compiles end-to-end.
3. Merge.

## Why a separate repo

The registry has a different release cadence from the compiler and a
different audit surface from individual package repos. Keeping it in
its own repo lets the registry move at its own pace (= roughly monthly
snapshots) and lets contributors PR a single TOML edit without touching
the compiler.
