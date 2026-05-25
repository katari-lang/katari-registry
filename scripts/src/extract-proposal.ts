// Extract the first ```toml ... ``` fenced block from a PR body and
// write the contents to an output file. CI uses this to bridge "PR
// description in GitHub UI" → "proposal TOML on disk" so the rest of
// the pipeline (= apply-proposal.ts) doesn't need to know about
// GitHub.
//
// Usage:
//   tsx src/extract-proposal.ts <pr-body-file> <out-proposal.toml>
//
// On success writes the extracted TOML to <out-proposal.toml> and exits
// 0. On failure (no fence found, malformed input) prints to stderr
// and exits 1.

import { readFile, writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const [bodyPath, outPath] = process.argv.slice(2);
  if (!bodyPath || !outPath) {
    throw new Error("usage: extract-proposal.ts <pr-body-file> <out-proposal.toml>");
  }
  const body = await readFile(bodyPath, "utf-8");
  // Match the first ```toml ... ``` fence. The fence may include
  // optional spaces / a language tag with hint (e.g. ```toml ),
  // and CRLF line endings.
  const m = body.match(/```toml\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!m) {
    throw new Error(
      "no ```toml ... ``` fence found in PR body. " +
        "Edit the PR description to include a TOML fenced block matching the template.",
    );
  }
  await writeFile(outPath, m[1]!, "utf-8");
  console.log(`extracted ${m[1]!.length} bytes → ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
