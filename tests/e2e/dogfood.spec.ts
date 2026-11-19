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

test("store mode is controlled in the picker while row switching preserves it despite delayed reads", async ({ page }) => {
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
    await expect(toasts.getByText(`Verplaatst naar ${name(other)}`, { exact: true })).toBeVisible();
    await expect(otherPill).toBeEnabled();
    const staleResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/list" && response.request().method() === "GET");
    releaseOldRead();
    await (await staleResponse).finished();
    await expect(otherPill).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator("svg.lucide-lock")).toHaveCount(0);
    const patches: unknown[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === endpoint && request.method() === "PATCH") {
        patches.push(request.postDataJSON());
      }
    });
    await otherPill.click();
    expect(patches).toEqual([]);

    await row.getByTestId("open-item-sheet").click();
    const dialog = page.getByRole("dialog");
    const modes = dialog.getByRole("group", { name: "Winkelkeuze" });
    const auto = modes.getByRole("button", { name: "Auto", exact: true });
    const lockOther = modes.getByRole("button", { name: name(other), exact: true });
    const lockCheapest = modes.getByRole("button", { name: name(cheapest), exact: true });
    await expect(auto).toHaveAttribute("aria-pressed", "true");
    await lockOther.click();
    await expect(lockOther).toHaveAttribute("aria-pressed", "true");
    await expect(toasts.getByText(`Vastgezet op ${name(other)}`, { exact: true })).toBeVisible();
    await expect(lockOther).toBeEnabled();
    const beforeReselect = patches.length;
    await lockOther.click();
    expect(patches).toHaveLength(beforeReselect);
    await auto.click();
    await expect(toasts.getByText(`Ontgrendeld — verplaatst naar ${name(cheapest)}`, { exact: true })).toBeVisible();
    await expect(cheapestPill).toHaveAttribute("aria-pressed", "true");

    await lockCheapest.click();
    await expect(lockCheapest).toHaveAttribute("aria-pressed", "true");
    await expect(toasts.getByText(`Vastgezet op ${name(cheapest)}`, { exact: true })).toBeVisible();
    await expect(lockCheapest).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await otherPill.click();
    await expect(otherPill).toHaveAttribute("aria-pressed", "true");
    const switched = await page.request.get(endpoint).then((response) => response.json());
    expect(switched.item).toMatchObject({ assignedProvider: other, isProviderLocked: true });
    await expect(otherPill).toBeEnabled();
    await cheapestPill.click();
    await expect(cheapestPill).toHaveAttribute("aria-pressed", "true");
    await row.getByTestId("open-item-sheet").click();
    await expect(lockCheapest).toHaveAttribute("aria-pressed", "true");
    await expect(lockCheapest).toBeEnabled();
    await auto.click();
    await expect(toasts.getByText("Ontgrendeld — winkelkeuze staat weer op automatisch", { exact: true })).toBeVisible();

    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await patchGate;
      await route.fulfill({ status: 409, json: { error: "Winkelkeuze niet opgeslagen" } });
    });
    try {
      await lockCheapest.click();
      await expect(lockCheapest).toBeDisabled();
      await expect(cheapestPill).toBeDisabled();
    } finally {
      releasePatch();
    }
    await expect(toasts.getByText("Winkelkeuze niet opgeslagen", { exact: true })).toBeVisible();
    await expect(lockCheapest).toBeEnabled();
    await expect(auto).toHaveAttribute("aria-pressed", "true");
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

test("manual product search selects a Picnic result and can retain an unresolved row", async ({ page }) => {
  guard(page);
  const product = {
    id: "picnic:manual-berries", provider: "picnic", externalId: "manual-berries",
    title: "Blauwe bessen bakje", brand: "Picnic", isHouseBrand: true,
    unitSizeRaw: "150 g", baseAmount: 150, baseUnit: "g", regularPriceCents: 299,
    currentPriceCents: 299, promo: null, isOnlineOnlyPromo: false, imageUrl: null, available: true,
  };
  let item = {
    id: 987654, rawInput: "blauwe bessen", displayName: "Blauwe bessen", requestedQty: 1,
    requestedUnitRaw: null, targetBaseAmount: null, targetBaseUnit: null, conceptId: null,
    allowOvershoot: false, assignedProvider: null as string | null, isProviderLocked: false,
    ahProductId: null, ahQty: 0, ahTotalCents: null, ahProduct: null,
    picnicProductId: null as string | null, picnicQty: 0, picnicTotalCents: null as number | null,
    picnicProduct: null as typeof product | null, radarDeals: [], isChecked: false, pushedToStoreAt: null,
    sortOrder: 0, updatedAt: new Date().toISOString(),
  };
  const candidate = {
    product, packsNeeded: 1, effectiveTotalCents: 299, regularTotalCents: 299,
    effectiveUnitPriceEuros: 19.93, displayUnit: "kg", savingsCents: 0, timesBought: 0,
  };
  const evaluation = { winner: null, alternatives: [], otherResults: [], houseBrandChallenger: null };
  await page.route("**/api/list", (route) => route.fulfill({ json: { ...emptyList, items: [item] } }));
  await page.route(`**/api/list/${item.id}`, (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      item = {
        ...item,
        assignedProvider: patch.keepUnmatched ? null : "picnic",
        picnicProductId: patch.keepUnmatched ? null : product.id,
        picnicProduct: patch.keepUnmatched ? null : product,
        picnicQty: patch.keepUnmatched ? 0 : 1,
        picnicTotalCents: patch.keepUnmatched ? null : 299,
      };
      return route.fulfill({ json: { item } });
    }
    return route.fulfill({ json: {
      item, parsed: { searchQuery: "blauwe bessen", totalTargetAmount: null },
      ah: evaluation, picnic: evaluation, recommendedProvider: "ah",
    } });
  });
  await page.route(`**/api/list/${item.id}/search?**`, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("provider")).toBe("picnic");
    expect(url.searchParams.get("query")).toBe("blauwe bes");
    return route.fulfill({ json: { source: "live", candidates: [candidate] } });
  });
  await page.goto("/");
  await page.getByTestId("open-item-sheet").click();
  await page.getByRole("tab", { name: /Picnic opties/ }).click();
  await page.getByRole("button", { name: /Niet het juiste product/ }).click();
  await page.getByRole("textbox", { name: "Zelf zoeken naar product" }).fill("blauwe bes");
  await page.getByRole("button", { name: "Zoek", exact: true }).click();
  await expect(page.getByText("Winkelresultaten zonder relevantiefilter")).toBeVisible();
  await page.getByRole("button", { name: "Kies deze", exact: true }).click();
  await expect(page.getByText("Gekozen", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bewaar zonder product", exact: true }).click();
  await expect(page.getByText("Bewaard: nog product kiezen", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("list-item-row")).toContainText("Nog product kiezen");
  expect(item.picnicProductId).toBeNull();
  expect(item.assignedProvider).toBeNull();
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
    data: { aiModel: "google/gemini-2.5-flash-lite", aiFallbackModel: "openai/gpt-4.1-mini" },
  });
  expect(reset.ok()).toBe(true);
  await page.goto("/voorkeuren");
  await expect(page.getByRole("radiogroup", { name: "AI-model" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Hoofdnavigatie" }).getByRole("link", { name: "Winkels" }).click();
  const matcher = page.getByRole("button", { name: /Slimme AI Matcher/ });
  await expect(matcher).toBeEnabled();
  await matcher.click();
  const dialog = page.getByRole("dialog", { name: "Slimme AI Matcher" });
  const model = dialog.getByRole("radiogroup", { name: "AI-model", exact: true }).getByRole("radio", { name: /Mistral Small 3.2/ });
  await expect(model).toBeVisible();
  await expect(model).toContainText("$0.025/mnd");
  await expect(dialog.getByText(/100 nieuwe zoekopdrachten per maand/)).toBeVisible();
  await model.click();
  await expect(model).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("AI-model bijgewerkt")).toBeVisible();
  const backups = dialog.getByRole("group", { name: "Reservemodel bij fouten", exact: true });
  const backup = backups.getByRole("radio", { name: "GPT-4.1 Nano", exact: true });
  const noBackup = backups.getByRole("radio", { name: "Geen reservemodel", exact: true });
  await expect(backups.getByRole("radio", { name: "GPT-4.1 Mini", exact: true })).toBeChecked();
  await backups.getByText("GPT-4.1 Nano", { exact: true }).click();
  await expect(page.getByText("Reservemodel bijgewerkt", { exact: true })).toBeVisible();
  await expect(backup).toBeChecked();
  await expect(backup).toBeEnabled();
  await backup.focus();
  await page.keyboard.press("ArrowDown");
  const miniBackup = backups.getByRole("radio", { name: "GPT-4.1 Mini", exact: true });
  await expect(miniBackup).toBeChecked();
  await expect(miniBackup).toBeEnabled();
  await miniBackup.focus();
  await page.keyboard.press("ArrowUp");
  await expect(backup).toBeChecked();
  await expect(backup).toBeEnabled();
  await dialog.getByRole("button", { name: "Gereed", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(matcher).toContainText("mistralai/mistral-small-3.2-24b-instruct");
  await page.reload();
  await expect(matcher).toContainText("mistralai/mistral-small-3.2-24b-instruct");
  await matcher.click();
  await expect(model).toHaveAttribute("aria-checked", "true");
  await expect(backup).toBeChecked();
  await backups.getByText("Geen reservemodel", { exact: true }).click();
  await expect(page.getByText("Reservemodel bijgewerkt", { exact: true })).toBeVisible();
  await page.reload();
  await matcher.click();
  await expect(noBackup).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("winkels: connected store actions share a row equally without demo controls", async ({ page }) => {
  guard(page);
  await page.route("**/api/stores", (route) =>
    route.fulfill({
      json: {
        stores: ["ah", "picnic"].map((provider) => ({
          provider,
          auth: { status: "authenticated", lastSyncedAt: null },
        })),
      },
    }),
  );
  await page.goto("/winkels");
  await expect(page.getByRole("button", { name: "Ontkoppel", exact: true })).toHaveCount(2);
  await expect(page.getByTestId("seed-demo-btn")).toHaveCount(0);
  await expect(page.getByText("Test- & demodata", { exact: true })).toHaveCount(0);

  for (const width of [320, 393, 768]) {
    await page.setViewportSize({ width, height: 852 });
    for (const name of ["Synchroniseer kassabonnen", "Synchroniseer bezorgingen"]) {
      const sync = page.getByRole("button", { name, exact: true });
      const disconnect = sync.locator("..").getByRole("button", { name: "Ontkoppel", exact: true });
      const syncBox = await sync.boundingBox();
      const disconnectBox = await disconnect.boundingBox();
      expect(syncBox).not.toBeNull();
      expect(disconnectBox).not.toBeNull();
      expect(syncBox!.y).toBe(disconnectBox!.y);
      expect(Math.abs(syncBox!.width - disconnectBox!.width)).toBeLessThan(1);
      expect(syncBox!.x + syncBox!.width).toBeLessThanOrEqual(disconnectBox!.x);
      expect(disconnectBox!.x + disconnectBox!.width).toBeLessThanOrEqual(width);
    }
  }
});

test("winkels: cards, login sheets, brand preference persistence", async ({ page }) => {
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

  const seed = await page.request.post("/api/stores/demo-seed");
  expect(seed.ok()).toBe(true);

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

  // Direct store switching leaves the mode unchanged.
  const kwark = rows.filter({ hasText: /kwark/i }).first();
  const toAh = kwark.getByTestId("toggle-ah");
  const toPicnic = kwark.getByTestId("toggle-picnic");
  await toPicnic.click();
  await expect(toPicnic).toHaveAttribute("aria-pressed", "true");
  await toAh.click();
  await expect(toAh).toHaveAttribute("aria-pressed", "true");
  await toPicnic.click();
  await expect(toPicnic).toHaveAttribute("aria-pressed", "true");
  await kwark.getByTestId("open-item-sheet").click();
  await dialog.getByRole("group", { name: "Winkelkeuze" }).getByRole("button", { name: "Picnic", exact: true }).click();
  await expect(dialog.getByText("Vastgezet op Picnic, ook bij optimaliseren.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

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

  // Unlock only through the product picker; "Zet alles op AH" can then move both items.
  const pindaPicnic = pinda.getByTestId("toggle-picnic");
  const pindaWasPicnic = (await pindaPicnic.getAttribute("aria-pressed")) === "true";
  if (!pindaWasPicnic) {
    await pindaPicnic.click();
    await expect(pindaPicnic).toHaveAttribute("aria-pressed", "true");
  }
  for (const itemRow of [pinda, kwark]) {
    await itemRow.getByTestId("open-item-sheet").click();
    const auto = dialog.getByRole("group", { name: "Winkelkeuze" }).getByRole("button", { name: "Auto", exact: true });
    await auto.click();
    await expect(auto).toHaveAttribute("aria-pressed", "true");
    await expect(auto).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

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
