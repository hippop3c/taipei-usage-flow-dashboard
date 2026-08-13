import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const repositoryName = "taipei-usage-flow-dashboard";
const clientDir = join(process.cwd(), "dist", "client");
const pagesDir = join(process.cwd(), "dist", "pages");
if (!existsSync(clientDir)) throw new Error("dist/client is missing; run the Pages build first.");

rmSync(pagesDir, { force: true, recursive: true });
mkdirSync(pagesDir, { recursive: true });
cpSync(clientDir, pagesDir, { recursive: true });

const nestedNextDir = join(pagesDir, repositoryName, "_next");
if (existsSync(nestedNextDir)) {
  rmSync(join(pagesDir, "_next"), { force: true, recursive: true });
  cpSync(nestedNextDir, join(pagesDir, "_next"), { recursive: true });
  rmSync(join(pagesDir, repositoryName), { force: true, recursive: true });
}

for (const required of [
  "index.html",
  "subsidy-data.js",
  join("months", "2026-06", "usage.json"),
  join("_next", "static"),
]) {
  if (!existsSync(join(pagesDir, required))) {
    throw new Error(`GitHub Pages artifact is missing ${required}.`);
  }
}

const html = readFileSync(join(pagesDir, "index.html"), "utf8");
if (!html.includes(`/${repositoryName}/_next/`)) {
  throw new Error("Exported HTML does not use the GitHub Pages base path.");
}

console.log(`GitHub Pages artifact ready at ${pagesDir}`);
