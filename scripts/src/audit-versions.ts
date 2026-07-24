// Audit registry version labels against what each pinned ref self-reports.
//
// For every entry checked, fetch the pin's katari.toml and compare its
// `[package].version` to the label the registry records. The registry label is
// human-facing only — resolution ignores it (Katari.Project.Snapshot drops the
// `version` field) — so a label that diverges from the pin is a latent lie.
// This is the read-only companion to the registration-time check in
// apply-proposal: it surfaces labels that predate that check. Existing
// per-version metadata is immutable and is NOT rewritten here; a corrected
// label ships as a new version.
//
// Usage:
//   tsx src/audit-versions.ts            # audit the current staging set
//   tsx src/audit-versions.ts --all      # audit every packages/<name>/<version>.toml
//
// Exits non-zero if any divergence (or fetch failure) is found.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchPinPackageVersion,
  loadPackageMeta,
  loadStaging,
  packagesDir,
} from "./lib.js";

interface Entry {
  name: string;
  version: string;
  repo: string;
  ref: string;
}

interface Divergence {
  name: string;
  version: string;
  repo: string;
  ref: string;
  pinVersion: string | undefined;
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const entries = all ? await allPackageEntries() : await stagingEntries();

  if (entries.length === 0) {
    console.log("nothing to audit");
    return;
  }

  console.log(
    `auditing ${entries.length} ${all ? "per-version entries" : "staging entries"}...`,
  );

  const divergences: Divergence[] = [];
  for (const entry of entries) {
    const pinVersion = await fetchPinPackageVersion(entry.repo, entry.ref);
    const ok = pinVersion === entry.version;
    console.log(
      `  ${ok ? "ok  " : "DIFF"} ${entry.name}@${entry.version}  pin says ${pinVersion ?? "(no version field)"}`,
    );
    if (!ok) {
      divergences.push({ ...entry, pinVersion });
    }
  }

  if (divergences.length === 0) {
    console.log(`\nall ${entries.length} labels match their pins`);
    return;
  }

  console.error(`\n${divergences.length} divergence(s):`);
  for (const d of divergences) {
    console.error(
      `  ${d.name}: label ${d.version} != pin ${d.pinVersion ?? "(none)"}  (${d.repo}@${d.ref})`,
    );
  }
  process.exit(1);
}

async function stagingEntries(): Promise<Entry[]> {
  const staging = await loadStaging();
  return Object.entries(staging.packages).map(([name, entry]) => ({
    name,
    version: entry.version,
    repo: entry.repo,
    ref: entry.ref,
  }));
}

async function allPackageEntries(): Promise<Entry[]> {
  const names = await readdir(packagesDir, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    const files = await readdir(join(packagesDir, name));
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      const version = file.replace(/\.toml$/, "");
      const meta = await loadPackageMeta(name, version);
      entries.push({
        name,
        version: meta.version,
        repo: meta.repo,
        ref: meta.ref,
      });
    }
  }
  entries.sort((a, b) =>
    a.name === b.name
      ? a.version < b.version
        ? -1
        : a.version > b.version
          ? 1
          : 0
      : a.name < b.name
        ? -1
        : 1,
  );
  return entries;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
