// Mirrors the Dockerfile runner stage: standalone output needs public/ and .next/static copied in.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("Missing .next/standalone/server.js - run `next build` first.");
  process.exit(1);
}

const copies = [
  [join(root, "public"), join(standalone, "public")],
  [join(root, ".next", "static"), join(standalone, ".next", "static")],
];
for (const [src, dest] of copies) {
  if (!existsSync(src)) continue;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
console.log("Standalone bundle ready: .next/standalone/server.js");
