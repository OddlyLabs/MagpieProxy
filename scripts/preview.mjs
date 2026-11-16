import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { demoSnapshot } from "./demo-data.mjs"
import { patchMagpieNavigation } from "../integrations/magpie/patch.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = Number(process.env.PREVIEW_PORT || 4177)
const files = new Map([
  ["/", ["page/index.html", "text/html"]], ["/index.html", ["page/index.html", "text/html"]],
  ...["app.js", "model.js", "icons.js", "navigation.js"].map((file) => [`/${file}`, [`page/${file}`, "text/javascript"]]),
  ["/style.css", ["page/style.css", "text/css"]], ["/icon.svg", ["page/icon.svg", "image/svg+xml"]],
  ["/_magpie/bridge.js", ["scripts/preview-bridge.js", "text/javascript"]],
  ["/host-preview.html", ["scripts/host-preview.html", "text/html"]],
  ["/host-preview.js", ["scripts/host-preview.js", "text/javascript"]],
  ["/host-preview.css", ["scripts/host-preview.css", "text/css"]],
  ["/host/navicons.js", ["test/fixtures/magpie/navicons.js", "text/javascript"]],
  ["/host/navigation.css", ["test/fixtures/magpie/navigation.css", "text/css"]],
  ["/host/menus.js", ["test/fixtures/magpie/menus.js", "text/javascript"]],
  ["/host/menus.css", ["test/fixtures/magpie/menus.css", "text/css"]],
])
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-Content-Type-Options", "nosniff")
    if (req.method !== "GET") { res.writeHead(405); res.end(); return }
    if (url.pathname === "/host-stock.html") {
      const html = await readFile(join(root, "scripts/host-preview.html"), "utf8")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html.replaceAll("宿主导航补丁预览", "原版宿主兼容预览").replace('src="/host/navigation.js"', 'src="/host/navigation.js?stock=1"').replace('src="/host/pluginpages.js"', 'src="/host/pluginpages.js?stock=1"'))
      return
    }
    if (["/host/pluginpages.js", "/host/navigation.js", "/host/egress-navigation.js"].includes(url.pathname)) {
      const [pluginpages, app] = await Promise.all([readFile(join(root, "test/fixtures/magpie/pluginpages.js"), "utf8"), readFile(join(root, "test/fixtures/magpie/navigation.js"), "utf8")])
      const patched = url.searchParams.has("stock") ? { pluginpages } : patchMagpieNavigation({ pluginpages, app })
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
      res.end(url.pathname.endsWith("navigation.js") && !url.pathname.endsWith("egress-navigation.js") ? app : url.pathname.endsWith("egress-navigation.js") ? patched["egress-navigation"] : patched.pluginpages)
      return
    }
    if (url.pathname.startsWith("/host-frame/")) {
      const file = url.pathname.slice("/host-frame/".length)
      if (["index.html", ""].includes(file)) {
        const html = await readFile(join(root, "page/index.html"), "utf8")
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'" })
        res.end(html.replace('<script src="_magpie/bridge.js">', '<script src="preview-bridge.js"></script><script src="_magpie/bridge.js">').replace('src="data.js"', `src="data.js?scenario=${encodeURIComponent(url.searchParams.get("scenario") || "providers")}"`))
        return
      }
      if (["_magpie/bridge.js", "preview-bridge.js"].includes(file)) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
        res.end(await readFile(join(root, file === "preview-bridge.js" ? "scripts/preview-bridge.js" : "test/fixtures/magpie/pagebridge.js")))
        return
      }
      url.pathname = "/" + file
    }
    if (url.pathname === "/data.js") {
      const scenario = url.searchParams.get("scenario") || new URL(req.headers.referer || "/", "http://localhost").searchParams.get("scenario") || "normal"
      // "waiting" is what the real service sends before its first snapshot (lib/dashboard.mjs).
      const snapshot = scenario === "waiting" ? null : demoSnapshot(scenario)
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
      res.end(`window.__ZE__ ||= ${JSON.stringify({ updated: snapshot?.updated || 0, snapshot })};\n${scenario === "stale" ? "" : "if (window.__ZE__.snapshot) window.__ZE__.snapshot.updated = window.__ZE__.updated = Date.now();"}`)
      return
    }
    const file = files.get(url.pathname)
    if (!file) { res.writeHead(404); res.end("Not found"); return }
    res.writeHead(200, { "Content-Type": file[1] + "; charset=utf-8" })
    res.end(await readFile(join(root, file[0])))
  } catch (error) { console.error(error); res.writeHead(500); res.end("Preview error") }
})
server.listen(port, "127.0.0.1", () => console.log(`Egress Manager demo: http://127.0.0.1:${port}\nFictional data only. Try ?theme=dark, ?scenario=empty, ?scenario=error or ?scenario=large.`))
process.on("SIGTERM", () => server.close())
process.on("SIGINT", () => server.close())
