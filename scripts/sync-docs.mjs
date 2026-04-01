import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const distDir = resolve(rootDir, "dist");
const docsDir = resolve(rootDir, "docs");

async function main() {
  await rm(docsDir, { force: true, recursive: true });
  await mkdir(docsDir, { recursive: true });
  await cp(distDir, docsDir, { recursive: true });
  await writeFile(resolve(docsDir, ".nojekyll"), "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
