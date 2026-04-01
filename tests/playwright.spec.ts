import { expect, test } from "@playwright/test";

test("captures required Fidenza screenshots", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /repo-local collection decks/i })).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-root.png",
  });

  await page.getByRole("button", { name: /open workbench/i }).click();
  await expect(page.getByRole("heading", { name: /fidenza valuation workbench/i })).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-token-239.png",
  });

  await page.getByRole("button", { name: "Neighborhood" }).click();
  await page.getByRole("button", { name: "Rarity" }).click();
  await expect(page.getByText(/neighborhoods are computed locally/i)).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-neighborhood.png",
  });
});
