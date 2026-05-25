import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

// ===========================================================================
// Paths
// ===========================================================================

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const repoRoot = resolve(scriptsDir, "..");
export const packagesDir = join(repoRoot, "packages");
export const packageSetsDir = join(repoRoot, "package-sets");
export const stagingPath = join(packageSetsDir, "staging.toml");
export const snapshotsDir = join(packageSetsDir, "snapshots");

export function packageMetaPath(name: string, version: string): string {
  return join(packagesDir, name, `${version}.toml`);
}

export function snapshotPath(name: string): string {
  return join(snapshotsDir, `${name}.toml`);
}

// ===========================================================================
// TOML IO
// ===========================================================================

export async function readToml<T = TOML.JsonMap>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return TOML.parse(raw) as unknown as T;
}

export async function writeToml(path: string, value: TOML.JsonMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const out = TOML.stringify(value);
  await writeFile(path, out, "utf-8");
}

// ===========================================================================
// Validation
// ===========================================================================

const PACKAGE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function validatePackageName(name: string): void {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new Error(
      `invalid package name '${name}': must match [A-Za-z_][A-Za-z0-9_]*`,
    );
  }
}

export function validateSemver(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`invalid semver '${version}': expected MAJOR.MINOR.PATCH[-PRE]`);
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`invalid semver: ${a} / ${b}`);
  for (let i = 1; i <= 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na !== nb) return na - nb;
  }
  // Pre-release: presence sorts before absence (1.0.0-rc < 1.0.0).
  const preA = pa[4];
  const preB = pb[4];
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA && preB) return preA < preB ? -1 : preA > preB ? 1 : 0;
  return 0;
}

// ===========================================================================
// GitHub helpers
// ===========================================================================

interface GitHubLocation {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function parseGitHubUrl(url: string): GitHubLocation {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (!m) {
    throw new Error(
      `not a GitHub URL: ${url} (only https://github.com/<owner>/<repo> is supported)`,
    );
  }
  const owner = m[1]!;
  const repo = m[2]!;
  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

export async function resolveGitRef(
  repoUrl: string,
  ref: string,
): Promise<string> {
  const { owner, repo } = parseGitHubUrl(repoUrl);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "katari-registry-scripts",
  };
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    throw new Error(
      `failed to resolve ref '${ref}' for ${repoUrl}: HTTP ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { sha: string };
  if (typeof data.sha !== "string" || data.sha.length !== 40) {
    throw new Error(
      `unexpected response from GitHub commits API for ${repoUrl} @ ${ref}`,
    );
  }
  return data.sha;
}

export async function fetchTarballSha256(
  repoUrl: string,
  sha: string,
): Promise<string> {
  const { canonicalUrl } = parseGitHubUrl(repoUrl);
  const url = `${canonicalUrl}/archive/${sha}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

// ===========================================================================
// Domain types
// ===========================================================================

export interface Proposal {
  kind: "add" | "update" | "remove";
  name: string;
  version?: string;
  repo?: string;
  ref?: string;
}

export interface PackageMeta {
  name: string;
  version: string;
  repo: string;
  ref: string;
  sha256: string;
  published_time: string;
}

export interface StagingEntry {
  version: string;
  repo: string;
  ref: string;
  sha256: string;
}

export interface Staging {
  katari_compiler: string;
  packages: Record<string, StagingEntry>;
}

// ===========================================================================
// Proposal parsing
// ===========================================================================

export async function loadProposal(path: string): Promise<Proposal> {
  const raw = await readToml<Record<string, unknown>>(path);
  const kind = raw.kind;
  if (kind !== "add" && kind !== "update" && kind !== "remove") {
    throw new Error(
      `proposal '${path}': kind must be one of "add" | "update" | "remove" (got ${JSON.stringify(kind)})`,
    );
  }
  const name = raw.name;
  if (typeof name !== "string") {
    throw new Error(`proposal '${path}': name must be a string`);
  }
  validatePackageName(name);

  if (kind === "remove") {
    return { kind, name };
  }

  const version = raw.version;
  const repo = raw.repo;
  const ref = raw.ref;
  if (typeof version !== "string" || typeof repo !== "string" || typeof ref !== "string") {
    throw new Error(
      `proposal '${path}': kind=${kind} requires string fields version, repo, ref`,
    );
  }
  validateSemver(version);
  parseGitHubUrl(repo); // throws if not a GitHub URL

  return { kind, name, version, repo, ref };
}

// ===========================================================================
// Staging IO
// ===========================================================================

export async function loadStaging(): Promise<Staging> {
  const raw = await readToml<Record<string, unknown>>(stagingPath);
  const katari_compiler = raw.katari_compiler;
  if (typeof katari_compiler !== "string") {
    throw new Error(
      `staging.toml: katari_compiler must be a string (got ${JSON.stringify(katari_compiler)})`,
    );
  }
  const packages: Record<string, StagingEntry> = {};
  const pkgs = (raw.packages ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, entry] of Object.entries(pkgs)) {
    validatePackageName(name);
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
      throw new Error(`staging.toml: packages.${name} is missing required fields`);
    }
    packages[name] = { version: v, repo: r, ref: f, sha256: s };
  }
  return { katari_compiler, packages };
}

export async function writeStaging(staging: Staging): Promise<void> {
  const out: TOML.JsonMap = {
    katari_compiler: staging.katari_compiler,
    packages: {} as TOML.JsonMap,
  };
  // Sort packages for deterministic output.
  const names = Object.keys(staging.packages).sort();
  for (const name of names) {
    (out.packages as TOML.JsonMap)[name] = {
      ...staging.packages[name]!,
    } as unknown as TOML.JsonMap;
  }
  await writeToml(stagingPath, out);
}

// ===========================================================================
// Package metadata IO
// ===========================================================================

export async function writePackageMeta(meta: PackageMeta): Promise<void> {
  const path = packageMetaPath(meta.name, meta.version);
  if (existsSync(path)) {
    throw new Error(
      `package metadata already exists at ${path}; per-version metadata is immutable`,
    );
  }
  await writeToml(path, { ...meta } as unknown as TOML.JsonMap);
}

export async function loadPackageMeta(
  name: string,
  version: string,
): Promise<PackageMeta> {
  const path = packageMetaPath(name, version);
  const raw = await readToml<Record<string, unknown>>(path);
  for (const field of [
    "name",
    "version",
    "repo",
    "ref",
    "sha256",
    "published_time",
  ] as const) {
    if (typeof raw[field] !== "string") {
      throw new Error(`${path}: missing or non-string field '${field}'`);
    }
  }
  return raw as unknown as PackageMeta;
}
