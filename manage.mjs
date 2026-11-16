#!/usr/bin/env node
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { ensureService, inspectService } from "./lib/service.mjs"
import { dataDir, loadConfig, resolveBaseDir } from "./lib/store.mjs"
import { magpieDir } from "./lib/accounts.mjs"
import { PLUGIN_VERSION, GEN } from "./lib/gen.mjs"
import { binPath } from "./lib/mihomo.mjs"
import { chromePath, displayReady } from "./lib/captcha.mjs"
import { readJson as read } from "./lib/files.mjs"
import { findRegistration } from "./lib/platform.mjs"

const root = dirname(fileURLToPath(import.meta.url))
const install = read(join(root, "installation.json"), {})
if (!process.env.ZCODE_EGRESS_MAGPIE_DIR && install.magpieDir) process.env.ZCODE_EGRESS_MAGPIE_DIR = install.magpieDir
const command = process.argv[2] || "doctor", json = process.argv.includes("--json")
const report = (value) => console.log(json ? JSON.stringify(value) : value)

async function current() {
  const pid = read(join(dataDir(), "sidecar.pid"))
  const status = pid && await inspectService(pid.port)
  return status && pid && status.pid === pid.pid && (!status.dataDir || status.dataDir === dataDir()) ? status : null
}
async function openBrowser(url) {
  const [program, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, windowsHide: true, stdio: "ignore" })
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve() })
  })
}
async function main() {
  if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node.js 22+ 或 magpie 自带的 Bun；请运行 Install.cmd / Open.cmd")
  if (command === "open") {
    const status = await ensureService({ magpieDirectory: magpieDir() })
    const url = `http://127.0.0.1:${status.port}/`
    if (!process.argv.includes("--no-browser")) {
      try { await openBrowser(url) } catch { if (!json) console.log("浏览器未能自动打开，请复制下面的网址：") }
    }
    report(json ? { ok: true, url, port: status.port, pid: status.pid, dataDir: dataDir() } : `出口管家 v${PLUGIN_VERSION}\n${url}`)
  } else if (command === "status") {
    const status = await current()
    report({ ok: true, running: !!status?.running, available: !!status, port: status?.port || null, dataDir: dataDir() })
  } else if (command === "stop") {
    const status = await current()
    if (status) {
      const response = await fetch(`http://127.0.0.1:${status.port}/api/shutdown`, { method: "POST", headers: { "X-Zcode-Egress": "1" }, signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error("后台仍有任务在执行，请等任务结束后再升级")
      for (let n = 0; n < 40 && await current(); n++) await delay(100)
      if (await current()) throw new Error("后台尚未退出，请稍后再试")
    }
    report(json ? { ok: true } : "出口管家后台已停止；已有 mihomo 出口继续运行。")
  } else if (command === "doctor") {
    const entry = findRegistration({
      entries: read(join(magpieDir(), "plugins.json"), {})?.plugins,
      dependencies: read(join(magpieDir(), "plugins", "package.json"), {})?.dependencies,
      root, magpieDir: magpieDir(), name: read(join(root, "package.json"), {})?.name,
    })
    const required = ["package.json", "index.mjs", "server.mjs", "page/entry.html", "page/entry.js", "page/index.html", "page/app.js", "page/service-bridge.js", "page/style.css", "page/icons.js", "page/model.js", "vendor/yaml/dist/index.js", "vendor/fflate/index.mjs"]
    const missing = required.filter((file) => !existsSync(join(root, file)))
    const status = await current(), cfg = loadConfig()
    const result = { version: PLUGIN_VERSION, platform: `${process.platform}/${process.arch}`, runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, pluginDir: root, magpieDir: magpieDir(), dataDir: dataDir(), registered: !!entry, enabled: !!entry && !entry.off, missingFiles: missing, service: status ? status.gen === GEN ? "ready" : "update-pending" : "stopped", port: status?.port || null, coreInstalled: existsSync(binPath(resolveBaseDir(cfg))), browserReady: !!chromePath() && displayReady() }
    result.ok = !missing.length && result.registered && result.enabled
    if (json) report(result)
    else {
      console.log(`出口管家 v${PLUGIN_VERSION} · ${result.platform} · ${result.runtime}`)
      console.log(`插件文件：${missing.length ? "缺少 " + missing.join(", ") : "完整"}`)
      console.log(`magpie 注册：${!entry ? `未注册，请运行 Install.cmd，或执行 magpie plugin add "${root}"；仅复制目录不会安装插件` : entry.off ? "已停用，请在 magpie 插件管理中启用" : "已注册并启用"}`)
      console.log(`后台服务：${result.service}${status ? ` · http://127.0.0.1:${status.port}/` : "；运行 Open.cmd 启动"}`)
      console.log(`mihomo：${result.coreInstalled ? "已安装" : "首次分配时下载"}；自动领取浏览器：${result.browserReady ? "就绪" : "未就绪（不影响出口管理）"}`)
      console.log(`插件目录：${root}\nmagpie 数据：${magpieDir()}\n插件数据：${dataDir()}`)
      console.log("入口：导航栏的「插件 → 出口管家」；设置中的「出口管家」面板；或运行 Open.cmd。")
    }
    process.exitCode = result.ok ? 0 : 1
  } else throw new Error("用法：node manage.mjs open|doctor|status|stop [--json] [--no-browser]")
}
main().catch((error) => { console.error(json ? JSON.stringify({ ok: false, error: error.message }) : error.message); process.exitCode = 1 })
