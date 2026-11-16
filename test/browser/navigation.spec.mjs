import { test, expect } from "@playwright/test"

const parentEntry = (page) => page.locator('#nav > button[data-plugin-page]')
const submenu = (page) => page.locator('.nav-sub:not(.leaving)[data-view="egress-preview"]')
const entry = (page, id) => submenu(page).locator(`[data-page-navigation-id="${id}"]`)
async function openHost(page, path = "/host-preview.html") {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${path}?scenario=providers`)
  await expect(page.locator("iframe.plugin-frame")).toBeVisible()
  const frame = page.frameLocator("iframe.plugin-frame")
  await expect(frame.locator(".account-row").first()).toBeVisible()
  return frame
}
const liveFrame = (page) => page.frames().find((frame) => frame.url().includes("/host-frame/"))
async function loadPluginDocument(page, navigate) {
  // A reload/recreated iframe starts a new document before its bridge is ready.
  // Keep that lifecycle wait separate from assertions about the rendered UI.
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url().includes("/host-frame/") })
  await navigate()
  const frame = await navigated
  await frame.waitForLoadState("load")
  await frame.evaluate(() => magpie.ready)
}

test("native sidebar and plugin navigation stay in sync inside the real sandbox", async ({ page }) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message))
  const frame = await openHost(page)
  await expect(page.locator("iframe.plugin-frame")).toHaveAttribute("sandbox", "allow-scripts")
  expect(await liveFrame(page).evaluate(() => { try { localStorage.getItem("test"); return false } catch { return true } })).toBe(true)
  await expect(submenu(page).getByRole("tab")).toHaveCount(21)
  await expect(frame.locator("#provider-sidebar")).toBeHidden()
  await entry(page, "provider:demo-provider-16").click()
  await expect(frame.locator(".provider-group")).toHaveCount(1)
  await expect(frame.locator(".provider-group")).toHaveAttribute("data-provider", "demo-provider-16")
  await expect(frame.locator("#breadcrumb-current")).toHaveText("示例供应商 16")
  await expect(entry(page, "provider:demo-provider-16")).toBeFocused()
  await frame.getByLabel("筛选供应商").selectOption("atlas")
  await expect(entry(page, "provider:atlas")).toHaveAttribute("aria-selected", "true")
  await entry(page, "sources").click()
  await expect(frame.getByRole("tab", { name: /^节点来源/ })).toHaveAttribute("aria-selected", "true")
  await frame.getByRole("tab", { name: /^自动领取/ }).click()
  await expect(entry(page, "claims")).toHaveAttribute("aria-selected", "true")
  expect(errors).toEqual([])
  expect(await page.evaluate(() => window.__hostPreview.errors)).toEqual([])
})

test("the native parent folds, expands and supports keyboard selection without losing focus", async ({ page }) => {
  const frame = await openHost(page), top = parentEntry(page)
  await expect(top).toHaveAttribute("aria-expanded", "true")
  await top.click()
  await expect(top).toHaveAttribute("aria-expanded", "false")
  await expect(submenu(page)).toHaveCount(0)
  await frame.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(top).toHaveAttribute("aria-expanded", "false")
  await top.focus(); await top.press("ArrowRight")
  await expect(submenu(page)).toBeVisible()
  await top.press("ArrowRight")
  await expect(entry(page, "egress")).toBeFocused()
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter")
  await expect(entry(page, "sources")).toHaveAttribute("aria-selected", "true")
  await expect(entry(page, "sources")).toBeFocused()
  await page.keyboard.press("End")
  await expect(entry(page, "provider:demo-provider-16")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(frame.locator("#breadcrumb-current")).toHaveText("示例供应商 16")
  await expect(entry(page, "provider:demo-provider-16")).toBeFocused()
  await top.focus(); await top.press("ArrowLeft")
  await expect(submenu(page)).toHaveCount(0)
  await top.press("Enter")
  await expect(entry(page, "provider:demo-provider-16")).toHaveAttribute("aria-selected", "true")
})

test("native pages and provider context actions restore the same plugin frame", async ({ page }) => {
  const frame = await openHost(page)
  await entry(page, "provider:atlas").click()
  await frame.getByRole("button", { name: "多列视图", exact: true }).click()
  await liveFrame(page).evaluate(() => { window.__frameKept = "same-frame" })
  await page.locator('#nav > button[data-view="usage"]').click()
  await expect(submenu(page)).toHaveCount(0)
  await expect(page.locator('.nav-sub:not(.leaving)[data-view="usage"]')).toBeVisible()
  await parentEntry(page).click()
  await expect(entry(page, "provider:atlas")).toHaveAttribute("aria-selected", "true")
  await expect(frame.locator(".account-card")).toHaveCount(4)
  expect(await liveFrame(page).evaluate(() => window.__frameKept)).toBe("same-frame")
  await page.evaluate(() => magpie.actions("provider", { provider: { id: "zcode", name: "ZCode" } })[0].run())
  await expect(entry(page, "provider:zcode")).toHaveAttribute("aria-selected", "true")
  await expect(frame.locator(".account-card")).toHaveCount(8)
})

test("loading directly into top navigation waits for the reader to open its dropdown", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/host-preview.html?scenario=normal&nav=top")
  const frame = page.frameLocator("iframe.plugin-frame"), top = parentEntry(page), menu = page.locator(".egress-navigation-menu")
  await expect(frame.locator(".account-row")).toHaveCount(12)
  await expect(top).toHaveAttribute("aria-haspopup", "menu")
  await expect(top).toHaveAttribute("aria-expanded", "false")
  await expect(menu).toHaveCount(0)
  await top.click()
  await expect(menu.getByRole("menuitemradio")).toHaveCount(5)
  await menu.locator('[data-page-navigation-id="sources"]').click()
  await expect(frame.getByRole("tab", { name: /^节点来源/ })).toHaveAttribute("aria-selected", "true")
  await expect(menu).toHaveCount(0)
})

test("switching the host to top navigation keeps a working dropdown and keyboard access", async ({ page }) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message))
  const frame = await openHost(page)
  await entry(page, "provider:atlas").click()
  await page.evaluate(() => { document.body.classList.remove("side-nav"); navSubs() })
  const top = parentEntry(page), menu = page.locator(".egress-navigation-menu")
  await expect(submenu(page)).toHaveCount(0)
  await expect(top).toHaveAttribute("aria-haspopup", "menu")
  await top.click()
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("menuitemradio")).toHaveCount(21)
  await menu.locator('[data-page-navigation-id="provider:demo-provider-16"]').click()
  await expect(frame.locator("#breadcrumb-current")).toHaveText("示例供应商 16")
  await expect(menu).toHaveCount(0)
  await expect(top).toBeFocused()
  await top.press("ArrowDown")
  await expect(menu.locator('[data-page-navigation-id="provider:demo-provider-16"]')).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(top).toBeFocused()
  await page.evaluate(() => { document.body.classList.add("side-nav"); navSubs() })
  await expect(entry(page, "provider:demo-provider-16")).toHaveAttribute("aria-selected", "true")
  expect(errors).toEqual([])
})

test("a narrow unpatched host retains an expandable provider menu instead of hiding both controls", async ({ page }) => {
  const frame = await openHost(page, "/host-stock.html")
  await page.setViewportSize({ width: 1280, height: 900 })
  const toggle = frame.locator("#provider-nav-toggle"), providers = frame.locator("#provider-sidebar")
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(providers).toBeVisible()
  await providers.getByRole("button", { name: "切换到 示例供应商 16", exact: true }).click()
  await expect(frame.locator("#breadcrumb-current")).toHaveText("示例供应商 16")
  await expect(providers).toBeHidden()
  await expect(toggle).toBeFocused()
  await toggle.press("ArrowDown")
  await expect(providers.getByRole("button", { name: "切换到 示例供应商 16", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(providers).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(providers).toBeVisible()
})

test("display choice survives a sandbox reload through host options without submitting work", async ({ page }) => {
  const frame = await openHost(page)
  await frame.getByRole("button", { name: "多列视图", exact: true }).click()
  await expect.poll(() => page.evaluate(() => demoOptions.pagePreferences?.density)).toBe("grid")
  await loadPluginDocument(page, () => liveFrame(page).evaluate(() => location.reload()))
  await expect(frame.getByRole("button", { name: "多列视图", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(frame.locator(".account-card").first()).toBeVisible()
  expect(await page.evaluate(() => window.__hostPreview.requests.filter((request) => request.action !== "page-seen"))).toEqual([])
})

test("sidebar counts and labels update safely, and disabling the plugin removes its navigation", async ({ page }) => {
  const frame = await openHost(page)
  const title = 'Atlas · <img src=x onerror=alert(1)>'
  await liveFrame(page).evaluate((title) => {
    const provider = window.__ZE__.snapshot.providers.find((item) => item.id === "atlas")
    provider.name = title; provider.accounts.pop()
  }, title)
  await frame.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(entry(page, "provider:atlas").locator("span")).toHaveText(title)
  await expect(entry(page, "provider:atlas").locator("em")).toHaveText("3")
  await expect(submenu(page).locator("img")).toHaveCount(0)
  await page.evaluate(async () => { window.__hostPreview.enabled = false; await loadPluginPages() })
  await expect(parentEntry(page)).toHaveCount(0)
  await expect(submenu(page)).toHaveCount(0)
  expect(await page.evaluate(() => Object.hasOwn(NAV_SUBS, "egress-preview"))).toBe(false)
  await page.evaluate(async () => { window.__hostPreview.enabled = true; await loadPluginPages() })
  await loadPluginDocument(page, () => parentEntry(page).click())
  await expect(submenu(page).getByRole("tab")).toHaveCount(21)
})

test("the navigation bridge rejects invalid items and messages from outside its page", async ({ page }) => {
  await openHost(page)
  await expect(submenu(page).getByRole("tab")).toHaveCount(21)
  const before = await submenu(page).innerText()
  for (const params of [
    { active: "x", items: [{ id: "x", title: "" }] },
    { active: "x", items: [{ id: "x", title: "X", count: -1 }] },
    { active: "x", items: [{ id: "x", title: "X" }, { id: "x", title: "Duplicate" }] },
    { active: "missing", items: [{ id: "x", title: "X" }] },
    { active: "x", items: Array.from({ length: 257 }, (_, i) => ({ id: String(i), title: "X" })) },
  ]) {
    const response = await liveFrame(page).evaluate((params) => new Promise((resolve) => {
      const id = "invalid-nav:" + Math.random()
      const listener = (event) => {
        if (event.source !== parent || event.data?.id !== id) return
        removeEventListener("message", listener); resolve(event.data)
      }
      addEventListener("message", listener)
      parent.postMessage({ magpie: 1, method: "navigation.set", id, params }, "*")
    }), params)
    expect(response.error).toBeTruthy()
  }
  await page.evaluate(() => window.postMessage({ magpie: 1, method: "navigation.set", id: "forged", params: { active: "fake", items: [{ id: "fake", title: "Fake item" }] } }, "*"))
  await page.waitForTimeout(50)
  await expect(submenu(page)).toHaveText(before, { useInnerText: true })
})

test("an unpatched host keeps working with the in-page dropdown and multi-column display", async ({ page }) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message))
  const frame = await openHost(page, "/host-stock.html")
  await expect(submenu(page)).toHaveCount(0)
  await expect(frame.locator("#provider-sidebar")).toBeVisible()
  await frame.getByLabel("筛选供应商").selectOption("atlas")
  await frame.getByRole("button", { name: "多列视图", exact: true }).click()
  await expect(frame.locator(".account-card")).toHaveCount(4)
  await expect.poll(() => page.evaluate(() => demoOptions.pagePreferences?.density)).toBe("grid")
  await loadPluginDocument(page, () => liveFrame(page).evaluate(() => location.reload()))
  await expect(frame.locator("body")).toHaveAttribute("data-density", "grid", { timeout: 10_000 })
  expect(await liveFrame(page).evaluate(() => EgressNavigation.connected)).toBe(false)
  expect(errors).toEqual([])
})
