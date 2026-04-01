import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const docsIndexPath = resolve(docsDir, "index.html");
  const normalizedIndex = (await readFile(docsIndexPath, "utf8")).replace(/\r\n?/g, "\n");
  await writeFile(docsIndexPath, normalizedIndex);
  await writeFile(resolve(docsDir, ".nojekyll"), "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
