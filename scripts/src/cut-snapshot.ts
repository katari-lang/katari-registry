// Cut a new immutable snapshot from the current staging.toml.
//
// The output filename is `snapshot-<YYYY-MM-DD>-<8-hex>.toml`, where the
// 8-hex tail is the leading bytes of sha256(staging.toml). The hash gives
// the cut a unique identity even if multiple snapshots are cut on the
// same day.
//
// The cut is also recorded in `package-sets/index.toml`. The filename alone
// cannot order two cuts made on the same day — the hash tail is content, not
// time — so the index carries the instant of the cut, taken from the same
// clock reading the filename's date comes from.
//
// Usage:   tsx src/cut-snapshot.ts [--dry-run]
//
// On success prints the new snapshot filename on stdout (= for CI to
// pick up and commit).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  appendIndexEntry,
  formatCutTime,
  loadStaging,
  snapshotPath,
  stagingPath,
  writeToml,
} from "./lib.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const staging = await loadStaging();
  if (Object.keys(staging.packages).length === 0) {
    throw new Error("staging is empty; nothing to cut");
  }

  const raw = await readFile(stagingPath, "utf-8");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  // One clock reading feeds both the filename's date and the index's cut_time,
  // so the two can never disagree about which day the cut happened on.
  const cutTime = new Date();
  const date = cutTime.toISOString().slice(0, 10); // YYYY-MM-DD
  const name = `snapshot-${date}-${hash}`;
  const outPath = snapshotPath(name);

  if (existsSync(outPath)) {
    // Same staging content already cut today — surface as a no-op.
    console.log(`already cut: ${name}`);
    return;
  }

  if (dryRun) {
    console.log(`would cut: ${name}`);
    return;
  }

  const out = {
    katari_compiler: staging.katari_compiler,
    packages: Object.fromEntries(
      Object.entries(staging.packages)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([n, e]) => [n, { ...e }]),
    ),
  };
  await writeToml(outPath, out);
  await appendIndexEntry({
    name,
    cut_time: formatCutTime(cutTime),
    katari_compiler: staging.katari_compiler,
  });
  console.log(name);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
