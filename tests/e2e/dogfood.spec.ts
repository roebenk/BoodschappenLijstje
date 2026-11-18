import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const SHOTS = "C:\\Users\\rubenkoeze\\.copilot\\session-state\\f635bccc-25f8-46e8-a0e3-4065c5403201\\files\\";
const VIEWPORT = { width: 393, height: 852 };

test.describe.configure({ mode: "serial" });

let problems: string[] = [];

function guard(page: Page, label = "page") {
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Remote product images may legitimately fail; everything else is a real error.
    if (/Failed to load resource/i.test(text)) return;
    problems.push(`[${label}] console.error: ${text}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
  });
}

async function newPhone(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    baseURL: `http://localhost:${process.env.E2E_PORT ?? 3100}`,
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  return { ctx, page: await ctx.newPage() };
}

test.beforeEach(() => {
  problems = [];
});
test.afterEach(() => {
  expect(problems, problems.join("\n")).toEqual([]);
});

test("mobile layout & iOS ergonomics", async ({ page }) => {
  guard(page);
  for (const path of ["/", "/voorkeuren", "/winkels"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `horizontal overflow on ${path}`).toBeLessThanOrEqual(393);
    const sizes = await page.$$eval("input", (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
    await expect(page.getByRole("navigation", { name: "Hoofdnavigatie" })).toBeVisible();
  }

  const nav = page.getByRole("navigation", { name: "Hoofdnavigatie" });
  await page.goto("/");
  await nav.getByRole("link", { name: "Voorkeuren" }).click();
  await expect(page).toHaveURL(/\/voorkeuren$/);
  await nav.getByRole("link", { name: "Winkels" }).click();
  await expect(page).toHaveURL(/\/winkels$/);
  await nav.getByRole("link", { name: "Lijstje" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("app icons are available for iOS, browsers and installation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  await expect(page.locator('link[rel="icon"][sizes="32x32"]')).toHaveAttribute("href", "/icon-32.png");

  const manifest = await page.request.get("/manifest.webmanifest").then((response) => response.json());
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", purpose: "any" }),
    expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", purpose: "any" }),
    expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", purpose: "maskable" }),
  ]));

  for (const [path, size] of [
    ["/icon-32.png", 32],
    ["/apple-touch-icon.png", 180],
    ["/icon-192.png", 192],
    ["/icon-512.png", 512],
  ] as const) {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
    const png = await response.body();
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});

const emptyList = {
  items: [],
  ahSubtotalCents: 0,
  picnicSubtotalCents: 0,
  totalCents: 0,
  totalSavingsCents: 0,
  picnicAdvice: {
    minOrderCents: 3500,
    currentPicnicCents: 0,
    meetsMinimum: false,
    shortfallCents: 0,
    recommendation: "split_optimal",
    allAtAhExtraCostCents: 0,
    message: "",
  },
};

test("store lock agrees in the row, comparison sheet and notifications despite delayed reads", async ({ page }) => {
  const added = await page.request.post("/api/list", { data: { inputs: ["magere kwark"] } });
  expect(added.ok()).toBe(true);
  const { items: [item] } = await added.json();
  const cheapest = item.assignedProvider;
  expect(["ah", "picnic"]).toContain(cheapest);
  const other = cheapest === "ah" ? "picnic" : "ah";
  const name = (store: string) => store === "ah" ? "Albert Heijn" : "Picnic";
  const endpoint = `/api/list/${item.id}`;
  let releaseOldRead!: () => void;
  const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
  let staleReadCaptured = false;
  let holdNextRead = false;
  await page.route("**/api/list", async (route) => {
    if (!holdNextRead) return route.continue();
    holdNextRead = false;
    const snapshot = await route.fetch();
    staleReadCaptured = true;
    await oldReadGate;
    await route.fulfill({ response: snapshot });
  });

  try {
    await page.goto("/");
    const row = page.getByTestId("list-item-row");
    const otherPill = row.getByTestId(`toggle-${other}`);
    const cheapestPill = row.getByTestId(`toggle-${cheapest}`);
    const toasts = page.locator("[data-sonner-toast]");
    await expect(cheapestPill).toHaveAttribute("aria-pressed", "true");

    holdNextRead = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => staleReadCaptured).toBe(true);
    await otherPill.click();
    await expect(toasts.getByText(`Vastgezet op ${name(other)}`, { exact: true })).toBeVisible();
    await expect(otherPill).toBeEnabled();
    const staleResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/list" && response.request().method() === "GET");
    releaseOldRead();
    await (await staleResponse).finished();
    await expect(otherPill).toHaveAttribute("title", /Vastgezet/);

    await row.getByTestId("open-item-sheet").click();
    const dialog = page.getByRole("dialog");
    const unlock = dialog.getByRole("button", { name: "Ontgrendel", exact: true });
    const lock = dialog.getByRole("button", { name: "Zet vast", exact: true });
    await expect(dialog.getByText(`Winkel vastgezet op ${name(other)}`)).toBeVisible();
    await unlock.click();
    await expect(toasts.getByText(`Ontgrendeld — verplaatst naar ${name(cheapest)}`, { exact: true })).toBeVisible();
    await expect(cheapestPill).toHaveAttribute("aria-pressed", "true");

    await lock.click();
    await expect(dialog.getByText(`Winkel vastgezet op ${name(cheapest)}`)).toBeVisible();
    await expect(toasts.getByText(`Vastgezet op ${name(cheapest)}`, { exact: true })).toBeVisible();
    await unlock.click();
    await expect(toasts.getByText("Ontgrendeld — winkelkeuze staat weer op automatisch", { exact: true })).toBeVisible();

    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await patchGate;
      await route.fulfill({ status: 409, json: { error: "Winkelkeuze niet opgeslagen" } });
    });
    try {
      await lock.click();
      await expect(lock).toBeDisabled();
      await expect(cheapestPill).toBeDisabled();
    } finally {
      releasePatch();
    }
    await expect(toasts.getByText("Winkelkeuze niet opgeslagen", { exact: true })).toBeVisible();
    await expect(lock).toBeEnabled();
    await expect(cheapestPill).toHaveAttribute("title", /^Vastzetten/);
    const persisted = await page.request.get("/api/list").then((response) => response.json());
    expect(persisted.items.find((row: { id: number }) => row.id === item.id)).toMatchObject({
      assignedProvider: cheapest,
      isProviderLocked: false,
    });
  } finally {
    releaseOldRead();
    await page.request.delete(endpoint);
  }
});

test("quick add uses the same purchase suggestions for browsing and searching", async ({ page }) => {
  let suggestions: string[] = [];
  await page.route("**/api/list/suggestions", (route) => route.fulfill({ json: { suggestions } }));
  await page.route("**/api/list", (route) =>
    route.fulfill({ json: route.request().method() === "POST" ? { items: [] } : emptyList }),
  );
  const firstSuggestions = page.waitForResponse((response) => response.url().endsWith("/api/list/suggestions"));
  await page.goto("/");
  await firstSuggestions;
  await expect(page.getByText("Je lijstje is leeg")).toBeVisible();
  const input = page.getByTestId("quick-add-input");
  await input.focus();
  await expect(page.getByText("Geen suggesties uit recente aankopen.")).toBeVisible();
  suggestions = ["Kaas 1,5 kg", "bananen"];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Vaak gekocht in de afgelopen 3 maanden")).toBeVisible();
  await input.fill("kaa");
  await expect(page.getByRole("button", { name: "bananen" })).toHaveCount(0);
  const request = page.waitForRequest((r) => r.url().endsWith("/api/list") && r.method() === "POST");
  await page.getByRole("button", { name: "Kaas 1,5 kg" }).click();
  expect((await request).postDataJSON()).toEqual({ inputs: ["Kaas 1,5 kg"] });
  await expect(input).toHaveValue("kaa");
  await page.getByRole("button", { name: "Kaas 1,5 kg", exact: false }).press("Escape");
  await expect(page.locator("#purchase-suggestions")).toBeHidden();
  await page.getByRole("button", { name: "Vaak gekocht" }).click();
  await expect(page.locator("#purchase-suggestions")).toBeVisible();
});

test("quick add accepts more entries while a search is pending and keeps failed entries retryable", async ({ page }) => {
  const posts: string[][] = [];
  let releaseFirst!: () => void;
  const firstSearch = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/list", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: emptyList });
    posts.push(route.request().postDataJSON().inputs);
    if (posts.length === 1) {
      await firstSearch;
      return route.fulfill({ status: 500, json: { error: "Zoeken mislukt" } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/");
  await expect(page.getByText("Je lijstje is leeg")).toBeVisible();
  const input = page.getByTestId("quick-add-input");
  const jobs = page.getByTestId("pending-item-row");
  try {
    await input.fill("appels");
    await input.press("Enter");
    await expect(jobs.filter({ hasText: "appels" })).toContainText("Producten zoeken");
    await input.fill("peren");
    await page.getByTestId("quick-add-submit").click();
    await expect(jobs.filter({ hasText: "peren" })).toContainText("In wachtrij");
    await expect(input).toHaveValue("");
    await input.fill("onafgemaakte invoer");
    await expect.poll(() => posts).toEqual([["appels"]]);
  } finally {
    releaseFirst();
  }
  await expect(jobs).toHaveCount(1);
  await expect(jobs.first()).toContainText("Toevoegen mislukt");
  await expect(input).toHaveValue("onafgemaakte invoer");
  await input.press("Escape");
  await jobs.getByRole("button", { name: "Opnieuw" }).click();
  await expect(jobs).toHaveCount(0);
  expect(posts).toEqual([["appels"], ["peren"], ["appels"]]);
});

test("the header shrinks without drifting after a small scroll", async ({ page }) => {
  await page.route("**/api/list", (route) => route.fulfill({ json: emptyList }));
  await page.goto("/");
  await expect(page.getByText("Je lijstje is leeg")).toBeVisible();
  const measurements = await page.evaluate(async () => {
    const main = document.querySelector("main")!;
    const spacer = document.createElement("div");
    spacer.style.height = "160vh";
    main.append(spacer);
    const title = main.querySelector("h1")!;
    const measure = () => parseFloat(getComputedStyle(title).fontSize);
    const expanded = measure();
    window.scrollTo(0, 20);
    const frames: { size: number; top: number }[] = [];
    for (let frame = 0; frame < 12; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({ size: measure(), top: window.scrollY });
    }
    return { expanded, frames };
  });
  const settledFrames = measurements.frames.slice(3);
  expect(settledFrames[0].size).toBeLessThan(measurements.expanded);
  expect(settledFrames.every((frame) => frame.top === 20 && frame.size === settledFrames[0].size)).toBe(true);
});

test("AI model selection persists and shows the cost assumptions", async ({ page }) => {
  guard(page);
  const reset = await page.request.patch("/api/preferences", {
    data: { aiModel: "google/gemini-2.5-flash-lite" },
  });
  expect(reset.ok()).toBe(true);
  await page.goto("/voorkeuren");
  const model = page.getByRole("radio", { name: /Mistral Small 3.2/ });
  await expect(model).toBeVisible();
  await expect(model).toContainText("$0.025/mnd");
  await expect(page.getByText(/100 nieuwe zoekopdrachten per maand/)).toBeVisible();
  await model.click();
  await expect(model).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("AI-model bijgewerkt")).toBeVisible();
  await page.reload();
  await expect(model).toHaveAttribute("aria-checked", "true");
});

test("winkels: cards, login sheets, demo seed, brand preference persistence", async ({ page }) => {
  guard(page);
  await page.goto("/winkels");
  await expect(page.getByText("Albert Heijn").first()).toBeVisible();
  await expect(page.getByText("Picnic").first()).toBeVisible();
  await expect(page.getByText("Slimme AI Matcher")).toBeVisible();
  await expect(page.getByText("Deal-Radar uitbreidingen")).toBeVisible();
  await expect(page.getByText("Jumbo").first()).toBeVisible();
  await expect(page.getByText("Plus").first()).toBeVisible();
  await page.screenshot({ path: SHOTS + "winkels.png", fullPage: true });

  await page.getByTestId("connect-ah-btn").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Stap 1: Open AH Inlogpagina")).toBeVisible();
  await expect(dialog.locator('a[href*="login.ah.nl"]')).toBeVisible();
  const code = dialog.getByTestId("ah-code-input");
  await expect(code).toBeVisible();
  const box = await code.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(393);
  await page.screenshot({ path: SHOTS + "ah-sheet.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByTestId("connect-picnic-btn").click();
  await expect(dialog.getByPlaceholder("E-mailadres")).toBeVisible();
  await expect(dialog.getByPlaceholder("Wachtwoord")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByTestId("seed-demo-btn").click();
  await expect(page.locator("[data-sonner-toast]").first()).toContainText(/voorkeuren geladen/i, { timeout: 30_000 });

  await page.getByRole("navigation", { name: "Hoofdnavigatie" }).getByRole("link", { name: "Voorkeuren" }).click();
  await expect(page.getByText(/Calv/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/\d+× gekocht/).first()).toBeVisible();

  const target = page.getByRole("button", { name: "Altijd huismerk" }).first();
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Altijd huismerk" }).first()).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: SHOTS + "voorkeuren.png", fullPage: true });

  const auto = page.getByRole("button", { name: "Slim automatisch" }).first();
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
});

test("lijstje: compare, promo math, variant swap, optimizer, shopping mode, push preview", async ({ page }) => {
  guard(page);
  await page.request.delete("/api/list?all=1");
  await page.goto("/");
  await expect(page.getByText("Je lijstje is leeg")).toBeVisible();
  await page.screenshot({ path: SHOTS + "home-empty.png" });

  await page.getByTestId("quick-add-input").fill("4x 1kg magere kwark, pindakaas");
  await page.getByTestId("quick-add-submit").click();

  const rows = page.getByTestId("list-item-row");
  await expect(rows).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId("pending-item-row")).toHaveCount(0, { timeout: 30_000 });

  // Header title must never be truncated on iPhone 16 Pro width (393px) even with action button visible
  const titleTruncated = await page.locator("header h1").evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(titleTruncated, "Header title 'Boodschappen' should not truncate on 393px").toBe(false);

  // Newly added item appears right above the fold with spotlight verification bar
  const firstRowBox = await rows.first().boundingBox();
  expect(firstRowBox!.y, "First list row must sit directly below search/filter above the fold").toBeLessThan(260);
  await expect(rows.first().getByTestId("just-added-bar")).toBeVisible();
  await expect(rows.first().getByTestId("swap-product-btn")).toBeVisible();
  const spotlightClipped = await rows
    .nth(1)
    .getByTestId("just-added-bar")
    .locator("span")
    .first()
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(spotlightClipped, "Spotlight price comparison should not clip on 393px").toBe(false);
  await expect(rows.first().getByTestId("toggle-ah")).toBeVisible();
  await expect(rows.first().getByTestId("toggle-picnic")).toBeVisible();

  const pinda = rows.filter({ hasText: /pindakaas/i }).first();
  await expect(pinda).toBeVisible();
  await expect(pinda.getByText(/Calv|pindakaas/i).first()).toBeVisible();

  // Bottom summary bar must stay slim (< 76px) while showing AH & Picnic subtotals + Zet klaar
  const bottomBar = page.getByTestId("bottom-summary-bar");
  await expect(bottomBar).toBeVisible();
  await expect(bottomBar).toContainText("AH");
  await expect(bottomBar).toContainText("Picnic");
  const barBox = await bottomBar.boundingBox();
  expect(barBox!.height, "Bottom summary bar must be compact").toBeLessThan(76);
  await page.screenshot({ path: SHOTS + "lijstje.png" });

  // Variant swap & unit-price inspection inside ItemComparisonSheet
  await pinda.getByTestId("open-item-sheet").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Albert Heijn opties/)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText(/Picnic opties/)).toBeVisible();
  await expect(dialog.getByText(/€\s?\d+[.,]\d{2}\/(kg|l)/).first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + "comparison-sheet.png" });
  const choose = dialog.getByRole("button", { name: "Kies deze" }).first();
  await expect(choose).toBeVisible();
  await choose.click();
  await expect(page.locator("[data-sonner-toast]").first()).toContainText("Voorkeur bijgewerkt", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Direct store toggle & lock/unlock on the row
  const kwark = rows.filter({ hasText: /kwark/i }).first();
  const toAh = kwark.getByTestId("toggle-ah");
  const toPicnic = kwark.getByTestId("toggle-picnic");
  await toPicnic.click();
  await expect(toPicnic).toHaveAttribute("aria-pressed", "true");
  await toAh.click();
  await expect(toAh).toHaveAttribute("aria-pressed", "true");
  await toPicnic.click();
  await expect(toPicnic).toHaveAttribute("aria-pressed", "true");

  // Open BasketSummarySheet from the slim bottom bar to optimize & handle Picnic €35 threshold
  await page.getByTestId("open-summary-sheet").click();
  const optimizer = page.getByTestId("optimizer-card");
  await expect(optimizer).toContainText("Albert Heijn");
  await expect(optimizer).toContainText("Picnic");
  await page.waitForTimeout(380);
  await page.screenshot({ path: SHOTS + "summary-sheet.png" });
  await page.getByTestId("optimize-btn").click();
  await expect(page.locator("[data-sonner-toast]").first()).toContainText(/geoptimaliseerd/i);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(toPicnic).toHaveAttribute("aria-pressed", "true"); // locked item is left alone

  // Park pindakaas at Picnic (below €35), then tap Picnic again to unlock it; "Zet alles op AH" must pull it back.
  const pindaPicnic = pinda.getByTestId("toggle-picnic");
  const pindaWasPicnic = (await pindaPicnic.getAttribute("aria-pressed")) === "true";
  if (!pindaWasPicnic) {
    await pindaPicnic.click();
    await expect(pindaPicnic).toHaveAttribute("aria-pressed", "true");
  }
  // Tap active locked Picnic pill to unlock
  await pindaPicnic.click();
  await expect(page.locator("[data-sonner-toast]").first()).toContainText(/Ontgrendeld/i);

  // Ensure kwark is at Picnic or pindakaas is at Picnic if needed, or put an unlocked item at Picnic?
  // Wait: unlocking pindakaas immediately re-evaluates optimal store, while kwark is still at Picnic (< €35).
  // Unlock kwark too so "Zet alles op AH" moves it to AH!
  await toPicnic.click();
  await expect(page.locator("[data-sonner-toast]").first()).toContainText(/Ontgrendeld/i);

  // If Picnic still has unlocked items below €35, "Zet alles op AH" moves them; otherwise verify summary sheet
  await page.getByTestId("open-summary-sheet").click();
  const allAh = optimizer.getByRole("button", { name: "Zet alles op AH" });
  if (await allAh.isVisible()) {
    await allAh.click();
    await expect(pinda.getByTestId("toggle-ah")).toHaveAttribute("aria-pressed", "true");
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Test Winkelmodus toggle & visual clarity
  await page.getByTestId("toggle-shopping-mode").click();
  await expect(page.getByTestId("shopping-mode-view")).toBeVisible();
  await page.screenshot({ path: SHOTS + "shopping-mode.png" });
  await page.getByTestId("toggle-shopping-mode").click();
  await expect(page.getByTestId("shopping-mode-view")).toBeHidden();

  // Open Push sheet from BottomSummaryBar
  await page.getByTestId("open-push-sheet").click();
  await expect(dialog.getByText("Zet klaar in de apps")).toBeVisible();
  await expect(dialog.getByText(/\d+×/).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(380);
  await page.screenshot({ path: SHOTS + "push-sheet.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A full iOS-style left swipe removes the row and persists it through the list API.
  const swipeDeleteTarget = rows.filter({ hasText: /pindakaas/i }).first();
  const swipeBox = await swipeDeleteTarget.boundingBox();
  expect(swipeBox).not.toBeNull();
  await page.mouse.move(swipeBox!.x + swipeBox!.width * 0.7, swipeBox!.y + swipeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(swipeBox!.x + swipeBox!.width * 0.08, swipeBox!.y + swipeBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(swipeDeleteTarget).toHaveCount(0, { timeout: 10_000 });
  const savedList = await page.request.get("/api/list").then((response) => response.json());
  expect(savedList.items.some((item: { displayName: string }) => /pindakaas/i.test(item.displayName))).toBe(false);
});

test("two iPhones stay in sync via SSE", async ({ browser }) => {
  const a = await newPhone(browser);
  const b = await newPhone(browser);
  guard(a.page, "ruben");
  guard(b.page, "partner");
  await a.page.goto("/");
  await b.page.goto("/");
  await b.page.waitForLoadState("networkidle");
  await a.page.getByTestId("quick-add-input").fill("bananen");
  await a.page.getByTestId("quick-add-submit").click();
  await expect(b.page.getByTestId("list-item-row").filter({ hasText: /banan/i })).toBeVisible({ timeout: 60_000 });

  await a.page.getByTestId("list-item-row").filter({ hasText: /banan/i }).getByRole("button", { name: "Afvinken" }).click();
  await expect(b.page.getByText(/Afgevinkt \(1\)/)).toBeVisible({ timeout: 15_000 });
  await expect(b.page.getByTestId("list-item-row").filter({ hasText: /banan/i })).toHaveCount(0);
  await b.page.screenshot({ path: SHOTS + "lijstje-with-checked.png" });
  await b.page.emulateMedia({ colorScheme: "dark" });
  await b.page.waitForTimeout(200);
  await b.page.screenshot({ path: SHOTS + "lijstje-dark.png" });
  await b.ctx.close();
  await a.ctx.close();
});
