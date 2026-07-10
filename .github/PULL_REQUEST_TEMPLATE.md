<!--
Adding / updating / removing a Katari package in the registry.

Fill in the TOML block below. CI will resolve `ref` to a commit SHA,
compute `sha256`, and update staging.toml.

Edits to this description re-trigger the CI.
-->

## Proposal

```toml
kind = "add"                                       # "add" | "update" | "remove"
name = "list_utils"                                # Katari identifier ([A-Za-z_][A-Za-z0-9_]*)
version = "1.0.0"                                  # semver. Omit for "remove"
repo = "https://github.com/katari-lang/katari-list-utils"  # GitHub HTTPS URL. Omit for "remove"
ref = "v1.0.0"                                     # tag / branch / commit SHA. Omit for "remove"
```

## Why

<!-- Optional: motivation, related issues, breaking change notes, etc. -->
