import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reloadConfig, spawnMihomo } from "../lib/mihomo.mjs"

test("binary reload uses the native configuration path, including Chinese and spaces", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "出口 内核-")), paths = []
  t.after(() => rmSync(baseDir, { recursive: true, force: true }))
  writeFileSync(join(baseDir, "backend.json"), '{"backend":"binary"}')
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk }); req.on("end", () => { paths.push(JSON.parse(body).path); res.writeHead(204); res.end() })
  })
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
  t.after(() => { server.closeAllConnections(); server.close() })
  for (const name of ["zcode-egress", "zcode-probe"]) assert.equal(await reloadConfig(`http://127.0.0.1:${port}`, name, "/root/.config/mihomo/config.yaml", { baseDir }), true)
  assert.deepEqual(paths, [join(baseDir, "config", "config.yaml"), join(baseDir, "probe-config", "config.yaml")])
})
test("missing kernel is a caught startup error and does not publish a bogus PID", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-no-kernel-")); mkdirSync(join(root, "config"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await assert.rejects(spawnMihomo(root, "egress"), /ENOENT/)
  assert.equal(existsSync(join(root, "egress.pid")), false)
})
