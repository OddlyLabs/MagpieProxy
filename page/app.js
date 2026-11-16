// No build step or network access required in the magpie page sandbox.
const $ = (id) => document.getElementById(id)
const { pad, beijing, when, age, accountState, needsAttention, matchesAccount, totals, proxyAddress, exitsOf, STRATEGY_LABELS, subscriptionsOf, hostOf, regionOf, nodeTestState, sortNodes, snapshotKey, navigationModel } = EgressUI
function el(tag, cls = "", text = "") {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== "" && text != null) node.textContent = text
  return node
}
function btn(cls, label, onClick, title = "") {
  const node = el("button", cls, label)
  node.type = "button"
  if (onClick) node.onclick = onClick
  if (title) node.title = title
  return node
}
const icon = (name, size = 16) => EgressIcons.create(name, size)
function iconButton(name, label, onClick, cls = "button quiet icon-button") {
  const button = btn(cls, "", onClick, label)
  button.setAttribute("aria-label", label); button.append(icon(name)); return button
}
function actionButton(label, action, patch = {}, cls = "button secondary small") {
  const button = btn(cls, label, () => send(action, patch))
  button.dataset.mutation = ""
  return button
}
const getSnapshot = () => window.__ZE__?.snapshot
const readPreference = (key, fallback) => { try { return localStorage.getItem("egress:" + key) || fallback } catch { return fallback } }
let preferenceRevision = 0, savedPreferenceRevision = 0, preferenceTimer = 0, heartbeatWriting = false
const changedPreferences = new Set()
const savePreference = (key, value) => {
  try { localStorage.setItem("egress:" + key, value) } catch {}
  if (!["density", "showProviders"].includes(key)) return
  changedPreferences.add(key); preferenceRevision++
  clearTimeout(preferenceTimer); preferenceTimer = setTimeout(() => heartbeat(), 180)
}
const view = { tab: readPreference("tab", "egress"), filter: "all", query: "", provider: readPreference("provider", ""), density: readPreference("density", "comfortable"), showProviders: readPreference("showProviders", "true") !== "false", limits: {}, recordsFilter: "all", recordsLimit: 12 }
const narrowProviders = matchMedia("(max-width: 1100px)")
let providerMenuOpen = false
if (!["egress", "sources", "claims"].includes(view.tab)) view.tab = "egress"
if (!["comfortable", "compact", "grid"].includes(view.density)) view.density = "comfortable"
let renderedKey = "", renderedAt = 0, closeDialog = null, dialogOnSnapshot = null, pollTimer = 0, readInFlight = false, hbAt = 0, heartbeatId = null
const openedAt = Date.now()
let lastReadError = ""
let pending = null, pendingTimer = 0, toastTimer = 0
let nodeIndex = new Map()
try { const saved = JSON.parse(sessionStorage.getItem("egress:pending")); if (saved?.id && Date.now() - saved.startedAt < 65 * 60_000) pending = saved } catch {}
function savePending() { try { pending ? sessionStorage.setItem("egress:pending", JSON.stringify(pending)) : sessionStorage.removeItem("egress:pending") } catch {} }
function toast(message, tone = "ok", duration = 4500) {
  clearTimeout(toastTimer)
  const node = $("toast")
  node.className = "toast " + tone
  node.replaceChildren(icon(tone === "err" || tone === "warn" ? "warn" : "check"), el("span", "", message), iconButton("x", "关闭提示", () => { node.hidden = true }))
  node.hidden = false
  if (duration) toastTimer = setTimeout(() => { node.hidden = true }, duration)
}
async function copyText(text, message = "已复制") {
  if (!text) return
  let copied = false
  try { await navigator.clipboard.writeText(text); copied = true } catch {}
  if (!copied) {
    const focused = document.activeElement, input = el("textarea", "clipboard-helper")
    input.value = text; ($( "modal").hidden ? document.body : $("modal").firstElementChild).append(input)
    input.focus(); input.select()
    try { copied = document.execCommand("copy") } catch {}
    input.remove(); focused?.focus?.({ preventScroll: true })
  }
  if (copied) toast(message)
  else openDialog((editor, close) => {
    editor.append(dialogHead("copy", "手动复制", close), el("p", "hint", "浏览器未允许复制，请选择下方内容复制。"))
    const input = el("input"); input.value = text; input.readOnly = true; input.setAttribute("aria-label", "需要复制的内容")
    editor.append(input); input.addEventListener("focus", () => input.select())
    editor.append(dialogBar([["关闭", "secondary", close]]))
  })
}
const ACTION_LABELS = { check: "正在检查出口", assign: "正在分配出口", bind: "正在绑定出口", unbind: "正在解除绑定", swap: "正在切换节点", seed: "正在重新挑选出口", subscribe: "正在更新订阅", "subscription-remove": "正在移除订阅", "pool-import": "正在导入号池", "pool-clear": "正在清空号池", config: "正在保存设置", claims: "正在领取 Token", sync: "正在同步绑定" }
ACTION_LABELS["probe-nodes"] = "正在测试节点"
ACTION_LABELS.exits = "正在调整出口数量"
const MAX_EXITS = 8
function finishPending(result) {
  if (pending?.draftKey && result.kind !== "err" && result.ok !== false) drafts.delete(pending.draftKey)
  pending = null; savePending(); clearTimeout(pendingTimer)
  toast(result.message || "操作完成", result.kind || "ok", ["err", "warn"].includes(result.kind) ? 9000 : 4500)
  syncBusy()
}
function send(action, patch = {}, label) {
  if (pending || getSnapshot()?.task) { toast("已有任务在执行，完成后可继续操作", "warn"); return false }
  if (!window.magpie?.options?.set) { toast("请在 magpie 的出口管家页面中执行操作", "err"); return false }
  const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  pending = { id, action, label: label || ACTION_LABELS[action] || "正在执行", startedAt: Date.now() }
  savePending(); syncBusy()
  const failed = (error) => { if (pending?.id === id) finishPending({ kind: "err", message: `提交失败：${error?.message || error}` }) }
  try { Promise.resolve(window.magpie.options.set({ request: { id, action, patch } })).catch(failed) }
  catch (error) { failed(error); return false }
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    if (pending?.id !== id || getSnapshot()?.task?.requestId === id) return
    finishPending({ kind: "warn", message: "尚未收到完成回执，请刷新查看后台状态" })
  }, 65 * 60_000)
  scheduleRead(800)
  return true
}
function noteRequests(snapshot) {
  const config = snapshot?.config || {}
  if (pending) {
    const result = (config.requestResults || []).find((r) => r.id === pending.id) || (config.lastRequestResult?.id === pending.id ? config.lastRequestResult : null)
    if (result) {
      finishPending(result)
      try { Promise.resolve(window.magpie?.options?.set({ request: null })).catch(() => {}) } catch {}
    }
  }
  if (heartbeatId && config.lastRequest === heartbeatId) {
    heartbeatId = null
    if (!pending) { try { Promise.resolve(window.magpie?.options?.set({ request: null })).catch(() => {}) } catch {} }
  }
}
function syncBusy() {
  if (pending && !getSnapshot()?.task && Date.now() - pending.startedAt > ({ config: 120_000, "pool-import": 120_000, "pool-clear": 120_000, "subscription-remove": 120_000, subscribe: 12 * 60_000, swap: 12 * 60_000 }[pending.action] || 65 * 60_000)) {
    finishPending({ kind: "warn", message: "后台尚未确认结果，请刷新查看状态后再操作" }); return
  }
  const task = pending || getSnapshot()?.task
  document.body.classList.toggle("pending", !!task)
  document.querySelectorAll("[data-mutation]").forEach((b) => { b.disabled = !!task || b.dataset.unavailable === "true" || !window.magpie?.options?.set })
  const banner = $("task-banner")
  banner.hidden = !task
  if (!task) { banner.replaceChildren(); banner.dataset.key = ""; return }
  const elapsed = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))
  const key = `${task.id || task.requestId || task.startedAt}:${elapsed > 30}`
  if (banner.dataset.key !== key) {
    banner.dataset.key = key
    const elapsedNode = el("span", "task-elapsed"); elapsedNode.setAttribute("aria-hidden", "true")
    banner.replaceChildren(el("span", "spinner"), el("div", "task-copy", task.label || ACTION_LABELS[task.action] || "后台任务进行中"), elapsedNode)
    if (elapsed > 30) banner.querySelector(".task-copy").append(el("small", "", "节点探测可能需要几分钟，可以继续浏览"))
  }
  banner.querySelector(".task-elapsed").textContent = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
}

// Dialogs preserve focus and scroll position, including nested flows.
function openDialog(build, { wide = false, kind = "" } = {}) {
  if (closeDialog) closeDialog()
  const modal = $("modal"), dialog = modal.firstElementChild, opener = document.activeElement
  const shell = document.querySelector(".app-shell"), scrollY = window.scrollY
  const editor = el("div", "editor")
  dialog.className = "dialog" + (wide ? " wide" : "") + (kind ? ` ${kind}-dialog` : "")
  dialogOnSnapshot = null
  dialog.replaceChildren(editor)
  closeDialog = close
  build(editor, close)
  const title = editor.querySelector(".dialog-title")
  if (title) { title.id = "dialog-title"; dialog.setAttribute("aria-labelledby", title.id) }
  shell.inert = true; document.body.classList.add("modal-open"); modal.hidden = false
  const focusable = () => [...dialog.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')].filter((n) => !n.disabled && !n.closest("[hidden]") && n.getClientRects().length)
  ;(editor.querySelector("[data-autofocus]") || focusable()[0] || dialog).focus({ preventScroll: true })
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return }
    if (event.key !== "Tab") return
    const nodes = focusable(), first = nodes[0], last = nodes.at(-1)
    if (!first) { event.preventDefault(); dialog.focus(); return }
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }
  let backdropDown = false
  modal.onpointerdown = (event) => { backdropDown = event.target === modal }
  modal.onclick = (event) => { if (event.target === modal && backdropDown) close() }
  document.addEventListener("keydown", onKey)
  syncBusy()
  function close() {
    if (closeDialog !== close) return
    closeDialog = null; dialogOnSnapshot = null; document.removeEventListener("keydown", onKey)
    modal.hidden = true; dialog.replaceChildren(); shell.inert = false; document.body.classList.remove("modal-open")
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    else $("settings-button").focus({ preventScroll: true })
    window.scrollTo({ top: scrollY, behavior: "instant" })
  }
  return close
}
function dialogHead(glyph, title, close) {
  const head = el("div", "dialog-head"), badge = el("span", "dialog-icon")
  badge.append(icon(glyph, 20)); head.append(badge, el("h2", "dialog-title", title), iconButton("x", "关闭对话框", close))
  return head
}
function dialogBar(buttons, note = "") {
  const bar = el("div", "dialog-bar")
  bar.append(typeof note === "string" ? el("span", "hint grow", note) : note)
  for (const [label, cls, fn] of buttons) {
    const button = btn("button " + cls, label, fn)
    if (cls.includes("primary") || cls.includes("danger")) button.dataset.mutation = ""
    bar.append(button)
  }
  return bar
}
let fieldId = 0
function field(label, input, hint = "") {
  const row = el("div", "field"), lab = el("label", "", label)
  input.id ||= "field-" + ++fieldId; lab.htmlFor = input.id
  row.append(lab, input)
  if (hint) { const help = el("p", "hint", hint); help.id = input.id + "-help"; input.setAttribute("aria-describedby", help.id); row.append(help) }
  return row
}
function setError(input, error, message) {
  input.setAttribute("aria-invalid", String(!!message)); error.textContent = message; error.hidden = !message
  error.id ||= "error-" + ++fieldId
  if (message) input.setAttribute("aria-errormessage", error.id)
  else input.removeAttribute("aria-errormessage")
}
function sectionHead(title, description, tools) {
  const head = el("div", "section-head"), copy = el("div")
  copy.append(el("h2", "section-title", title))
  if (description) copy.append(el("p", "section-description", description))
  head.append(copy); if (tools) head.append(tools)
  return head
}
function emptyState(glyph, title, description, actions = []) {
  const wrap = el("div", "empty-state"), badge = el("span", "empty-icon")
  badge.append(icon(glyph, 26)); wrap.append(badge, el("h3", "", title), el("p", "", description))
  if (actions.length) { const buttons = el("div", "empty-actions"); buttons.append(...actions); wrap.append(buttons) }
  return wrap
}

function switchTab(tab) {
  if (tab !== "egress") providerMenuOpen = false
  view.tab = tab; savePreference("tab", tab); render(getSnapshot(), true)
}
function selectProvider(provider) {
  const fromMenu = providerMenuOpen
  providerMenuOpen = false
  view.provider = provider; view.query = ""; view.filter = "all"; view.limits = {}
  savePreference("provider", provider); switchTab("egress")
  window.scrollTo({ top: 0, behavior: "instant" })
  if (fromMenu) $("provider-nav-toggle").focus()
}
function renderProviderSidebar(stats) {
  const sidebar = $("provider-sidebar"), active = !globalThis.EgressNavigation?.connected && view.tab === "egress" && stats.providers.length > 1
  const expanded = active && (narrowProviders.matches ? providerMenuOpen : view.showProviders)
  sidebar.hidden = !expanded
  document.querySelector(".workspace-body").classList.toggle("with-sidebar", expanded && !narrowProviders.matches)
  const toggle = $("provider-nav-toggle")
  toggle.hidden = !active; toggle.setAttribute("aria-expanded", String(expanded))
  toggle.setAttribute("aria-label", expanded ? "收起供应商导航" : "展开供应商导航")
  const signature = JSON.stringify([view.provider, stats.providers.map((p) => [p.id, p.name, p.accounts.length, p.accounts.filter(needsAttention).length])])
  if (sidebar.dataset.key === signature) return
  sidebar.dataset.key = signature
  const head = el("div", "provider-sidebar-head")
  head.append(el("span", "", "供应商"), iconButton("cog", "管理供应商范围", () => settingsDialog(getSnapshot(), "providers")))
  const links = el("div", "provider-links"); links.setAttribute("role", "group"); links.setAttribute("aria-label", "选择供应商")
  for (const p of [{ id: "", name: "全部供应商", accounts: stats.accounts }, ...stats.providers]) {
    const button = btn("provider-link", "", () => selectProvider(p.id)), count = el("span", "provider-link-count", p.accounts.length)
    button.append(icon(p.id ? p.kind === "keys" ? "key" : "users" : "providers"), el("span", "provider-link-name", p.name), count)
    button.setAttribute("aria-pressed", view.provider === p.id); button.setAttribute("aria-label", `切换到 ${p.name}`)
    button.title = `${p.name} · ${p.accounts.length} 个账号`; button.dataset.provider = p.id
    const attention = p.accounts.filter(needsAttention).length
    if (attention && p.id) { count.classList.add("has-issues"); count.title = `${attention} 个账号需关注` }
    links.append(button)
  }
  const focused = sidebar.contains(document.activeElement) ? document.activeElement?.dataset.provider : undefined
  sidebar.replaceChildren(head, links)
  if (focused !== undefined) [...links.children].find((button) => button.dataset.provider === focused)?.focus({ preventScroll: true })
}
function render(snapshot, force = false) {
  if (!snapshot) {
    // Without data there are no suppliers to list. Below 1100px the list is a
    // floating card, so an empty one would cover the tabs.
    $("provider-sidebar").hidden = true; $("provider-nav-toggle").hidden = true
    document.querySelector(".workspace-body").classList.remove("with-sidebar")
    $("root").replaceChildren(emptyState("inbox", "等待后台连接", "后台服务尚未提供数据。请稍后刷新，或在 magpie 中重新打开出口管家。", [btn("button secondary", "重新读取", () => refreshData())]))
    syncBusy(); tick(); return
  }
  const stats = totals(snapshot)
  nodeIndex = new Map((snapshot.nodes || []).map((node) => [node.name, node]))
  if (view.tab === "claims" && !stats.providers.some((p) => p.id === "zcode")) view.tab = "egress"
  if (view.provider && !stats.providers.some((p) => p.id === view.provider)) view.provider = ""
  globalThis.EgressNavigation?.update(navigationModel(snapshot, view))
  document.body.dataset.density = view.density
  $("preview-banner").hidden = !window.__EGRESS_PREVIEW__
  $("subline").textContent = stats.total ? `${stats.providers.length} 个受管供应商 · ${stats.total} 个账号 · 按账号固定出口` : "导入节点来源，选择要管理的供应商。"
  const focusedProvider = stats.providers.find((p) => p.id === view.provider)
  $("breadcrumb-current").textContent = { egress: focusedProvider?.name || "出口分配", sources: "节点来源", claims: "自动领取" }[view.tab]
  renderProviderSidebar(stats)
  const scopeAccounts = view.tab === "egress" && focusedProvider ? focusedProvider.accounts : stats.accounts
  const pendingCount = scopeAccounts.filter((a) => !a.port).length
  const assign = $("assign-button")
  assign.replaceChildren(icon("plus"), el("span", "", pendingCount ? `分配出口 (${pendingCount})` : "分配出口"))
  assign.dataset.unavailable = String(!pendingCount || !snapshot.sources?.total)
  assign.title = !pendingCount ? "当前范围内的账号均已绑定出口" : !snapshot.sources?.total ? "请先导入节点来源" : `为${focusedProvider && view.tab === "egress" ? focusedProvider.name : "全部受管供应商"}的待分配账号分配出口`
  const check = document.querySelector('[data-act="check"]')
  check.dataset.unavailable = String(!snapshot.egress?.hasState)
  $("count-egress").textContent = stats.total
  $("count-sources").textContent = subscriptionsOf(snapshot.sources).length + (snapshot.sources?.pool?.count ? 1 : 0)
  $("count-claims").textContent = snapshot.claims?.today ?? ""
  $("tab-claims").hidden = !stats.providers.some((p) => p.id === "zcode")
  document.querySelectorAll("[data-tab]").forEach((tab) => { const active = tab.dataset.tab === view.tab; tab.setAttribute("aria-selected", active); tab.tabIndex = active ? 0 : -1 })
  $("root").setAttribute("aria-labelledby", "tab-" + view.tab)
  renderOverview(snapshot, stats)
  const key = snapshotKey(snapshot) + JSON.stringify(view)
  if (force || key !== renderedKey) {
    const focused = document.activeElement, focusKey = focused?.dataset?.focusKey, selection = focused?.selectionStart, selectionEnd = focused?.selectionEnd
    const oldY = window.scrollY
    const content = view.tab === "sources" ? sourcesSection(snapshot) : view.tab === "claims" ? claimSection(snapshot) : egressSection(snapshot)
    $("root").replaceChildren(content)
    if (focusKey) {
      const target = [...$("root").querySelectorAll("[data-focus-key]")].find((n) => n.dataset.focusKey === focusKey)
      if (target) { target.focus({ preventScroll: true }); if (typeof selection === "number" && target.setSelectionRange) target.setSelectionRange(selection, selectionEnd) }
    }
    if (!closeDialog && window.scrollY !== oldY) window.scrollTo({ top: oldY, behavior: "instant" })
    renderedKey = key; renderedAt = Date.now()
  }
  renderNotice(snapshot, stats); dialogOnSnapshot?.(snapshot); syncBusy(); tick()
}
function renderOverview(snapshot, stats) {
  const overview = $("overview"), sources = snapshot.sources || {}, spares = snapshot.egress?.spares || []
  const cards = [
    ["shield", "就绪账号", stats.healthy, `/ ${stats.total}`, "出口与账号状态正常", "green", () => { view.filter = "healthy"; view.query = view.provider = ""; switchTab("egress") }],
    ["activity", "需要关注", stats.attention, "个", stats.pending ? `${stats.pending} 个待分配 · ${Math.max(0, stats.attention - stats.pending)} 个异常` : stats.attention ? "查看异常并恢复连接" : "所有账号状态良好", stats.attention ? "amber" : "neutral", () => { view.filter = "attention"; view.query = view.provider = ""; switchTab("egress") }],
    ["cloud", "候选节点", sources.total || 0, "个", `${(snapshot.nodes || []).filter((node) => nodeTestState(node).measured).length} 个已有探测记录 · 查看节点`, "blue", () => pickNodeDialog()],
    ["stack", "备用出口", spares.length, "个", `目标 ${snapshot.config?.sparesCount ?? 8} 个 · 异常时自动接替`, "violet", () => { switchTab("egress"); $("spares-section")?.scrollIntoView({ behavior: "smooth", block: "center" }) }],
  ]
  const key = cards.map((c) => c.slice(0, 6).join("|")).join(";")
  if (overview.dataset.key === key) return
  overview.dataset.key = key
  overview.replaceChildren(...cards.map(([glyph, label, value, unit, hint, tone, click]) => {
    const card = btn("stat-card " + tone, "", click), top = el("span", "stat-top"), glyphWrap = el("span", "stat-icon")
    glyphWrap.append(icon(glyph, 18)); top.append(el("span", "", label), glyphWrap)
    const number = el("span", "stat-value", value); number.append(el("small", "", unit))
    const foot = el("span", "stat-foot", hint); foot.append(icon("arrow", 13))
    card.append(number, top, foot); return card
  }))
}
function renderNotice(snapshot, stats) {
  const notice = $("notice"), failures = subscriptionsOf(snapshot.sources).filter((s) => s.error)
  let title = "", text = "", action = null, tone = "warn"
  if (snapshot.onboard?.error) { title = "暂时无法读取供应商"; text = "请确认 magpie 正在运行，账号配置文件可以读取。" }
  else if (snapshot.egress?.error) { title = "出口服务需要检查"; text = snapshot.egress.error; action = actionButton("重新体检", "check") }
  else if (snapshot.sources?.total && !stats.providers.length) { title = "节点已准备好"; text = "选择要管理的供应商，即可为账号分配出口。"; tone = "info"; action = btn("button secondary small", "选择供应商", () => settingsDialog(snapshot)) }
  else if (failures.length && view.tab !== "sources") { title = `${failures.length} 个订阅更新失败`; text = "已保留上次成功获取的节点。"; action = btn("button quiet small", "查看来源", () => switchTab("sources")) }
  notice.hidden = !title
  if (!title) return
  notice.className = "notice " + tone
  const copy = el("div", "notice-copy"); copy.append(el("strong", "", title), el("span", "", text))
  notice.replaceChildren(icon(tone === "info" ? "cloud" : "warn", 18), copy)
  if (action) notice.append(action)
}

function egressSection(snapshot) {
  const stats = totals(snapshot), section = el("section", "egress-section")
  if (!stats.total || !snapshot.sources?.total && !snapshot.egress?.hasState) {
    section.append(onboarding(snapshot, stats))
    if (!stats.total) return section
  }
  const controls = el("div", "account-controls"), toolbar = el("div", "account-toolbar"), searchWrap = el("div", "search-input")
  const search = el("input"); search.type = "search"; search.placeholder = "搜索账号、节点或 IP…"; search.value = view.query
  search.dataset.focusKey = "account-search"; search.setAttribute("aria-label", "搜索账号、节点或 IP"); search.autocomplete = "off"
  search.oninput = () => { view.query = search.value; view.limits = {}; render(getSnapshot(), true) }
  searchWrap.append(icon("search"), search)
  const select = el("select")
  select.setAttribute("aria-label", "筛选供应商"); select.dataset.focusKey = "provider-filter"
  for (const [id, name] of [["", "全部供应商"], ...stats.providers.map((p) => [p.id, p.name])]) { const option = el("option", "", name); option.value = id; select.append(option) }
  select.value = view.provider
  select.onchange = () => selectProvider(select.value)
  const density = el("div", "display-density segments")
  density.setAttribute("role", "group"); density.setAttribute("aria-label", "账号显示方式")
  for (const [key, name, glyph] of [["comfortable", "标准", "comfortable"], ["compact", "紧凑", "compact"], ["grid", "多列", "columns"]]) {
    const button = btn("segment", "", () => { view.density = key; savePreference("density", key); render(getSnapshot(), true) })
    button.append(icon(glyph, 15), el("span", "", name)); button.setAttribute("aria-label", name + "视图"); button.setAttribute("aria-pressed", view.density === key)
    button.title = { comfortable: "详细列表，显示账号副标题与节点探测摘要", compact: "紧凑列表，收起次要信息并减少行距", grid: "多列账号卡片，同屏显示更多账号，保留换绑与复制操作" }[key]; button.dataset.focusKey = "density-" + key
    density.append(button)
  }
  toolbar.append(searchWrap, select, density)
  controls.append(toolbar); section.append(controls)
  const filterRow = el("div", "filter-row"), filters = el("div", "filter-tabs")
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "按账号状态筛选")
  const scope = view.provider ? totals({ providers: stats.providers.filter((p) => p.id === view.provider) }) : stats
  for (const [key, label, count] of [["all", "全部", scope.total], ["attention", "需关注", scope.attention], ["pending", "待分配", scope.pending], ["healthy", "正常", scope.healthy]]) {
    const button = btn("filter-button", label, () => { view.filter = key; view.limits = {}; render(getSnapshot(), true) })
    button.append(el("span", "", count)); button.setAttribute("aria-pressed", view.filter === key); button.dataset.focusKey = "filter-" + key
    filters.append(button)
  }
  const matches = stats.providers.filter((p) => !view.provider || p.id === view.provider).map((p) => ({ ...p, rows: p.accounts.filter((a) => matchesAccount(a, p, view.query, view.filter)) }))
  const count = matches.reduce((n, p) => n + p.rows.length, 0)
  const matchCount = el("span", "result-count", `显示 ${count} / ${scope.total} 个账号`)
  matchCount.setAttribute("role", "status")
  filterRow.append(filters, matchCount); controls.append(filterRow)
  if (!count && stats.total) section.append(emptyState("search", "没有匹配的账号", "试试其它关键词，或清除筛选查看全部账号。", [btn("button secondary", "清除筛选", () => { view.query = view.provider = ""; view.filter = "all"; render(getSnapshot(), true) })]))
  for (const provider of matches) {
    if (!provider.rows.length) continue
    const group = el("div", "provider-group"), head = el("div", "provider-head"), mark = el("span", "provider-mark")
    mark.append(icon(provider.kind === "keys" ? "key" : "users", 17)); group.dataset.provider = provider.id
    const title = el("div", "provider-title")
    title.append(el("h2", "", provider.name), el("span", "", `${provider.accounts.filter((a) => a.port).length}/${provider.accounts.length} 已绑定`))
    const kind = el("span", "kind-badge", KIND_TEXT[provider.kind] || "供应商")
    head.append(mark, title, kind)
    const pendingCount = provider.accounts.filter((a) => !a.port).length
    if (pendingCount) head.append(actionButton(`分配 ${pendingCount} 个`, "assign", { provider: provider.id }, "button quiet accent small"))
    group.append(head)
    const cards = view.density === "grid", pageSize = cards ? 96 : 50
    const table = el("div", cards ? "account-grid" : "account-table")
    table.setAttribute("role", cards ? "list" : "table"); table.setAttribute("aria-label", `${provider.name} 出口分配`)
    if (!cards) {
      const tableHead = el("div", "account-table-head"); tableHead.setAttribute("role", "row")
      for (const name of ["账号", "连接节点", "出口 IP", "状态", "本地端口", "操作"]) { const cell = el("span", "", name); cell.setAttribute("role", "columnheader"); tableHead.append(cell) }
      table.append(tableHead)
    }
    const limit = Math.max(view.limits[provider.id] || 0, pageSize)
    for (const account of provider.rows.slice(0, limit)) table.append(accountRow(account, provider, { card: cards }))
    group.append(table)
    if (provider.rows.length > limit) {
      const more = btn("load-more", `再显示 ${Math.min(pageSize, provider.rows.length - limit)} 个账号（共 ${provider.rows.length} 个）`, () => { view.limits[provider.id] = limit + pageSize; render(getSnapshot(), true) })
      more.dataset.focusKey = "more-" + provider.id; group.append(more)
    }
    section.append(group)
  }
  section.append(sparesSection(snapshot))
  return section
}
const KIND_TEXT = { login: "登录账号", keys: "API Key", mixed: "账号 + Key" }
function accountRow(account, provider, { card = false } = {}) {
  const state = accountState(account), row = el("div", "account-row " + state.tone + (card ? " account-card" : ""))
  row.setAttribute("role", card ? "listitem" : "row")
  const identity = el("div", "account-identity"), avatar = el("span", "account-avatar")
  avatar.append(icon(provider.kind === "keys" ? "key" : "user", 16))
  const dot = el("i", "status-dot " + state.tone); avatar.append(dot)
  const who = el("div", "account-who"), name = el("span", "account-name", account.alias || account.label || account.id)
  name.title = name.textContent
  const secondary = el("span", "account-secondary", account.alias ? account.label || account.id : account.plan || (provider.kind === "keys" ? "API Key" : "登录账号"))
  secondary.title = secondary.textContent
  who.append(name, secondary); identity.append(avatar, who)
  const nodeCell = el("div", "account-node")
  if (account.node) {
    const node = btn("node-button", "", () => pickNodeDialog({ provider: provider.id, account: account.id, port: account.port, current: account.node, title: account.alias || account.label }))
    node.append(el("span", "region-tag", regionOf(account.node) || "NODE"), el("span", "node-name", account.node), icon("swap", 13))
    node.title = `${account.node} · 点击换绑`; node.setAttribute("aria-label", `为 ${account.alias || account.label} 换绑节点`)
    node.dataset.focusKey = `node-${provider.id}-${account.id}`; nodeCell.append(node)
    const measured = nodeIndex.get(account.node), test = nodeTestState(measured)
    const telemetry = el("span", "node-telemetry", test.measured ? `TLS ${test.latency}${test.stale ? " · 历史" : ""}` : "尚无延迟记录")
    telemetry.dataset.node = account.node
    telemetry.title = test.measured ? `${test.detail} · ${when(measured.test.checkedAt)} · 点击节点查看详情` : "点击节点可查看详情并进行测试"
    nodeCell.append(telemetry)
    const exits = exitsOf(account)
    if (exits.length) {
      // 徽标放进节点按钮里，不改变各种密度下的行布局
      const live = exits.filter((exit) => exit.ip).length
      const badge = el("span", "exit-count" + (live < exits.length ? " warn" : ""), `×${exits.length}`)
      badge.title = `单 Key 多出口：${live}/${exits.length} 个出口在线`
      node.querySelector(".node-name").after(badge)
      node.title = `主出口 ${account.node} · 共 ${exits.length} 个出口（${live} 个在线）· 点击换绑主出口`
    }
  } else {
    const assign = actionButton("分配出口", "bind", { provider: provider.id, account: account.id }, "button quiet accent small")
    assign.dataset.focusKey = `bind-${provider.id}-${account.id}`
    nodeCell.append(el("span", "unbound-label", "尚未绑定"), assign)
  }
  const ip = account.ip ? btn("copy-value account-ip mono", account.ip, () => copyText(account.ip, "出口 IP 已复制"), "复制公网出口 IP") : el("span", "account-ip muted", "—")
  if (account.ip) { ip.setAttribute("aria-label", `复制出口 IP ${account.ip}`); ip.dataset.focusKey = `ip-${provider.id}-${account.id}` }
  const status = el("div", "account-status"), badge = el("span", "status-badge " + state.tone, state.label)
  badge.prepend(el("i", "status-dot " + state.tone)); badge.title = state.detail; status.append(badge)
  const port = account.port ? btn("copy-value account-port mono", proxyAddress(account).replace(/^.*:/, ":"), () => copyText(proxyAddress(account), "本地代理地址已复制"), `复制 ${proxyAddress(account)}`) : el("span", "account-port muted", "未分配")
  if (account.port) { port.setAttribute("aria-label", `复制 ${account.alias || account.label} 的本地代理地址`); port.dataset.focusKey = `port-${provider.id}-${account.id}` }
  const more = iconButton("more", `查看 ${account.alias || account.label} 的账号详情`, () => accountDialog(account, provider))
  more.classList.add("account-more"); more.dataset.focusKey = `details-${provider.id}-${account.id}`
  for (const [child, cls] of [[identity, ""], [nodeCell, ""], [ip, "account-ip-cell"], [status, ""], [port, "account-port-cell"], [more, "account-more-cell"]]) {
    const cell = cls ? el("div", cls) : child
    if (cls) cell.append(child)
    if (!card) cell.setAttribute("role", "cell")
    row.append(cell)
  }
  return row
}
function sparesSection(snapshot) {
  const section = el("section", "spares-section"); section.id = "spares-section"
  const spares = snapshot.egress?.spares || []
  const subtitle = spares.length ? "与所有供应商共享，体检发现异常时自动接替。" : "分配出口或运行体检后，会自动补充可用的备用节点。"
  section.append(sectionHead("备用出口", subtitle, el("span", "count-label", `${spares.length} / ${snapshot.config?.sparesCount ?? 8}`)))
  if (!spares.length) { section.append(el("div", "empty-inline", "备用池暂为空")); return section }
  const grid = el("div", "spares-grid")
  for (const spare of spares) {
    const card = el("div", "spare-card"), top = el("div", "spare-top")
    const node = el("span", "", spare.node); node.title = spare.node
    top.append(el("i", "status-dot " + (spare.ip ? "ok" : "warn")), node)
    const meta = el("div", "spare-meta")
    meta.append(spare.ip ? btn("copy-value mono", spare.ip, () => copyText(spare.ip, "出口 IP 已复制"), "复制出口 IP") : el("span", "muted", "待探测"), btn("copy-value mono", `:${spare.port}`, () => copyText(proxyAddress(spare), "备用代理地址已复制"), "复制本地代理地址"))
    card.append(top, meta); grid.append(card)
  }
  section.append(grid); return section
}
function onboarding(snapshot, stats) {
  const wrap = el("div", "onboarding"), heading = el("div", "onboarding-heading"), badge = el("span", "empty-icon")
  badge.append(icon("inbox", 24)); heading.append(badge, el("div", "", "三步，准备好你的独立出口"))
  wrap.append(heading)
  const steps = el("ol", "onboarding-steps")
  for (const [number, title, description, done, button] of [
    [1, "导入节点", "添加机场订阅，或粘贴现成的代理列表。", !!snapshot.sources?.total, btn("button secondary small", "导入订阅", () => importSubDialog())],
    [2, "选择供应商", "勾选要管理的账号与 Key 所属供应商。", !!stats.total, btn("button secondary small", "选择供应商", () => settingsDialog(snapshot))],
    [3, "分配独立出口", "自动挑选节点，检查连通性并去重 IP。", stats.total > 0 && !stats.pending, actionButton("开始分配", "assign")],
  ]) {
    const step = el("li", done ? "complete" : ""), marker = el("span", "step-number", done ? "" : number)
    if (done) marker.append(icon("check", 14))
    if (number === 3) button.dataset.unavailable = String(!stats.pending || !snapshot.sources?.total)
    step.append(marker, el("h3", "", title), el("p", "", description), button); steps.append(step)
  }
  wrap.append(steps)
  if (snapshot.onboard?.legacyDir && !snapshot.egress?.hasState) wrap.append(actionButton("接管本机已有出口配置", "config", { baseDir: snapshot.onboard.legacyDir }, "button quiet small"))
  return wrap
}
function sourcesSection(snapshot) {
  const section = el("section"), sources = snapshot.sources || {}, subscriptions = subscriptionsOf(sources), pool = sources.pool || {}
  const actions = el("div", "inline-actions")
  if (snapshot.nodes?.length) { const browse = btn("button secondary small", "查看节点", () => pickNodeDialog()); browse.prepend(icon("server", 15)); actions.append(browse) }
  if (subscriptions.length) actions.append(actionButton("全部更新", "subscribe"))
  const add = btn("button primary", "", () => importSubDialog()); add.append(icon("plus"), el("span", "", "添加订阅")); actions.append(add)
  section.append(sectionHead("节点来源", "订阅与手动号池共同组成候选池；更新失败会保留已缓存节点。", actions))
  const list = el("div", "source-list")
  for (const [index, sub] of subscriptions.entries()) {
    const card = el("article", "source-card" + (sub.error ? " has-error" : "")), glyph = el("span", "source-icon")
    glyph.append(icon("cloud", 21))
    const info = el("div", "source-info"), title = el("div", "source-title")
    title.append(el("h3", "", hostOf(sub.url)), el("span", "kind-badge", `订阅 ${index + 1}`))
    const meta = el("div", "source-meta")
    meta.append(el("span", "", `${sub.count || 0} 个节点`), el("span", "", sub.fetchedAt ? `更新于 ${when(sub.fetchedAt)}` : "尚未更新"))
    info.append(title, meta)
    if (sub.error) { const error = el("p", "source-error", `${sub.error}${sub.count ? " · 已保留上次节点" : ""}`); info.append(error) }
    const tools = el("div", "source-actions")
    tools.append(actionButton(sub.error ? "重试" : "更新", "subscribe", sub.id ? { subscriptionId: sub.id } : { url: sub.url }), btn("button quiet small", "编辑", () => importSubDialog(sub), "更换订阅地址"))
    if (sub.id) tools.append(iconButton("x", `移除 ${hostOf(sub.url)} 的订阅`, () => confirmDialog("移除订阅", `将移除 ${hostOf(sub.url)} 及其 ${sub.count || 0} 个缓存节点。已在运行的绑定会继续保留，后续换绑需要其它可用来源。`, "移除订阅", () => send("subscription-remove", { subscriptionId: sub.id }), true)))
    card.append(glyph, info, tools); list.append(card)
  }
  if (!subscriptions.length) list.append(emptyState("cloud", "添加你的第一个订阅", "支持 Clash YAML 订阅，每行一个链接，可一次导入多个机场。", [btn("button secondary", "导入订阅链接", () => importSubDialog())]))
  section.append(list)
  const poolCard = el("article", "source-card pool-card"), poolIcon = el("span", "source-icon violet"), poolInfo = el("div", "source-info")
  poolIcon.append(icon("stack", 21)); poolInfo.append(el("h3", "", "手动号池"), el("p", "source-meta", pool.count ? `${pool.count} 个节点 · 添加于 ${when(pool.addedAt)}` : "粘贴 SOCKS5 / HTTP 代理或 Clash 节点配置"))
  const poolActions = el("div", "source-actions")
  poolActions.append(btn("button secondary small", pool.count ? "追加导入" : "导入号池", () => importPoolDialog()))
  if (pool.count) poolActions.append(btn("button quiet danger small", "清空", () => confirmDialog("清空手动号池", `将移除手动导入的 ${pool.count} 个节点。机场订阅会继续保留。`, "清空号池", () => send("pool-clear"), true)))
  poolCard.append(poolIcon, poolInfo, poolActions); section.append(poolCard)
  const info = el("div", "info-panel")
  info.append(icon("shield", 20), el("div", "", "同名节点自动整理，出口 IP 全局去重。添加来源后，回到出口分配为待绑定账号选择出口。"))
  section.append(info); return section
}
const STATUS_TEXT = { claimed: "领取成功", done: "已领过", captcha: "验证未通过", failed: "领取失败", skipped: "已跳过", inactive: "无活动投递", settled: "今日已完成" }
function claimSection(snapshot) {
  const section = el("section"), { claims = {}, config = {}, records = [] } = snapshot
  const settings = btn("button secondary small", "调整计划", () => settingsDialog(snapshot))
  section.append(sectionHead("自动领取", "使用账号自己的独立出口，所有时间均为北京时间。", settings))
  const card = el("div", "claim-plan"), glyph = el("span", "claim-icon"); glyph.append(icon("clock", 25))
  const copy = el("div", "claim-plan-copy")
  copy.append(el("h3", "", `每天 ${pad(config.claimHour ?? 19)}:${pad(config.claimMinute ?? 0)} 开始`), el("p", "", `持续 ${config.claimWindowHours ?? 6} 小时，每 ${config.claimIntervalMin ?? 10} 分钟检查一次`))
  const line = el("span", "claim-next", !config.claimEnabled ? "自动领取已暂停" : claims.inWindow ? "当前处于领取窗口" : `下次开始：${when(claims.nextWindowAt)}`)
  copy.append(line)
  const toggle = btn("switch", "", () => send("config", { claimEnabled: !config.claimEnabled }))
  toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-label", "自动领取"); toggle.setAttribute("aria-checked", !!config.claimEnabled); toggle.dataset.mutation = ""; toggle.append(el("span"))
  card.append(glyph, copy, el("span", "claim-today", `今日已领 ${claims.today ?? records.filter((r) => ["claimed", "done"].includes(r.status) && beijing(r.time)?.day === beijing(Date.now()).day).length}`), toggle, actionButton("立即领取", "claims"))
  section.append(card)
  if (claims.lastResult?.error) section.append(el("p", "inline-error", claims.lastResult.error))
  const filters = el("div", "filter-tabs")
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "筛选领取记录")
  for (const [key, label] of [["all", "全部记录"], ["success", "已领取"], ["issues", "需关注"]]) {
    const button = btn("filter-button", label, () => { view.recordsFilter = key; view.recordsLimit = 12; render(getSnapshot(), true) })
    button.setAttribute("aria-pressed", view.recordsFilter === key); button.dataset.focusKey = "records-" + key; filters.append(button)
  }
  section.append(sectionHead("最近记录", "保留最近 100 条记录。", filters))
  const filtered = records.filter((r) => view.recordsFilter === "all" || (view.recordsFilter === "success" ? ["claimed", "done"].includes(r.status) : ["failed", "captcha", "skipped"].includes(r.status)))
  if (!filtered.length) section.append(emptyState("clock", records.length ? "没有符合筛选条件的记录" : "还没有领取记录", records.length ? "切换到全部记录查看其它结果。" : "开启自动领取后，有活动投递时会在这里显示结果。"))
  else {
    const list = el("div", "records-list")
    for (const record of filtered.slice(0, view.recordsLimit)) {
      const row = el("div", "record-row"), state = ["claimed", "done"].includes(record.status) ? "ok" : ["failed", "captcha"].includes(record.status) ? "bad" : "muted"
      const info = el("div", "record-info")
      info.append(el("span", "record-account", record.account || record.email), el("span", "record-plan", record.planName || record.plan || "—"))
      const result = el("div", "record-result")
      result.append(el("span", "status-badge " + state, STATUS_TEXT[record.status] || record.status))
      if (record.reason) { const reason = el("span", "record-reason", record.reason); reason.title = record.reason; result.append(reason) }
      row.append(el("i", "status-dot " + state), info, result, el("time", "record-time mono", when(record.time))); list.append(row)
    }
    if (filtered.length > view.recordsLimit) { const more = btn("load-more", `显示更多（还有 ${filtered.length - view.recordsLimit} 条）`, () => { view.recordsLimit += 20; render(getSnapshot(), true) }); more.dataset.focusKey = "records-more"; list.append(more) }
    section.append(list)
  }
  return section
}

const drafts = new Map()
function importSubDialog(current = null) {
  const editing = !!current?.url, draftKey = "subscription-" + (current?.id || "new")
  openDialog((editor, close) => {
    editor.append(dialogHead("cloud", editing ? "编辑订阅" : "添加订阅", close))
    const input = el(editing ? "input" : "textarea")
    if (editing) input.type = "url"
    input.placeholder = "https://example.com/subscribe?token=…" + (editing ? "" : "\nhttps://another.example/subscribe?token=…")
    input.value = drafts.get(draftKey) ?? current?.url ?? ""; input.spellcheck = false; input.autocomplete = "off"; input.dataset.autofocus = ""
    const error = el("p", "field-error"); error.hidden = true; error.setAttribute("role", "alert")
    editor.append(field(editing ? "订阅地址" : "订阅链接", input, editing ? "更新失败时会保留上次成功获取的节点。" : "每行一个 Clash YAML 链接。重复地址会自动合并。"), error)
    const count = el("span", "hint grow")
    const recount = () => { const n = new Set(input.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)).size; count.textContent = `${n} 个链接 · Ctrl / ⌘ + Enter 提交` }
    const submit = () => {
      const lines = input.value.split(/\r?\n/), urls = []
      let message = ""
      for (const [i, raw] of lines.entries()) {
        const value = raw.trim(); if (!value) continue
        try { const url = new URL(value); if (!/^https?:$/.test(url.protocol) || /\s/.test(value)) throw new Error(); urls.push(url.href) }
        catch { message = `第 ${i + 1} 行需要完整的 http:// 或 https:// 地址`; break }
      }
      if (!message && !urls.length) message = "请至少填写一个订阅链接"
      setError(input, error, message)
      if (message) { input.focus(); return }
      drafts.set(draftKey, input.value)
      if (send("subscribe", editing ? { subscriptionId: current.id, url: urls[0] } : { urls: [...new Set(urls)] })) { pending.draftKey = draftKey; close() }
    }
    input.oninput = () => { drafts.set(draftKey, input.value); setError(input, error, ""); recount() }
    input.onkeydown = (event) => { if (event.key === "Enter" && (editing || event.ctrlKey || event.metaKey)) { event.preventDefault(); submit() } }
    recount(); editor.append(dialogBar([["取消", "secondary", close], [editing ? "保存并更新" : "导入订阅", "primary", submit]], count))
  })
}
function importPoolDialog() {
  openDialog((editor, close) => {
    editor.append(dialogHead("stack", "导入手动号池", close))
    const input = el("textarea"); input.spellcheck = false; input.autocomplete = "off"; input.dataset.autofocus = ""
    input.value = drafts.get("pool") || ""
    input.placeholder = "socks5://user:pass@127.0.0.1:1080#节点名称\nhttp://127.0.0.1:8080\n\n或 Clash YAML：\nproxies:\n  - { name: 节点 A, type: socks5, server: 127.0.0.1, port: 1080 }"
    const error = el("p", "field-error"); error.hidden = true; error.setAttribute("role", "alert")
    editor.append(field("代理列表或 Clash 配置", input, "新节点追加到现有号池；同名节点会更新为新配置。"), error)
    const count = el("span", "hint grow", "Ctrl / ⌘ + Enter 导入")
    const submit = () => {
      const message = !input.value.trim() ? "请先粘贴代理列表" : new Blob([input.value]).size > 900_000 ? "内容过大，请拆分为小于 900 KB 的批次导入" : ""
      setError(input, error, message)
      if (message) { input.focus(); return }
      drafts.set("pool", input.value)
      if (send("pool-import", { text: input.value })) { pending.draftKey = "pool"; close() }
    }
    input.oninput = () => { drafts.set("pool", input.value); setError(input, error, ""); count.textContent = `${input.value.split("\n").filter((s) => s.trim()).length} 行 · Ctrl / ⌘ + Enter 导入` }
    input.onkeydown = (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit() } }
    editor.append(dialogBar([["取消", "secondary", close], ["导入号池", "primary", submit]], count))
  })
}
function pickNodeDialog(target = {}) {
  let snapshot = getSnapshot() || {}, nodes = snapshot.nodes || []
  if (!nodes.length) { toast("暂无候选节点，请先导入订阅或号池", "warn"); return }
  let region = "", source = "", order = "recommended", limit = 50, onlyAvailable = !!target.account
  let selected = nodes.some((node) => node.name === target.current) ? target.current : "", visible = [], lastDraw = ""
  const binding = !!target.account
  openDialog((editor, close) => {
    editor.append(dialogHead(binding ? "swap" : "server", binding ? "选择连接节点" : "候选节点", close))
    const context = el("div", "picker-context"), contextCopy = el("div")
    contextCopy.append(el("strong", "", binding ? target.title || target.account : "查看节点与连接质量"), el("span", "hint", binding ? `当前节点：${target.current || "尚未绑定"}` : "测试使用独立探测出口，不改变账号绑定。"))
    const batch = actionButton("测试列表前 20 个", "probe-nodes", {}, "button secondary small")
    batch.replaceChildren(icon("activity", 15), el("span", "", "测试列表前 20 个"))
    batch.onclick = () => { if (visible.length) send("probe-nodes", { names: visible.slice(0, 20).map((node) => node.name) }) }
    context.append(contextCopy, batch); editor.append(context)
    const tools = el("div", "picker-tools"), searchWrap = el("div", "search-input"), search = el("input")
    search.type = "search"; search.placeholder = `搜索 ${nodes.length} 个节点…`; search.setAttribute("aria-label", "搜索节点"); search.autocomplete = "off"; search.dataset.autofocus = ""
    searchWrap.append(icon("search"), search)
    const sourceFilter = el("select"), sort = el("select")
    sourceFilter.setAttribute("aria-label", "筛选节点来源"); sort.setAttribute("aria-label", "节点排序")
    const sourceNames = () => new Map(subscriptionsOf(snapshot.sources).map((sub) => [sub.id, hostOf(sub.url)]))
    for (const [value, label] of [["", "全部来源"], ...sourceNames(), ["pool", "手动号池"]]) { const option = el("option", "", label); option.value = value; sourceFilter.append(option) }
    for (const [value, label] of [["recommended", "推荐顺序"], ["latency", "TLS 延迟从低到高"], ["name", "按名称"]]) { const option = el("option", "", label); option.value = value; sort.append(option) }
    tools.append(searchWrap, sourceFilter, sort); editor.append(tools)
    const controls = el("div", "node-controls"), availableLabel = el("label", "checkbox-row"), available = el("input"), regionFilter = el("select")
    available.type = "checkbox"; available.checked = onlyAvailable
    availableLabel.append(available, el("span", "", "仅显示可选节点"))
    regionFilter.setAttribute("aria-label", "筛选节点地区")
    for (const value of ["", ...new Set(nodes.map((node) => regionOf(node.name)).filter(Boolean))]) { const option = el("option", "", value || "全部地区"); option.value = value; regionFilter.append(option) }
    controls.append(availableLabel, regionFilter, el("span", "picker-help", "优先近期可达的低延迟节点，其次备用")); editor.append(controls)
    const workspace = el("div", "picker-workspace"), listPane = el("div", "picker-list-pane"), listHead = el("div", "node-list-head")
    workspace.dataset.mobilePanel = "list"
    listHead.append(el("span", "", "节点 / 来源"), el("span", "", "TLS 延迟"))
    const list = el("div", "node-list"), count = el("div", "node-count"), inspector = el("aside", "node-inspector")
    inspector.setAttribute("aria-label", "节点详情"); count.setAttribute("role", "status")
    listPane.append(listHead, list, count); workspace.append(listPane, inspector); editor.append(workspace)
    const choice = el("span", "picker-choice hint grow")
    const confirm = btn("button primary", "确认换绑", () => {
      const chosen = nodes.find((node) => node.name === selected), { occupied } = availability()
      if (!chosen || occupied.has(chosen.name) || chosen.name === target.current) return
      if (send(target.port ? "swap" : "bind", { provider: target.provider, account: target.account, port: target.port, node: chosen.name }, `正在将 ${target.title || target.account} 连接到 ${chosen.name}`)) close()
    })
    confirm.dataset.mutation = ""; confirm.setAttribute("aria-label", target.port ? "确认换绑" : "确认绑定")
    const bar = dialogBar([["关闭", "secondary", close]], choice)
    if (binding) bar.append(confirm)
    editor.append(bar)
    function availability() {
      const occupied = new Map(), spares = new Set((snapshot.egress?.spares || []).map((spare) => spare.node))
      for (const [port, assignment] of Object.entries(snapshot.egress?.assignments || {})) if (Number(port) !== Number(target.port)) occupied.set(assignment.node, { port })
      for (const provider of snapshot.providers || []) for (const account of provider.accounts || []) {
        // 多出口账号的每个出口都占着一个节点
        for (const exit of exitsOf(account).length ? account.exits : [account]) {
          if (exit.node && exit.port && Number(exit.port) !== Number(target.port)) occupied.set(exit.node, { port: exit.port, provider: provider.name, account: account.alias || account.label })
        }
      }
      return { occupied, spares }
    }
    function inspect() {
      const node = nodes.find((item) => item.name === selected), { occupied, spares } = availability()
      for (const row of list.querySelectorAll(".node-option")) row.setAttribute("aria-pressed", String(row.dataset.node === selected))
      const testingFocused = document.activeElement?.classList.contains("node-test-button")
      inspector.replaceChildren()
      const back = btn("button quiet small inspector-back", "返回节点列表", () => { workspace.dataset.mobilePanel = "list"; [...list.querySelectorAll(".node-option")].find((row) => row.dataset.node === selected)?.focus({ preventScroll: true }) })
      back.prepend(icon("chevron", 14)); inspector.append(back)
      if (!node) {
        inspector.append(icon("eye", 24), el("h3", "", "选择一个节点"), el("p", "hint", "点击列表查看延迟、来源、出口 IP 和占用情况。"))
        confirm.dataset.unavailable = "true"; choice.textContent = binding ? "先查看详情，再确认切换" : "未测试的节点不会显示为可达"; syncBusy(); return
      }
      const state = nodeTestState(node), test = node.test, owner = occupied.get(node.name), isCurrent = node.name === target.current
      const heading = el("div", "node-inspector-head"), name = el("h3", "", node.name)
      const badge = el("span", "status-badge " + state.tone, state.label)
      heading.append(name, badge); inspector.append(heading)
      const metrics = el("div", "node-metrics")
      for (const [label, value] of [["TLS 连接", state.latency], ["请求总耗时", state.totalMs === null ? "—" : `${state.totalMs.toLocaleString()} ms`]]) {
        const metric = el("div"); metric.append(el("strong", "mono", value), el("span", "", label)); metrics.append(metric)
      }
      inspector.append(metrics)
      if (state.stale) inspector.append(el("p", "node-history-note", "这是 1 小时前的历史结果，可重新测试确认当前质量。"))
      const details = el("dl", "node-details")
      const status = !test ? "未测试" : test.code === "401" ? "HTTP 401 · API 可达" : test.code === "405" ? "HTTP 405 · ZCode 拦截" : test.code === "000" ? "未收到 HTTP 响应" : test.code ? `HTTP ${test.code}` : state.detail
      for (const [label, value] of [["来源", node.src === "pool" ? "手动号池" : sourceNames().get(node.subscriptionId) || "机场订阅"], ["协议", (node.type || "未知").toUpperCase()], ["节点地址", node.server ? `${node.server}${node.port ? ":" + node.port : ""}` : "未提供"], ["公网出口 IP", test?.ip || "尚未测得"], ["目标响应", status], ["测试时间", test?.checkedAt ? `${when(test.checkedAt)} · ${age(test.checkedAt)}` : "尚无记录"], ["记录来源", { manual: "手动测试", selection: "自动选路", health: "定期体检" }[test?.source] || "—"]]) {
        const valueNode = el("dd", label === "节点地址" || label === "公网出口 IP" ? "mono" : "", value)
        valueNode.title = value; details.append(el("dt", "", label), valueNode)
      }
      inspector.append(details)
      const note = el("div", "node-binding-note", owner ? `已由 ${owner.provider || "其他账号"}${owner.account ? " / " + owner.account : ""} 使用（:${owner.port}）` : isCurrent ? "这是该账号当前使用的节点" : spares.has(node.name) ? "已加载的备用节点，可直接换位" : "空闲候选，确认换绑时会加载节点配置")
      note.prepend(icon(owner ? "users" : isCurrent ? "check" : "info", 15)); inspector.append(note)
      const testButton = actionButton("测试此节点", "probe-nodes", { names: [node.name] }, "button secondary node-test-button")
      testButton.prepend(icon("activity", 16)); inspector.insertBefore(testButton, metrics)
      if (testingFocused) testButton.focus({ preventScroll: true })
      inspector.append(el("p", "node-method", "通过代理测试 ZCode API。TLS 为 HTTPS 连接建立耗时；总耗时包含本次请求。401 表示 API 可达，其他供应商的可达性可能不同。"))
      confirm.dataset.unavailable = String(!node || !!owner || isCurrent)
      confirm.textContent = owner ? "节点已占用" : isCurrent ? "当前节点" : target.port ? "确认换绑" : "确认绑定"
      choice.textContent = binding ? owner ? "该节点已被占用，可查看或测试" : isCurrent ? "当前绑定保持不变" : `已选：${node.name}${!state.measured ? " · 尚未测试" : state.stale ? " · 历史结果" : ""}` : `正在查看：${node.name}`
      choice.title = choice.textContent; syncBusy()
    }
    function choose(name) {
      selected = name; inspect()
      if (matchMedia("(max-width: 700px)").matches) { workspace.dataset.mobilePanel = "detail"; inspector.scrollTop = 0; inspector.querySelector(".inspector-back")?.focus({ preventScroll: true }) }
    }
    function draw(force = false) {
      const { occupied, spares } = availability(), query = search.value.trim().toLowerCase(), sources = sourceNames()
      const signature = JSON.stringify([nodes, [...occupied], [...spares], region, source, order, limit, onlyAvailable, query, Math.floor(Date.now() / 60_000)])
      if (!force && signature === lastDraw) return
      lastDraw = signature
      visible = sortNodes(nodes, { order, occupied, spares }).filter((node) => (!region || regionOf(node.name) === region) && (!source || (source === "pool" ? node.src === "pool" : node.subscriptionId === source)) && (!onlyAvailable || !occupied.has(node.name)) && (!query || `${node.name} ${node.type || ""} ${node.server || ""} ${sources.get(node.subscriptionId) || ""}`.toLowerCase().includes(query)))
      const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.node : null, scroll = list.scrollTop
      list.replaceChildren()
      if (!visible.length) list.append(el("div", "node-empty", "没有匹配的节点，试试调整筛选条件"))
      for (const node of visible.slice(0, limit)) {
        const row = btn("node-option", "", () => choose(node.name)), state = nodeTestState(node), owner = occupied.get(node.name)
        row.dataset.node = node.name; row.setAttribute("aria-label", `查看节点 ${node.name}`)
        const info = el("span", "node-option-info"), name = el("span", "node-option-name", node.name)
        name.title = node.name
        info.append(name, el("small", "", `${node.src === "pool" ? "手动号池" : sources.get(node.subscriptionId) || "机场订阅"} · ${(node.type || "未知协议").toUpperCase()}`))
        const metric = el("span", "node-latency " + state.tone)
        metric.append(el("strong", "mono", state.measured ? state.latency : "未测试"), el("small", "", state.stale ? "历史结果" : state.measured ? state.label : "可单独测试"))
        const usage = el("span", "node-availability", owner ? "已占用" : node.name === target.current ? "当前" : spares.has(node.name) ? "备用" : "候选")
        row.append(el("span", "region-tag", regionOf(node.name) || "—"), info, usage, metric)
        list.append(row)
      }
      if (visible.length > limit) list.append(btn("load-more", `再显示 ${Math.min(50, visible.length - limit)} 个`, () => { const next = limit; limit += 50; draw(); list.querySelectorAll(".node-option")[next]?.focus() }))
      count.textContent = `${visible.length} 个匹配 · 已显示 ${Math.min(limit, visible.length)} 个`
      batch.dataset.unavailable = String(!visible.length)
      batch.title = `测试当前筛选中的前 ${Math.min(20, visible.length)} 个节点`
      batch.lastElementChild.textContent = visible.length > 20 ? "测试前 20 个节点" : `测试 ${visible.length} 个节点`
      list.scrollTop = scroll
      if (focused) [...list.querySelectorAll(".node-option")].find((row) => row.dataset.node === focused)?.focus({ preventScroll: true })
      inspect()
    }
    const filterChanged = () => { limit = 50; workspace.dataset.mobilePanel = "list"; draw(); list.scrollTop = 0 }
    search.oninput = filterChanged
    available.onchange = () => { onlyAvailable = available.checked; filterChanged() }
    sourceFilter.onchange = () => { source = sourceFilter.value; filterChanged() }
    sort.onchange = () => { order = sort.value; filterChanged() }
    regionFilter.onchange = () => { region = regionFilter.value; filterChanged() }
    search.onkeydown = (event) => {
      const rows = [...list.querySelectorAll(".node-option")]
      if (event.key === "ArrowDown" || event.key === "Enter" && rows.length === 1) { event.preventDefault(); rows[0]?.focus(); if (rows[0]) choose(rows[0].dataset.node) }
    }
    list.onkeydown = (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
      const rows = [...list.querySelectorAll(".node-option")], at = rows.indexOf(document.activeElement)
      if (at < 0) return
      event.preventDefault()
      if (event.key === "ArrowUp" && at === 0) { search.focus(); return }
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))
      rows[next]?.focus(); if (rows[next]) choose(rows[next].dataset.node)
    }
    dialogOnSnapshot = (latest) => { snapshot = latest; nodes = latest.nodes || []; draw() }
    draw(true)
  }, { wide: true, kind: "picker" })
}
function accountDialog(account, provider) {
  openDialog((editor, close) => {
    editor.append(dialogHead("shield", "账号连接详情", close))
    const state = accountState(account), heading = el("div", "account-detail-heading")
    heading.append(el("h3", "", account.alias || account.label), el("span", "status-badge " + state.tone, state.label), el("p", "hint", state.detail))
    editor.append(heading)
    const details = el("dl", "detail-list"), exits = exitsOf(account)
    const pick = (exit) => { close(); pickNodeDialog({ provider: provider.id, account: account.id, port: exit.port, current: exit.node, title: `${account.alias || account.label} :${exit.port}` }) }
    for (const [label, value] of [["供应商", provider.name], ["账号", account.label || account.id], [exits.length ? "主出口节点" : "连接节点", account.node || "未分配"], ["公网出口 IP", account.ip || "尚未获取"], ["本地代理", proxyAddress(account) || "未绑定"], ["绑定方式", { manual: "手动指定", auto: "自动分配", migrated: "继承已有配置" }[account.mode] || "—"], ["最近体检", when(account.lastChecked || getSnapshot()?.egress?.lastCheck)]]) {
      const valueNode = el("dd", label.includes("IP") || label === "本地代理" ? "mono" : "", value)
      if (label === "本地代理" && account.port) valueNode.append(iconButton("copy", "复制本地代理地址", () => copyText(proxyAddress(account), "本地代理地址已复制")))
      if (label === "公网出口 IP" && account.ip) valueNode.append(iconButton("copy", "复制公网出口 IP", () => copyText(account.ip, "出口 IP 已复制")))
      details.append(el("dt", "", label), valueNode)
    }
    editor.append(details, el("p", "hint", exits.length
      ? `本地代理是分流入口：magpie 把这个账号的流量交给它，再由它分到下面 ${exits.length} 个出口。领取等需要固定 IP 的操作只走主出口。`
      : "本地代理地址用于这台机器上的应用；公网出口 IP 是外部服务看到的地址。"))
    if (exits.length) {
      const list = el("ul", "exit-list"); list.setAttribute("aria-label", "出口列表")
      for (const exit of exits) {
        const item = el("li", "exit-item"), name = el("span", "exit-node", exit.node || "未分配")
        name.title = exit.node || ""
        const swap = iconButton("swap", `为出口 :${exit.port} 更换节点`, () => pick(exit))
        item.append(el("i", "status-dot " + (exit.ip ? "ok" : "bad")), el("span", "region-tag", regionOf(exit.node || "") || "NODE"), name)
        if (exit.primary) item.append(el("span", "exit-tag", "主"))
        item.append(el("span", "exit-ip mono", exit.ip || "未探测到 IP"), el("span", "exit-port mono muted", `:${exit.port}`), swap)
        list.append(item)
      }
      editor.append(list)
    }
    if (account.port) {
      // 单 Key 多出口：同一个账号/Key 挂多个出口，magpie 侧仍只有一条代理。
      const panel = el("div", "exit-controls"), count = el("select"), strategy = el("select")
      const current = exits.length || 1
      for (let n = 1; n <= MAX_EXITS; n++) { const option = el("option", "", n === 1 ? "1 个（单出口）" : `${n} 个`); option.value = String(n); count.append(option) }
      count.value = String(current)
      for (const [value, label] of Object.entries(STRATEGY_LABELS)) { const option = el("option", "", label); option.value = value; strategy.append(option) }
      strategy.value = account.strategy && STRATEGY_LABELS[account.strategy] ? account.strategy : "round-robin"
      const apply = btn("button secondary small", "应用", () => {
        const next = Number(count.value)
        if (send("exits", { provider: provider.id, account: account.id, count: next, ...(next > 1 ? { strategy: strategy.value } : {}) }, next > 1 ? `正在为 ${account.alias || account.label} 准备 ${next} 个出口` : `正在将 ${account.alias || account.label} 改回单出口`)) close()
      })
      apply.dataset.mutation = ""
      const sync = () => {
        const next = Number(count.value)
        strategy.disabled = next < 2
        apply.disabled = next === current && (next < 2 || strategy.value === (account.strategy || "round-robin"))
      }
      count.onchange = strategy.onchange = sync; sync()
      panel.append(field("出口数量", count), field("分流方式", strategy), apply)
      editor.append(panel, el("p", "hint", "多出口会为这个账号多占用几个节点，每个出口都照常体检并在异常时自动更换。轮询按「新连接」切换出口，复用中的长连接不会中途换出口。"))
    }
    const actions = []
    if (account.port) actions.push(["解除绑定", "quiet danger", () => {
      close(); confirmDialog("解除账号绑定", `将解除 ${account.alias || account.label} 的出口绑定并释放${exits.length ? `全部 ${exits.length} 个出口` : "端口"}。若开启自动分配，下轮体检可能重新分配。`, "解除绑定", () => send("unbind", { provider: provider.id, account: account.id }), true)
    }])
    actions.push(["关闭", "secondary", close], [account.node ? exits.length ? "更换主出口" : "更换节点" : "选择节点", "primary",() => { close(); pickNodeDialog({ provider: provider.id, account: account.id, port: account.port, current: account.node, title: account.alias || account.label }) }])
    editor.append(dialogBar(actions))
  })
}
function settingsDialog(snapshot = getSnapshot() || {}, initialTab = "providers", initialSearch = "") {
  const { config = {}, providers = [], onboard = {} } = snapshot || {}
  openDialog((editor, close) => {
    editor.append(dialogHead("cog", "工作台设置", close))
    const tabs = el("div", "settings-tabs segments"), body = el("div", "settings-body"), panels = new Map(), inputs = []
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "设置分区")
    const error = el("p", "field-error"); error.hidden = true; error.setAttribute("role", "alert")
    const changed = el("span", "hint grow")
    const setTab = (key) => {
      for (const [id, panel] of panels) panel.hidden = id !== key
      for (const button of tabs.children) { const active = button.dataset.section === key; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1 }
      body.scrollTop = 0
    }
    for (const [key, name, glyph] of [["providers", "供应商", "providers"], ["health", "体检", "activity"], ["claims", "领取计划", "clock"], ["advanced", "维护", "cog"]]) {
      const panel = el("section", "settings-panel"), button = btn("segment", "", () => setTab(key))
      panel.id = "settings-panel-" + key; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", "settings-tab-" + key)
      button.id = "settings-tab-" + key; button.dataset.section = key; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", panel.id)
      button.append(icon(glyph, 15), el("span", "", name)); tabs.append(button); panels.set(key, panel); body.append(panel)
    }
    tabs.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
      const buttons = [...tabs.children], at = buttons.indexOf(document.activeElement)
      if (at < 0) return
      event.preventDefault()
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length
      buttons[next].focus(); setTab(buttons[next].dataset.section)
    }
    const group = (key, title, hint) => { const panel = panels.get(key); panel.append(el("h3", "", title), el("p", "hint", hint)); return panel }
    const numbers = (container, label, key, min, max, unit) => {
      const input = el("input"); input.type = "number"; input.min = min; input.max = max; input.step = 1; input.value = config[key] ?? min
      input.dataset.key = key; input.dataset.was = input.value; inputs.push(input)
      container.append(field(`${label}（${unit}）`, input))
    }
    const scope = group("providers", "管理哪些供应商", "勾选后可分配独立出口，取消勾选会保留已有绑定。")
    const searchWrap = el("div", "search-input"), search = el("input")
    search.type = "search"; search.placeholder = "搜索供应商名称或 ID…"; search.setAttribute("aria-label", "搜索供应商范围"); search.value = initialSearch; search.autocomplete = "off"
    searchWrap.append(icon("search"), search); scope.append(searchWrap)
    const providerList = el("div", "provider-checks"), rows = []
    for (const provider of providers) {
      const label = el("label", "provider-check"), input = el("input"), name = el("span", "provider-check-name")
      input.type = "checkbox"; input.value = provider.id; input.checked = !!provider.managed
      name.append(el("strong", "", provider.name), el("small", "", `${provider.accounts.length} 个账号 · ${KIND_TEXT[provider.kind] || provider.kind}`))
      label.append(input, icon(provider.kind === "keys" ? "key" : "users", 17), name)
      rows.push({ label, input, match: `${provider.name} ${provider.id}`.toLowerCase() }); providerList.append(label)
    }
    const empty = el("p", "hint", providers.length ? "没有匹配的供应商" : "请先在 magpie 添加供应商账号或 API Key。")
    providerList.append(empty)
    const counter = el("span", "hint grow"), selection = el("div", "provider-selection-tools")
    counter.setAttribute("role", "status")
    const selectMatches = btn("button quiet small", "选择搜索结果", () => { for (const row of rows) if (!row.label.hidden) row.input.checked = true; updateProviders(); markDirty() })
    const clearMatches = btn("button quiet small", "清除搜索结果", () => { for (const row of rows) if (!row.label.hidden) row.input.checked = false; updateProviders(); markDirty() })
    selection.append(counter, selectMatches, clearMatches)
    const updateProviders = () => {
      const query = search.value.trim().toLowerCase()
      for (const row of rows) row.label.hidden = !row.match.includes(query)
      const matches = rows.filter((row) => !row.label.hidden).length
      counter.textContent = `已选 ${rows.filter((row) => row.input.checked).length} / ${rows.length} 个${query ? ` · 匹配 ${matches} 个` : ""}`
      empty.hidden = matches > 0; selectMatches.disabled = clearMatches.disabled = !matches
    }
    search.oninput = updateProviders
    scope.append(selection, providerList)
    const autoLabel = el("label", "checkbox-row"), auto = el("input"); auto.type = "checkbox"; auto.checked = config.autoAssignNew !== false
    autoLabel.append(auto, el("span", "", "发现新账号时自动分配出口")); scope.append(autoLabel)
    const health = group("health", "体检与备用", "定期检查出口连通性，异常时用不同 IP 的备用节点接替。"), healthFields = el("div", "settings-grid")
    numbers(healthFields, "体检间隔", "checkIntervalMin", 2, 180, "分钟"); numbers(healthFields, "备用出口", "sparesCount", 2, 40, "个"); health.append(healthFields)
    const claim = group("claims", "自动领取计划", "以下时刻使用北京时间（UTC+8），支持跨午夜窗口。"), claimFields = el("div", "settings-grid")
    numbers(claimFields, "开始小时", "claimHour", 0, 23, "点"); numbers(claimFields, "开始分钟", "claimMinute", 0, 59, "分")
    numbers(claimFields, "持续时长", "claimWindowHours", 1, 24, "小时"); numbers(claimFields, "检查间隔", "claimIntervalMin", 2, 180, "分钟"); claim.append(claimFields)
    const advanced = group("advanced", "连接与维护", "同步可修正 magpie 中的代理映射，重新挑选会改变现有出口。")
    const backend = el("select")
    for (const [value, label] of [["auto", "自动选择"], ["binary", "独立内核"], ...(!snapshot.runtime?.platform || snapshot.runtime.platform === "linux" ? [["docker", "Docker（Linux）"]] : [])]) {
      const option = el("option", "", label); option.value = value; backend.append(option)
    }
    backend.value = config.backend || "auto"; backend.dataset.key = "backend"; backend.dataset.was = backend.value; inputs.push(backend)
    advanced.append(field("运行方式", backend, "Windows 和 macOS 的自动模式使用独立内核，首次使用时下载。"))
    const mirror = el("input"); mirror.type = "url"; mirror.value = config.mirror || ""; mirror.placeholder = "https://…（可留空）"; mirror.autocomplete = "off"
    mirror.dataset.key = "mirror"; mirror.dataset.was = mirror.value; inputs.push(mirror)
    advanced.append(field("下载加速前缀", mirror, "用于下载 mihomo 内核。"))
    const path = el("p", "hint", "配置目录："); path.append(el("code", "", onboard.baseDir || "自动选择")); advanced.append(path)
    if (snapshot.runtime) {
      const runtime = snapshot.runtime
      advanced.append(el("p", "hint", `运行环境：${runtime.platform} / ${runtime.arch} · ${runtime.coreInstalled ? "mihomo 已安装" : "首次分配时下载 mihomo"}`))
      advanced.append(el("p", "hint", `自动领取浏览器：${runtime.browser ? runtime.displayReady ? "已就绪" : "需要图形环境或 Xvfb" : "未找到 Chrome / Edge；不影响出口管理"}`))
      for (const [label, value] of [["magpie 数据", runtime.magpieDir], ["插件数据", runtime.dataDir]]) {
        const row = el("p", "hint", label + "："); row.append(el("code", "", value)); advanced.append(row)
      }
    }
    const maintenance = el("div", "maintenance-actions")
    maintenance.append(actionButton("同步现有绑定", "sync"), btn("button quiet danger small", "重新挑选全部出口", () => { close(); reseedConfirm() }))
    advanced.append(maintenance)
    const markDirty = () => { changed.textContent = "更改尚未保存" }
    body.addEventListener("change", (event) => { if (event.target !== search) markDirty(); updateProviders() })
    body.addEventListener("input", (event) => { if (event.target !== search) markDirty() })
    const save = () => {
      let first = null, message = ""
      for (const input of inputs) {
        const value = input.value.trim()
        let bad = input.type === "number" && (input.validity.badInput || !value || !Number.isInteger(Number(value)) || Number(value) < Number(input.min) || Number(value) > Number(input.max))
        if (input.type === "url" && value) { try { if (!/^https?:$/.test(new URL(value).protocol) || /\s/.test(value)) throw new Error() } catch { bad = true } }
        input.setAttribute("aria-invalid", String(bad))
        if (bad && !first) { first = input; message = input.type === "number" ? `${input.labels[0]?.textContent}需为 ${input.min}–${input.max} 的整数` : "下载加速前缀需要完整的 http:// 或 https:// 地址" }
      }
      if (first) {
        error.hidden = false; error.textContent = message; first.setAttribute("aria-errormessage", error.id ||= "settings-error")
        setTab(first.closest(".settings-panel").id.replace("settings-panel-", "")); first.focus(); return
      }
      error.hidden = true
      const patch = {}
      for (const input of inputs) if (input.value.trim() !== input.dataset.was) patch[input.dataset.key] = input.type === "number" ? Number(input.value) : input.value.trim()
      if (auto.checked !== (config.autoAssignNew !== false)) patch.autoAssignNew = auto.checked
      const selected = rows.filter((row) => row.input.checked).map((row) => row.input.value), previous = providers.filter((p) => p.managed).map((p) => p.id)
      if (JSON.stringify(selected) !== JSON.stringify(previous)) patch.managedProviders = [...new Set([...(Array.isArray(config.managedProviders) ? config.managedProviders.filter((id) => !providers.some((p) => p.id === id)) : []), ...selected])]
      if (!Object.keys(patch).length) { close(); toast("设置没有变化"); return }
      if (send("config", patch)) close()
    }
    for (const input of inputs) input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); save() } }
    const bar = dialogBar([["取消", "secondary", close], ["保存设置", "primary", save]], changed)
    bar.prepend(error)
    editor.append(tabs, body, bar); updateProviders(); setTab(panels.has(initialTab) ? initialTab : "providers")
  }, { kind: "settings" })
}
function confirmDialog(title, description, label, go, danger = false) {
  openDialog((editor, close) => {
    editor.append(dialogHead(danger ? "warn" : "refresh", title, close), el("p", "confirm-copy", description))
    const bar = dialogBar([["取消", "secondary", close], [label, danger ? "primary danger" : "primary", () => { if (go() !== false) close() }]])
    bar.querySelector("button").dataset.autofocus = ""
    editor.append(bar)
  })
}
function reseedConfirm() {
  confirmDialog("重新挑选全部出口", "此操作会重新分配所有受管账号的节点并改变出口 IP。仅需补齐未绑定账号时，请使用工作台上的「分配出口」。", "重新挑选", () => send("seed"), true)
}

function tick() {
  const snapshot = getSnapshot(), at = snapshot?.updated || window.__ZE__?.updated
  const stale = !!at && (Date.now() - at > 90_000 || !!lastReadError), connection = $("connection")
  const label = !at ? "等待连接" : stale ? "数据待更新" : "实时同步"
  if (connection.lastElementChild.textContent !== label) connection.lastElementChild.textContent = label
  connection.className = "connection " + (!at || stale ? "warn" : "ok")
  connection.title = at ? `上次更新：${when(at)}（北京时间）` : "后台服务尚未提供快照"
  $("foot-mut").textContent = at ? `${age(at)}更新 · v${snapshot?.version?.plugin || "—"}` : "等待后台数据"
  const notice = $("stale-notice")
  const missing = !at && Date.now() - openedAt > 12000
  notice.hidden = !stale && !missing
  if (missing) notice.querySelector("span").textContent = "后台尚未提供数据。请点击重新读取；仍无法连接时，在插件目录运行 Open.cmd 或 Diagnose.cmd。"
  else if (stale) notice.querySelector("span").textContent = lastReadError ? "后台连接暂时中断，当前显示上次记录。请重新读取，或运行 Open.cmd 恢复连接。" : `数据已 ${age(at).replace("前", "")}未更新，当前显示上次记录。`
  for (const telemetry of document.querySelectorAll(".node-telemetry")) {
    const node = nodeIndex.get(telemetry.dataset.node), test = nodeTestState(node)
    const label = test.measured ? `TLS ${test.latency}${test.stale ? " · 历史" : ""}` : "尚无延迟记录"
    if (telemetry.textContent !== label) telemetry.textContent = label
  }
  syncBusy()
}
function heartbeat(force = false) {
  const persistPreferences = preferenceRevision > savedPreferenceRevision
  if (document.visibilityState === "hidden" || pending || heartbeatWriting || !window.magpie?.options?.set || !force && !persistPreferences && Date.now() - hbAt < 5 * 60_000) return
  hbAt = Date.now(); heartbeatId = "p-" + hbAt + "-" + Math.random().toString(36).slice(2, 8)
  const revision = preferenceRevision
  const options = { request: { id: heartbeatId, action: "page-seen", wake: force } }
  // The actual plugin frame has no localStorage. Save display preferences
  // alongside the normal heartbeat, so this never resubmits an old operation.
  if (persistPreferences) options.pagePreferences = { density: view.density, showProviders: view.showProviders }
  heartbeatWriting = true
  const failed = () => { heartbeatId = null; heartbeatWriting = false }
  try {
    Promise.resolve(window.magpie.options.set(options)).then(() => {
      if (persistPreferences) savedPreferenceRevision = revision
      heartbeatWriting = false
      if (preferenceRevision > savedPreferenceRevision) {
        clearTimeout(preferenceTimer); preferenceTimer = setTimeout(() => heartbeat(), 180)
      }
    }, failed)
  } catch { failed() }
}
async function restorePagePreferences() {
  if (!window.magpie?.options?.get) return
  try {
    await window.magpie.ready
    const saved = (await window.magpie.options.get())?.pagePreferences
    if (!saved || typeof saved !== "object") return
    const before = [view.density, view.showProviders]
    if (!changedPreferences.has("density") && ["comfortable", "compact", "grid"].includes(saved.density)) view.density = saved.density
    if (!changedPreferences.has("showProviders") && typeof saved.showProviders === "boolean") view.showProviders = saved.showProviders
    if (view.density !== before[0] || view.showProviders !== before[1]) render(getSnapshot(), true)
  } catch { /* the local preference or the default still works */ }
}
function scheduleRead(delay = 5000) {
  clearTimeout(pollTimer)
  if (document.visibilityState !== "hidden") pollTimer = setTimeout(readData, delay)
}
function readData() {
  if (readInFlight || document.visibilityState === "hidden") return
  readInFlight = true
  const script = document.createElement("script"), previous = window.__ZE__
  if (!window.EgressService) script.src = "data.js?t=" + Date.now()
  let done = false
  const finish = (loaded) => {
    if (done) return; done = true
    clearTimeout(timeout); script.remove(); readInFlight = false
    if (loaded) {
      lastReadError = ""
      if ((window.__ZE__?.snapshot?.updated || 0) < (previous?.snapshot?.updated || 0)) window.__ZE__ = previous
      noteRequests(getSnapshot())
      try { render(getSnapshot()) } catch (error) { console.error(error); toast("页面数据暂时无法显示，请刷新重试", "err") }
    } else tick()
    heartbeat(); scheduleRead(pending ? 2000 : 5000)
  }
  const timeout = setTimeout(() => finish(false), 12_000)
  script.onload = () => finish(true); script.onerror = () => finish(false)
  if (window.EgressService) {
    window.EgressService.readSnapshot().then((value) => { if (!done) { window.__ZE__ = value; finish(true) } }, (error) => { lastReadError = error.message; finish(false) })
  } else document.head.append(script)
}
function refreshData() { heartbeat(true); readData() }
document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-act]")?.dataset.act
  if (action === "settings") settingsDialog()
  else if (action === "check") send("check")
  else if (action === "assign") send("assign", view.tab === "egress" && view.provider ? { provider: view.provider } : {})
  else if (action === "refresh") refreshData()
  const tab = event.target.closest("[data-tab]")?.dataset.tab
  if (tab) switchTab(tab)
})
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  const tabs = [...document.querySelectorAll("[data-tab]")].filter((tab) => !tab.hidden), at = tabs.indexOf(document.activeElement)
  if (at < 0) return
  event.preventDefault()
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
  tabs[next].focus(); switchTab(tabs[next].dataset.tab)
})
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !closeDialog && !event.ctrlKey && !event.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    event.preventDefault(); switchTab("egress"); document.querySelector('[data-focus-key="account-search"]')?.focus()
  }
})
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") clearTimeout(pollTimer); else refreshData() })
document.querySelector('[data-act="check"]').prepend(icon("activity"))
$("settings-button").prepend(icon("cog"))
$("provider-nav-toggle").append(icon("panel"))
function closeProviderMenu(focus = false) {
  if (!providerMenuOpen) return
  providerMenuOpen = false
  if (getSnapshot()) renderProviderSidebar(totals(getSnapshot()))
  if (focus) $("provider-nav-toggle").focus()
}
$("provider-nav-toggle").onclick = () => {
  if (narrowProviders.matches) providerMenuOpen = !providerMenuOpen
  else { view.showProviders = !view.showProviders; savePreference("showProviders", String(view.showProviders)) }
  render(getSnapshot(), true)
}
$("provider-nav-toggle").onkeydown = (event) => {
  if (!narrowProviders.matches || event.key !== "ArrowDown") return
  event.preventDefault(); providerMenuOpen = true; renderProviderSidebar(totals(getSnapshot()))
  const sidebar = $("provider-sidebar")
  const current = sidebar.querySelector('.provider-link[aria-pressed="true"]') || sidebar.querySelector(".provider-link")
  current?.focus()
}
$("provider-sidebar").onkeydown = (event) => {
  const links = [...$("provider-sidebar").querySelectorAll(".provider-link")], index = links.indexOf(document.activeElement)
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: links.length - 1 }[event.key]
  if (index < 0 || next === undefined) return
  event.preventDefault(); links[(next + links.length) % links.length].focus()
}
document.addEventListener("pointerdown", (event) => { if (!event.target.closest("#provider-sidebar, #provider-nav-toggle")) closeProviderMenu() })
document.addEventListener("focusin", (event) => { if (!event.target.closest("#provider-sidebar, #provider-nav-toggle")) closeProviderMenu() })
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && providerMenuOpen) { event.preventDefault(); closeProviderMenu(true) } })
narrowProviders.addEventListener("change", () => { providerMenuOpen = false; if (getSnapshot()) renderProviderSidebar(totals(getSnapshot())) })
for (const [tab, glyph] of [["egress", "logo"], ["sources", "cloud"], ["claims", "clock"]]) $("tab-" + tab).prepend(icon(glyph, 15))
// The host's documented action event includes the provider context.
window.magpie?.onAction?.((event) => {
  if (event?.id === "page-navigate") {
    const target = event.navigation?.id
    if (!["egress", "sources", "claims"].includes(target) && !(getSnapshot()?.providers || []).some((p) => p.managed && `provider:${p.id}` === target)) return
    if (closeDialog) closeDialog()
    if (target === "egress") selectProvider("")
    else if (target.startsWith("provider:")) selectProvider(target.slice("provider:".length))
    else { switchTab(target); window.scrollTo({ top: 0, behavior: "instant" }) }
    return
  }
  if (event?.id !== "open-egress") return
  const provider = event.provider?.id || ""
  if (closeDialog) closeDialog()
  selectProvider(provider)
  if (provider && !(getSnapshot()?.providers || []).some((p) => p.id === provider && p.managed)) settingsDialog(getSnapshot(), "providers", provider)
})
globalThis.EgressNavigation?.onConnection(() => { if (getSnapshot()) renderProviderSidebar(totals(getSnapshot())) })
noteRequests(getSnapshot()); render(getSnapshot()); scheduleRead(500)
restorePagePreferences()
setInterval(tick, 1000)
