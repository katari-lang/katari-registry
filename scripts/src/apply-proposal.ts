// Apply a proposal file: resolve its (repo, ref) to a concrete commit
// SHA + tarball sha256, write the per-version metadata under
// `packages/<name>/<version>.toml`, and update `package-sets/staging.toml`
// to point at the new version.
//
// Usage:   tsx src/apply-proposal.ts <path/to/proposal.toml>
//
// The proposal file is deleted on success so the merged PR ends in a
// clean state.

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  type Proposal,
  type Staging,
  compareSemver,
  fetchTarballSha256,
  loadProposal,
  loadStaging,
  packageMetaPath,
  parseGitHubUrl,
  resolveGitRef,
  writePackageMeta,
  writeStaging,
} from "./lib.js";

async function main(): Promise<void> {
  const [proposalPath] = process.argv.slice(2);
  if (!proposalPath) {
    throw new Error("usage: apply-proposal.ts <path/to/proposal.toml>");
  }

  const proposal = await loadProposal(proposalPath);
  const staging = await loadStaging();

  switch (proposal.kind) {
    case "add":
      await applyAdd(proposal, staging);
      break;
    case "update":
      await applyUpdate(proposal, staging);
      break;
    case "remove":
      applyRemove(proposal, staging);
      break;
  }

  await writeStaging(staging);
  await unlink(proposalPath);
  console.log(`applied: ${proposalPath}`);
}

async function applyAdd(proposal: Proposal, staging: Staging): Promise<void> {
  if (proposal.kind !== "add") throw new Error("internal: expected add");
  const { name, version, repo, ref } = proposal;
  if (!version || !repo || !ref) {
    throw new Error("internal: add proposal missing version/repo/ref");
  }
  if (staging.packages[name]) {
    throw new Error(
      `'${name}' is already in staging at version ${staging.packages[name].version}; use kind="update" instead`,
    );
  }
  await writeMetadataAndStage({ name, version, repo, ref, staging });
}

async function applyUpdate(proposal: Proposal, staging: Staging): Promise<void> {
  if (proposal.kind !== "update") throw new Error("internal: expected update");
  const { name, version, repo, ref } = proposal;
  if (!version || !repo || !ref) {
    throw new Error("internal: update proposal missing version/repo/ref");
  }
  const current = staging.packages[name];
  if (!current) {
    throw new Error(
      `'${name}' is not in staging; use kind="add" to introduce it`,
    );
  }
  if (compareSemver(version, current.version) <= 0) {
    throw new Error(
      `update would not advance version: staging has ${name}@${current.version}, proposal has ${version}`,
    );
  }
  await writeMetadataAndStage({ name, version, repo, ref, staging });
}

function applyRemove(proposal: Proposal, staging: Staging): void {
  if (proposal.kind !== "remove") throw new Error("internal: expected remove");
  const { name } = proposal;
  if (!staging.packages[name]) {
    throw new Error(`'${name}' is not in staging; nothing to remove`);
  }
  delete staging.packages[name];
}

interface WriteArgs {
  name: string;
  version: string;
  repo: string;
  ref: string;
  staging: Staging;
}

async function writeMetadataAndStage(args: WriteArgs): Promise<void> {
  const { name, version, repo, ref, staging } = args;
  const { canonicalUrl } = parseGitHubUrl(repo);
  const metaPath = packageMetaPath(name, version);
  if (existsSync(metaPath)) {
    throw new Error(
      `${metaPath} already exists; per-version metadata is immutable. Bump the version.`,
    );
  }
  const resolvedRef = await resolveGitRef(canonicalUrl, ref);
  const sha256 = await fetchTarballSha256(canonicalUrl, resolvedRef);
  await writePackageMeta({
    name,
    version,
    repo: canonicalUrl,
    ref: resolvedRef,
    sha256,
    published_time: new Date().toISOString(),
  });
  staging.packages[name] = {
    version,
    repo: canonicalUrl,
    ref: resolvedRef,
    sha256,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
