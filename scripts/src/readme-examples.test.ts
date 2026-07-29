// What the README gate promises, as assertions.
//
// Run it with `pnpm test` (node's own test runner under tsx — no runner dependency, the same bargain
// the package repos' `scripts/*.mjs` checks make). The end-to-end half needs a katari binary, so it
// is a SEPARATE test that skips with a notice when there is none: the extraction and the diagnostic
// mapping are what go wrong in practice, and they are checkable with no toolchain at all.
//
// The load-bearing case is the last one — a README whose example is BROKEN must fail the verify. A
// gate nothing has ever seen fail is a gate nobody knows is wired up.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  extractKatariBlocks,
  locateExampleDiagnostics,
  locateFetchedPackages,
  readmeExampleModules,
  writeReadmeExampleModules,
} from "./readme-examples.js";

const temporaries: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "katari-readme-test-"));
  temporaries.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

describe("extractKatariBlocks", () => {
  test("takes ```katari fences and leaves every other fence alone", () => {
    const md = [
      "# a package",
      "",
      "```katari",
      "agent one() -> null { null }",
      "```",
      "",
      "```text",
      "pkg.thing(a, b) -> c   // a signature listing, not source",
      "```",
      "",
      "```",
      "$ pnpm test",
      "```",
      "",
      "```katari",
      "agent two() -> null { null }",
      "```",
    ].join("\n");
    const blocks = extractKatariBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.body, "agent one() -> null { null }");
    assert.equal(blocks[1]!.body, "agent two() -> null { null }");
    assert.equal(blocks[0]!.fenceLine, 3);
    assert.equal(blocks[1]!.fenceLine, 15);
  });

  test("a ```katari fence quoted inside another fence is not source", () => {
    const md = ["````markdown", "```katari", "agent quoted() -> null { null }", "```", "````"].join("\n");
    assert.deepEqual(extractKatariBlocks(md), []);
  });

  test("`continues` is read off the info string", () => {
    const md = ["```katari", "agent one() -> null { null }", "```", "```katari continues", "agent two() -> null { one() }", "```"].join("\n");
    const blocks = extractKatariBlocks(md);
    assert.equal(blocks[0]!.continues, false);
    assert.equal(blocks[1]!.continues, true);
  });

  test("tilde fences and indented fences are fences", () => {
    const md = ["  ~~~katari", "  agent one() -> null { null }", "  ~~~"].join("\n");
    assert.equal(extractKatariBlocks(md).length, 1);
  });
});

describe("readmeExampleModules", () => {
  const md = [
    "# pkg",
    "",
    "```katari",
    "import pkg",
    "agent one() -> null { null }",
    "```",
    "",
    "## and the rest of it",
    "",
    "```katari continues",
    "agent two() -> null { one() }",
    "```",
  ].join("\n");

  test("one module per block, named for its package and position", () => {
    const modules = readmeExampleModules("pkg", "/x/README.md", md);
    assert.deepEqual(
      modules.map((m) => m.moduleName),
      ["pkg_readme_1", "pkg_readme_2"],
    );
  });

  test("a `continues` block is compiled with the blocks above it prepended", () => {
    const modules = readmeExampleModules("pkg", "/x/README.md", md);
    assert.equal(modules[0]!.source, "import pkg\nagent one() -> null { null }\n");
    assert.equal(
      modules[1]!.source,
      "import pkg\nagent one() -> null { null }\nagent two() -> null { one() }\n",
    );
  });

  test("every module line still knows the README line it came from", () => {
    const modules = readmeExampleModules("pkg", "/x/README.md", md);
    // Block 1's two lines are README lines 4 and 5.
    assert.deepEqual(modules[0]!.sourceReadmeLines, [4, 5]);
    // Block 2 carries those two, then its own line 11.
    assert.deepEqual(modules[1]!.sourceReadmeLines, [4, 5, 11]);
  });
});

describe("locateExampleDiagnostics", () => {
  const modules = readmeExampleModules(
    "pkg",
    "/x/README.md",
    ["```katari", "import pkg", "agent one() -> null { nope() }", "```"].join("\n"),
  );

  test("a diagnostic is rewritten to the README line a reader can open", () => {
    // Module line 2 is the README's line 3: the fence is line 1 and the body starts below it.
    const raw = "root.pkg_readme_1:2:24 K2001: Undefined name: nope";
    assert.equal(
      locateExampleDiagnostics(raw, "root", modules),
      "pkg README.md:3:24 (example #1) K2001: Undefined name: nope",
    );
  });

  test("a diagnostic about anything else passes through verbatim", () => {
    const raw = "root:1:1 K1001: unexpected end of input";
    assert.equal(locateExampleDiagnostics(raw, "root", modules), raw);
  });
});

describe("locateFetchedPackages", () => {
  test("a fetched package is found by the name its own katari.toml declares", async () => {
    const project = await scratch();
    const dir = join(project, ".katari", "packages", "widget-deadbeef");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "katari.toml"), '[package]\nname = "widget"\n', "utf-8");
    const located = await locateFetchedPackages(project);
    assert.deepEqual([...located.keys()], ["widget"]);
    assert.equal(located.get("widget"), dir);
  });

  test("a project that fetched nothing has nothing to check", async () => {
    assert.equal((await locateFetchedPackages(await scratch())).size, 0);
  });
});

// ---------------------------------------------------------------------------
// End to end: a broken example has to turn the check red.
// ---------------------------------------------------------------------------

const katariBin = process.env.KATARI_BIN ?? "katari";
const haveKatari = spawnSync(katariBin, ["--version"], { encoding: "utf-8" }).status === 0;

// Scaffold a project holding one package (by path override, so nothing is fetched) whose README
// carries the given fences, and run the same two moves the verify's step 4 makes.
async function checkReadme(readme: string): Promise<{ ok: boolean; output: string; modules: number }> {
  const root = await scratch();
  const pkgDir = join(root, "widget");
  await mkdir(join(pkgDir, "src"), { recursive: true });
  await writeFile(
    join(pkgDir, "katari.toml"),
    '[package]\nname = "widget"\n\n[runtime]\nurl = "http://localhost:3000"\n\n[dependencies]\npackages = []\n',
    "utf-8",
  );
  await writeFile(join(pkgDir, "src", "widget.ktr"), "agent poke(value: null) -> null { null }\n", "utf-8");
  await writeFile(join(pkgDir, "README.md"), readme, "utf-8");

  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "katari.toml"),
    [
      "[package]",
      'name = "verify_root"',
      "",
      "[runtime]",
      'url = "http://localhost:3000"',
      "",
      "[dependencies]",
      'packages = ["widget"]',
      "",
      "[overrides.widget]",
      `path = "${pkgDir}"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(join(project, "src", "verify_root.ktr"), "import widget\n\nagent main() -> null { null }\n", "utf-8");
  // A path override leaves nothing in .katari/packages, so stand the README where the gate looks.
  const cached = join(project, ".katari", "packages", "widget-0000");
  await mkdir(cached, { recursive: true });
  await writeFile(join(cached, "katari.toml"), '[package]\nname = "widget"\n', "utf-8");
  await writeFile(join(cached, "README.md"), readme, "utf-8");

  const modules = await writeReadmeExampleModules(project, "verify_root", ["widget"]);
  const lock = spawnSync(katariBin, ["lock", "-C", project], { encoding: "utf-8" });
  assert.equal(lock.status, 0, `katari lock failed: ${lock.stdout}${lock.stderr}`);
  const check = spawnSync(katariBin, ["check", "-C", project], { encoding: "utf-8" });
  return {
    ok: check.status === 0,
    output: locateExampleDiagnostics(`${check.stdout ?? ""}${check.stderr ?? ""}`, "verify_root", modules),
    modules: modules.length,
  };
}

describe("the gate, end to end", { skip: haveKatari ? false : "no katari binary (set KATARI_BIN)" }, () => {
  test("a README whose examples compile is green", async () => {
    const result = await checkReadme(
      ["# widget", "", "```katari", "import widget", "", "agent use_it() -> null { widget.poke(value = null) }", "```", ""].join("\n"),
    );
    assert.equal(result.modules, 1);
    assert.equal(result.ok, true, result.output);
  });

  test("a README whose example calls a name the package does not have is RED", async () => {
    const result = await checkReadme(
      ["# widget", "", "```katari", "import widget", "", "agent use_it() -> null { widget.prod(value = null) }", "```", ""].join("\n"),
    );
    assert.equal(result.ok, false, "a stale example must fail the check");
    // And the reader is told where to look, in the README's own coordinates.
    assert.match(result.output, /widget README\.md:6:\d+ \(example #1\)/);
  });

  test("a fragment that is not a whole module is RED — a fence says `this compiles`", async () => {
    const result = await checkReadme(
      ["# widget", "", "```katari", "let x = widget.poke(value = null)", "```", ""].join("\n"),
    );
    assert.equal(result.ok, false, "a bare statement is not a module and must not pass");
  });

  test("a ```text fence is not checked, whatever it says", async () => {
    const result = await checkReadme(
      ["# widget", "", "```text", "widget.poke(value) -> null   // a signature listing", "```", ""].join("\n"),
    );
    assert.equal(result.modules, 0);
    assert.equal(result.ok, true, result.output);
  });

  test("a `continues` block sees the block above it", async () => {
    const shared = ["# widget", "", "```katari", "import widget", "", "agent first() -> null { widget.poke(value = null) }", "```", "", "## the rest", "", "```katari continues", "agent second() -> null { first() }", "```", ""].join("\n");
    const result = await checkReadme(shared);
    assert.equal(result.modules, 2);
    assert.equal(result.ok, true, result.output);
  });
});
