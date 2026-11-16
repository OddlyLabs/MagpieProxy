// Minimal host services around the *original* pluginpages.js + navSubs code.
// Every API and account below is a fixture, never the running magpie.
var mode = "window", locale = "zh", web = true, view = "agents", pluginUpdates = 0
var params = new URLSearchParams(location.search)
const demoKey = "egress-preview", demoParts = new Map(), demoOptions = {}
if (!params.has("view")) params.set("view", demoKey)
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark"
if (params.get("nav") === "top") document.body.classList.remove("side-nav")
window.__hostPreview = { enabled: true, requests: [], errors: [] }
const $ = (selector) => document.querySelector(selector)
const el = (tag, className = "", text = "") => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node }
const t = (value) => ({ Plugins: "插件" }[value] || value)
const PUZZLE = "M3 3h10v10H3z"
function svg(path, size = 16, width = 1.6) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg"), shape = document.createElementNS(node.namespaceURI, "path")
  for (const [key, value] of Object.entries({ viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true" })) node.setAttribute(key, value)
  for (const [key, value] of Object.entries({ d: path, fill: "none", stroke: "currentColor", "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" })) shape.setAttribute(key, value)
  node.append(shape); return node
}
const sideNav = () => document.body.classList.contains("side-nav")
const NO_SCROLL = { preventScroll: true }, CHECK = "m3.5 8.5 3 3 6-7"
const popTop = (padding) => padding
let purposeUntil = 0, guardUntil = 0
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const scrollOnPurpose = () => true
const renderCrumb = () => {}
const statusErr = (error) => window.__hostPreview.errors.push(String(error))
const dragRows = () => false
const toneCheck = (img) => { img.style.width = "100%"; img.style.height = "100%" }
async function show(key) {
  if (key !== view) demoParts.get(view)?.leave?.()
  view = key
  for (const section of document.querySelectorAll("#preview-main > section")) section.hidden = section.id !== `view-${key}`
  for (const button of document.querySelectorAll("#nav > [data-view]")) button.classList.toggle("on", button.dataset.view === key)
  navSubs()
  return demoParts.get(key)?.open?.()
}
const magpie = {
  plugin(_name, setup) { setup({
    slots: { add(_slot, part) {
      demoParts.set(part.key, part)
      const section = el("section"); section.id = `view-${part.key}`; section.hidden = true
      $("#preview-main").append(section); part.mount(section)
    } },
    broke(key, error) { window.__hostPreview.errors.push(`${key}: ${error.message}`) },
  }) },
  page: (key) => demoParts.get(key),
}
async function api(path, body) {
  if (path === "plugin-pages") return window.__hostPreview.enabled ? [{
    key: demoKey, spec: "local-egress-fixture", name: "出口管家", title: "出口管家", icon: "/icon.svg", reads: [], keepAlive: true,
    url: `/host-frame/index.html?scenario=${encodeURIComponent(params.get("scenario") || "providers")}&theme=${params.get("theme") === "dark" ? "dark" : "light"}`,
    actions: [{ id: "open-egress", menu: "provider", title: "打开出口管家" }],
  }] : []
  if (path === "plugin-panels") return []
  if (path === "plugin-pages/options") {
    if (body?.options) {
      Object.assign(demoOptions, body.options)
      if (body.options.request) {
        window.__hostPreview.requests.push(body.options.request)
        $(".plugin-frame")?.contentWindow.postMessage({ egressPreview: 1, request: body.options.request }, "*")
      }
    }
    return { ...demoOptions }
  }
  throw new Error(`Unmocked preview API: ${path}`)
}
$("#nav > [data-view=usage]").prepend(EgressIcons.create("gauge", 16))
$("#nav > [data-view=usage]").onclick = () => show("usage")
for (const button of $("#usageTab").children) button.onclick = () => {
  for (const other of $("#usageTab").children) other.classList.toggle("on", other === button)
  navSubs()
}
