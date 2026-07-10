// Verify that a snapshot (or staging) builds end-to-end.
//
// The verify is a 3-step process:
//
//   1. Construct a synthetic Katari project in a temp directory whose
//      root module imports every package in the snapshot (or the subset
//      given by --packages). Its [dependencies].registry points at this
//      repo via a file:// URL so pins resolve against the local layout.
//   2. `katari add <packages>`: the network resolve. It loads the
//      snapshot, fetches every pinned tarball, verifies each sha256
//      against the pin, and writes katari.lock. (`check`/`build` resolve
//      OFFLINE from that lock, so the registry pins have to be resolved
//      and locked first — running `check` on an unlocked project only
//      reports that the lock is missing.)
//   3. `katari check`: typecheck the assembled closure — every dep's
//      modules plus the synthetic root — against the locked sources.
//
// Usage:
//   tsx src/verify.ts <snapshot-path-or-staging>
//   tsx src/verify.ts <snapshot-path-or-staging> --packages foo,bar
//
// The first arg can be either "staging" (= package-sets/staging.toml)
// or a snapshot name (= package-sets/snapshots/<name>.toml) or an
// absolute path to a TOML file.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  loadStaging,
  packageSetsDir,
  readToml,
  repoRoot,
  snapshotsDir,
  stagingPath,
  type StagingEntry,
} from "./lib.js";

interface SnapshotData {
  katari_compiler: string;
  packages: Record<string, StagingEntry>;
  registrySnapshotName: string;
}

async function main(): Promise<void> {
  const [snapshotArg, ...rest] = process.argv.slice(2);
  if (!snapshotArg) {
    throw new Error(
      "usage: verify.ts <snapshot-name|staging|path.toml> [--packages foo,bar]",
    );
  }
  const packagesFilter = parsePackagesFlag(rest);

  const snapshot = await loadSnapshotByArg(snapshotArg);
  const selectedNames =
    packagesFilter ?? Object.keys(snapshot.packages).sort();

  if (selectedNames.length === 0) {
    console.log("nothing to verify (empty selection)");
    return;
  }

  const projectDir = await mkdtemp(join(tmpdir(), "katari-registry-verify-"));
  try {
    await scaffoldProject(projectDir, snapshot, selectedNames);
    // Resolve the registry pins into katari.lock, then typecheck the locked closure. Either step
    // failing is a failed verify.
    if (!runKatari(["add", ...selectedNames], projectDir)) {
      throw new Error(`katari add (resolve) failed in ${projectDir}`);
    }
    if (!runKatari(["check"], projectDir)) {
      throw new Error(`katari check failed in ${projectDir}`);
    }
    console.log(`verified ${selectedNames.length} packages`);
  } finally {
    if (!process.env.KATARI_VERIFY_KEEP_TMP) {
      await rm(projectDir, { recursive: true, force: true });
    } else {
      console.log(`(kept temp project at ${projectDir})`);
    }
  }
}

function parsePackagesFlag(args: string[]): string[] | undefined {
  const idx = args.indexOf("--packages");
  if (idx < 0) return undefined;
  const list = args[idx + 1];
  if (!list) throw new Error("--packages requires a comma-separated list");
  return list.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function loadSnapshotByArg(arg: string): Promise<SnapshotData> {
  if (arg === "staging") {
    const s = await loadStaging();
    return {
      katari_compiler: s.katari_compiler,
      packages: s.packages,
      registrySnapshotName: "staging",
    };
  }
  let path: string;
  let name: string;
  if (isAbsolute(arg) || arg.endsWith(".toml")) {
    path = arg;
    name = arg.replace(/\.toml$/, "").split("/").pop() ?? arg;
  } else {
    path = join(snapshotsDir, `${arg}.toml`);
    name = arg;
  }
  const raw = await readToml<Record<string, unknown>>(path);
  const katari_compiler = raw.katari_compiler;
  if (typeof katari_compiler !== "string") {
    throw new Error(`${path}: katari_compiler must be a string`);
  }
  const packages: Record<string, StagingEntry> = {};
  const pkgs = (raw.packages ?? {}) as Record<string, Record<string, unknown>>;
  for (const [n, entry] of Object.entries(pkgs)) {
    const v = entry.version;
    const r = entry.repo;
    const f = entry.ref;
    const s = entry.sha256;
    if (
      typeof v !== "string" ||
      typeof r !== "string" ||
      typeof f !== "string" ||
      typeof s !== "string"
    ) {
      throw new Error(`${path}: packages.${n} missing required fields`);
    }
    packages[n] = { version: v, repo: r, ref: f, sha256: s };
  }
  return { katari_compiler, packages, registrySnapshotName: name };
}

async function scaffoldProject(
  projectDir: string,
  snapshot: SnapshotData,
  selected: string[],
): Promise<void> {
  // staging.toml is loaded from package-sets/staging.toml or
  // package-sets/snapshots/<name>.toml relative to the registry root.
  // katari's file:// registry URL needs to point at the registry root
  // (= the dir CONTAINING package-sets/).
  const registryUrl = `file://${repoRoot}`;

  // A minimal VALID katari.toml (Katari.Project.Config): [package] + a REQUIRED [runtime] section
  // (there is no [compile] section — the source dir is [package].src, defaulting to "src"). packages
  // starts empty; `katari add` fills it in and writes katari.lock.
  const katariToml = [
    `[package]`,
    `name = "registry_verify_root"`,
    ``,
    `[runtime]`,
    // Never contacted by `add`/`check` (both resolve locally); the URL only satisfies the schema.
    `url = "http://localhost:3000"`,
    ``,
    `[dependencies]`,
    `registry = "${registryUrl}"`,
    `snapshot = "${snapshot.registrySnapshotName}"`,
    `packages = []`,
    ``,
  ].join("\n");
  await writeFile(join(projectDir, "katari.toml"), katariToml, "utf-8");

  await mkdir(join(projectDir, "src"), { recursive: true });
  const imports = selected.map((n) => `import ${n}`).join("\n");
  const main = `${imports}\n\nagent main() -> null { null }\n`;
  await writeFile(join(projectDir, "src", "registry_verify_root.ktr"), main, "utf-8");

  // Make sure the registry layout the synthetic project resolves
  // against is what we built. Sanity check by reading the same
  // snapshot back through the file system.
  const checkPath =
    snapshot.registrySnapshotName === "staging"
      ? stagingPath
      : join(packageSetsDir, "snapshots", `${snapshot.registrySnapshotName}.toml`);
  await readToml(checkPath);
}

// Run one katari subcommand against the scaffolded project. `-C DIR` selects the project directory
// (Katari.Cli.Options.directoryOption). KATARI_BIN overrides the binary discovered on PATH.
function runKatari(args: string[], projectDir: string): boolean {
  const katari = process.env.KATARI_BIN ?? "katari";
  const result = spawnSync(katari, [...args, "-C", projectDir], {
    stdio: "inherit",
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(
      `failed to run '${katari} ${args.join(" ")}': ${result.error.message}. Set KATARI_BIN to override the binary path.`,
    );
  }
  return result.status === 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
