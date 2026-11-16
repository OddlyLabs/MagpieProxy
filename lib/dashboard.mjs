import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "page")
const assets = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ...["app.js", "model.js", "icons.js", "navigation.js"].map((file) => [`/${file}`, [file, "text/javascript"]]),
  ["/_magpie/bridge.js", ["service-bridge.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]], ["/icon.svg", ["icon.svg", "image/svg+xml"]],
])

export function serveDashboard(req, res, path, token) {
  const asset = assets.get(path)
  if (req.method !== "GET" || (!asset && path !== "/data.js")) return false
  const origin = `http://${req.headers.host}`
  const headers = {
    "Content-Type": `${asset?.[1] || "text/javascript"}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'self' ${origin}; style-src 'self' ${origin} 'unsafe-inline'; img-src 'self' ${origin} data:; connect-src 'self' ${origin}; base-uri 'none'; object-src 'none'`,
  }
  let body = path === "/data.js" ? "window.__ZE__ ||= { snapshot: null, updated: 0 };\n" : readFileSync(join(page, asset[0]), "utf8")
  // The session token lives in HTML, which other sites cannot read or execute
  // as JavaScript. A sandbox's Origin:null API calls must present it.
  if (asset?.[0] === "index.html") body = body.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta name="egress-session" content="${token}">`)
  res.writeHead(200, headers); res.end(body)
  return true
}
