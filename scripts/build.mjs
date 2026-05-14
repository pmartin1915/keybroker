#!/usr/bin/env node
// scripts/build.mjs — transpile src/ to dist/ for production execution.
//
// Why this exists: keybroker's tsconfig has `noEmit: true` because dev
// + tests run via tsx (TypeScript executor). But downstream consumers
// (e.g. the budget-dispatcher project that spawns `node dist/cli.js
// serve` as a sidecar) need a plain-JS entry point at a stable path.
//
// We transpile-only (no type checking, no bundling). Type checking is
// `npm run typecheck`; bundling would break keytar (native), undici,
// and fastify, all of which are CommonJS-with-native-bindings under
// the hood. Plain transpile-preserving-imports matches how `tsx`
// resolves modules at runtime — same module graph, just .ts → .js.

import { build } from "esbuild";
import { readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");
const OUT = join(__dirname, "..", "dist");

function collectTsFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

try {
  rmSync(OUT, { recursive: true, force: true });
} catch {}
mkdirSync(OUT, { recursive: true });

const entryPoints = collectTsFiles(SRC);

await build({
  entryPoints,
  outdir: OUT,
  outbase: SRC,
  platform: "node",
  format: "esm",
  target: "es2022",
  // Do NOT bundle. NodeNext-style imports (./foo.js) resolve at runtime
  // against the matching dist/foo.js. Bundling would also need to mark
  // every native dep external; transpile-only avoids that whole class.
  bundle: false,
  // esbuild rewrites .ts extensions to .js automatically when format=esm.
  sourcemap: false,
  logLevel: "info",
});

console.log(`built ${entryPoints.length} files → ${relative(process.cwd(), OUT)}`);
