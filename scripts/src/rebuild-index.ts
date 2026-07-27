// Fill `package-sets/index.toml` in for snapshots it does not yet record.
//
// `cut-snapshot.ts` records every cut it makes, so this script exists for the
// snapshots cut before the index did — and as a repair for any that slipped
// through (a cut whose file was committed but whose index entry was not).
//
// The honest source for a historical cut_time is git: the index did not exist
// when those snapshots were made, so nothing else recorded the instant. We take
// the author date of the commit that ADDED the snapshot file, which is when the
// nightly cut ran, and normalise it to the index's fixed UTC shape. Entries the
// index already holds are never rewritten — a cut_time taken from the cutting
// clock is closer to the truth than one recovered from a commit, so the first
// value written wins.
//
// Usage:   tsx src/rebuild-index.ts [--dry-run]

import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  formatCutTime,
  loadIndex,
  readToml,
  repoRoot,
  snapshotsDir,
  writeIndex,
  type SnapshotIndexEntry,
} from "./lib.js";

// The instant the commit that first added `path` was authored, or undefined when
// the file is not in git history yet (a cut made in the working tree).
function gitAddedTime(path: string): Date | undefined {
  const stdout = execFileSync(
    "git",
    ["log", "--diff-filter=A", "--format=%aI", "-1", "--", path],
    { cwd: repoRoot, encoding: "utf-8" },
  ).trim();
  if (stdout === "") {
    return undefined;
  }
  const when = new Date(stdout);
  return Number.isNaN(when.getTime()) ? undefined : when;
}

async function compilerVersionOf(path: string): Promise<string> {
  const raw = await readToml<Record<string, unknown>>(path);
  const compiler = raw.katari_compiler;
  if (typeof compiler !== "string") {
    throw new Error(`${path}: katari_compiler must be a string`);
  }
  return compiler;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const index = await loadIndex();
  const known = new Set(index.snapshots.map((entry) => entry.name));

  const files = (await readdir(snapshotsDir)).filter((file) => file.endsWith(".toml")).sort();
  const added: SnapshotIndexEntry[] = [];
  for (const file of files) {
    const name = file.replace(/\.toml$/, "");
    if (known.has(name)) {
      continue;
    }
    const path = join(snapshotsDir, file);
    const when = gitAddedTime(path);
    if (when === undefined) {
      throw new Error(
        `${path} is not in git history, so its cut time cannot be recovered; commit it first, or cut it through cut-snapshot.ts`,
      );
    }
    added.push({
      name,
      cut_time: formatCutTime(when),
      katari_compiler: await compilerVersionOf(path),
    });
  }

  if (added.length === 0) {
    console.log(`index.toml already records all ${index.snapshots.length} snapshots`);
    return;
  }

  for (const entry of added) {
    console.log(`${dryRun ? "would add" : "add"} ${entry.name}  ${entry.cut_time}`);
  }
  if (dryRun) {
    return;
  }
  index.snapshots.push(...added);
  await writeIndex(index);
  console.log(`index.toml now records ${index.snapshots.length} snapshots`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
