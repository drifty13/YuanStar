import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(web, ".tmp", "test");
const available = (await readdir(join(web, "tests"))).filter((name) => /\.test\.(ts|mjs)$/.test(name)).sort();
const requested = process.argv.slice(2);
const tests = requested.length ? requested.map((name) => {
  const matches = available.filter((file) => file === name || file.replace(/\.test\.(ts|mjs)$/, "") === name);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous test: ${name}`);
  return matches[0];
}) : available;
if (!tests.length) throw new Error("No regression suites found");

// This fixed, test-owned directory is the only recursive cleanup target.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: web, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Test command failed (exit ${result.status}, signal ${result.signal ?? "none"})`);
  }
}

const typescript = tests.filter((name) => name.endsWith(".ts"));
if (typescript.length) {
  run([
    join(web, "node_modules", "typescript", "bin", "tsc"),
    "--ignoreConfig", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--resolveJsonModule", "--lib", "ES2022,DOM",
    "--skipLibCheck", "--strict", "--noEmitOnError", "--rootDir", "..", "--outDir", output,
    ...typescript.map((name) => `tests/${name}`),
  ]);
}
for (const name of tests) {
  console.log(`\nRUN ${name}`);
  run([name.endsWith(".ts") ? join(output, "web", "tests", name.replace(/\.ts$/, ".js")) : join(web, "tests", name)]);
  console.log(`PASS ${name}`);
}
console.log(`\nPASS ${tests.length} regression suites`);
