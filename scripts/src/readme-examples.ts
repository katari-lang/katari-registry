// The ```katari fences in a package's README, as modules the compiler checks.
//
// A package README is the first Katari a new user reads, and until this existed nothing checked it:
// an example went stale the moment the package it documents changed shape, and the reader found out
// by pasting it and losing an afternoon to an error the package's own maintainer had never seen. So
// a fence is not a picture of code here — it IS code, compiled against the very closure the verify
// already resolved.
//
// The mechanism is one line long: after `verify.ts` has locked the snapshot and typechecked the
// synthetic project, every ```katari block of every selected package's README becomes one more
// module in that same project, and `katari check` runs again. Nothing is fetched, nothing is
// re-resolved — the examples see exactly the packages the snapshot pins, which is what makes a
// passing README a statement about THIS snapshot rather than about whatever was checked out when it
// was written.
//
// Two rules fall out of "a block is a module", and both are the author's to obey:
//
//   1. A ```katari block must be a WHOLE module — its own `import` lines, its own declarations. A
//      snippet that only reads well inside a surrounding agent has to grow that agent, which is
//      almost always the better example anyway (the effect row is half of what a reader came for).
//   2. A block that genuinely continues the one above it — the second half of a worked example,
//      under its own heading — is fenced ```katari continues, and is compiled with every earlier
//      block of the same README prepended. That is the ONE way two fences share a scope, and it is
//      written down rather than inferred, because "this one happens to reference that one" is not
//      something a reader can see and not something a checker should guess.
//
// Anything that is not Katari source — a signature listing, a shell transcript, a rendered error —
// takes some other info string (```text) and is not a block this file will ever see. That is the
// whole opt-out, and it is machine-readable on purpose: `katari` means "this compiles".

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readToml } from "./lib.js";

// One ```katari fence, as it stands in the README.
export interface KatariBlock {
  // 1-based line of the opening fence itself; the block's first line of code is the next one.
  fenceLine: number;
  body: string;
  // Fenced ```katari continues: compiled with every earlier block of the same README prepended.
  continues: boolean;
}

// One block, compiled: the module it became and where each of its lines came from.
export interface ExampleModule {
  packageName: string;
  // 1-based index of the block within its README, as a human counts them.
  index: number;
  moduleName: string;
  readmePath: string;
  source: string;
  // sourceReadmeLines[i] is the README line number that module line i+1 came from.
  sourceReadmeLines: number[];
}

// ===========================================================================
// Extraction
// ===========================================================================

// Pull every ```katari fence out of a Markdown document.
//
// Fences are recognised the way CommonMark defines them — three or more backticks or tildes, closed
// by a run of the same character at least as long carrying no info string — because a README is read
// by GitHub before it is read by this. A fence whose info string names any other language is skipped
// whole, so a ```katari block can be quoted inside a ```markdown one without being compiled.
export function extractKatariBlocks(markdown: string): KatariBlock[] {
  const lines = markdown.split("\n");
  const blocks: KatariBlock[] = [];
  let open:
    | { char: string; length: number; fenceLine: number; body: string[]; katari: boolean; continues: boolean }
    | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (open !== null) open.body.push(line);
      continue;
    }
    const marks = fence[1]!;
    const info = fence[2]!.trim();
    if (open === null) {
      const words = info.split(/\s+/).filter((w) => w.length > 0);
      open = {
        char: marks[0]!,
        length: marks.length,
        fenceLine: i + 1,
        body: [],
        katari: words[0] === "katari",
        continues: words.includes("continues"),
      };
      continue;
    }
    const closes = marks[0] === open.char && marks.length >= open.length && info === "";
    if (!closes) {
      open.body.push(line);
      continue;
    }
    if (open.katari) {
      blocks.push({ fenceLine: open.fenceLine, body: open.body.join("\n"), continues: open.continues });
    }
    open = null;
  }
  return blocks;
}

// The module name a block is compiled under. It carries the package and the block's position, so a
// diagnostic names the README it came from even before the line mapping is applied.
export function exampleModuleName(packageName: string, index: number): string {
  return `${packageName}_readme_${index}`;
}

// Turn one README into its modules, resolving `continues` into the prepended source (and the line
// map that survives the prepending, so a diagnostic still points at the block the reader sees).
export function readmeExampleModules(
  packageName: string,
  readmePath: string,
  markdown: string,
): ExampleModule[] {
  const blocks = extractKatariBlocks(markdown);
  const modules: ExampleModule[] = [];
  let carriedSource: string[] = [];
  let carriedLines: number[] = [];

  blocks.forEach((block, n) => {
    const bodyLines = block.body.split("\n");
    // The body's first line sits one below the opening fence.
    const bodyReadmeLines = bodyLines.map((_, k) => block.fenceLine + 1 + k);
    const sourceLines = block.continues ? [...carriedSource, ...bodyLines] : bodyLines;
    const readmeLines = block.continues ? [...carriedLines, ...bodyReadmeLines] : bodyReadmeLines;
    modules.push({
      packageName,
      index: n + 1,
      moduleName: exampleModuleName(packageName, n + 1),
      readmePath,
      source: sourceLines.join("\n") + "\n",
      sourceReadmeLines: readmeLines,
    });
    carriedSource = sourceLines;
    carriedLines = readmeLines;
  });
  return modules;
}

// ===========================================================================
// The fetched packages' READMEs
// ===========================================================================

// Where `katari add` left each package's source: <projectDir>/.katari/packages/<name>-<sha>/ (see
// Katari.Project.Cache). The directory name carries the name, but the package's own katari.toml is
// what is READ for it — a content hash is not something this file should be parsing back apart.
export async function locateFetchedPackages(
  projectDir: string,
): Promise<Map<string, string>> {
  const packagesDir = join(projectDir, ".katari", "packages");
  const located = new Map<string, string>();
  if (!existsSync(packagesDir)) return located;
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifest = join(dir, "katari.toml");
    if (!existsSync(manifest)) continue;
    const raw = await readToml<Record<string, unknown>>(manifest);
    const pkg = raw.package;
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) continue;
    const name = (pkg as Record<string, unknown>).name;
    if (typeof name !== "string") continue;
    const already = located.get(name);
    if (already !== undefined && already !== dir) {
      throw new Error(
        `two fetched sources claim to be package '${name}' (${already} and ${dir}); the verify's lock should pin exactly one`,
      );
    }
    located.set(name, dir);
  }
  return located;
}

// Write every selected package's README examples into the synthetic project as modules of its own
// namespace (a package may only provide modules under its own name — see Katari.Project.Modules), and
// hand back what was written so a failure can be pointed back at its README.
export async function writeReadmeExampleModules(
  projectDir: string,
  rootModuleName: string,
  packageNames: string[],
): Promise<ExampleModule[]> {
  const located = await locateFetchedPackages(projectDir);
  const written: ExampleModule[] = [];
  const moduleDir = join(projectDir, "src", rootModuleName);

  for (const name of packageNames) {
    const dir = located.get(name);
    // A package resolved from a path override is not in the cache; nothing to read, nothing to check.
    if (dir === undefined) continue;
    const readmePath = join(dir, "README.md");
    if (!existsSync(readmePath)) continue;
    const modules = readmeExampleModules(name, readmePath, await readFile(readmePath, "utf-8"));
    if (modules.length === 0) continue;
    await mkdir(moduleDir, { recursive: true });
    for (const module of modules) {
      await writeFile(join(moduleDir, `${module.moduleName}.ktr`), module.source, "utf-8");
      written.push(module);
    }
  }
  return written;
}

// ===========================================================================
// Reporting
// ===========================================================================

// Rewrite `katari check`'s diagnostics so they name the README and the line a reader can go and look
// at, instead of the synthetic module and the line inside it. A diagnostic that names no example
// module passes through untouched — the same run also re-checks the root, and a failure there is
// still worth printing verbatim.
export function locateExampleDiagnostics(
  output: string,
  rootModuleName: string,
  modules: ExampleModule[],
): string {
  const byModule = new Map(modules.map((m) => [m.moduleName, m]));
  const location = new RegExp(`\\b${rootModuleName}\\.([A-Za-z0-9_]+):(\\d+):(\\d+)`, "g");
  return output.replace(location, (whole, moduleName: string, line: string, column: string) => {
    const module = byModule.get(moduleName);
    if (module === undefined) return whole;
    const readmeLine = module.sourceReadmeLines[Number(line) - 1];
    if (readmeLine === undefined) return `${module.packageName} README.md (example #${module.index})`;
    return `${module.packageName} README.md:${readmeLine}:${column} (example #${module.index})`;
  });
}
