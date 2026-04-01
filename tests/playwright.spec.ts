import { expect, test } from "@playwright/test";

test("captures required Fidenza screenshots", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /evidence-first collection decks/i }),
  ).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-root.png",
  });

  await page.getByRole("button", { name: /open workbench/i }).click();
  await expect(page.getByRole("heading", { name: /^fidenza$/i })).toBeVisible();
  await expect(page.getByText(/sales \d+/i)).toBeVisible();
  await expect(page.getByText(/asks \d+/i)).toBeVisible();
  await expect(page.getByText(/bids \d+/i)).toBeVisible();
  await expect(page.getByText(/price axis in Ξ/i)).toBeVisible();
  await expect(page.getByText(/token spotlight/i)).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-token-239.png",
  });

  await page.getByRole("button", { name: "Neighborhood" }).click();
  await expect(page.getByText(/neighborhoods are computed locally/i)).toBeVisible();
  await expect(
    page.getByRole("img", { name: /neighborhood similarity map for fidenza #239/i }),
  ).toBeVisible();
  await expect(page.getByText(/click plotted neighbors to inspect/i)).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/playwright/fidenza-neighborhood.png",
  });
});
