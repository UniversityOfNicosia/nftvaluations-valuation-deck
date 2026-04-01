import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const outputDir = new URL("../artifacts/playwright/", import.meta.url);

async function run() {
  await mkdir(outputDir, { recursive: true });

  const server = await preview({
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: false,
    },
  });

  const origin = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:4173/";

  const browser = await chromium.launch({ headless: true });
  const viewport = { width: 1600, height: 1200 };

  try {
    const page = await browser.newPage({ viewport });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.screenshot({
      fullPage: true,
      path: new URL("fidenza-root.png", outputDir).pathname,
    });
    await page.close();

    const tokenPage = await browser.newPage({ viewport });
    await tokenPage.goto(`${origin}#/collections/fidenza-by-tyler-hobbs?token=239`, {
      waitUntil: "networkidle",
    });
    await tokenPage
      .getByRole("heading", { name: /fidenza valuation workbench/i })
      .waitFor();
    await tokenPage.screenshot({
      fullPage: true,
      path: new URL("fidenza-token-239.png", outputDir).pathname,
    });
    await tokenPage.close();

    const neighborhoodPage = await browser.newPage({ viewport });
    await neighborhoodPage.goto(
      `${origin}#/collections/fidenza-by-tyler-hobbs?token=239&panel=neighborhood&mode=trait`,
      { waitUntil: "networkidle" },
    );
    await neighborhoodPage.getByText(/neighborhoods are computed locally/i).waitFor();
    await neighborhoodPage.screenshot({
      fullPage: true,
      path: new URL("fidenza-neighborhood.png", outputDir).pathname,
    });
    await neighborhoodPage.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
