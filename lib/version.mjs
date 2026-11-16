// ZCode 客户端版本号：本地目录 + 远端（github / mirror）取较大者。
// 服务端按 X-ZCode-App-Version 过滤活动投递，版本旧了直接给空 deliveries。
import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TAGS_PATH = "https://api.github.com/repos/zai-org/ZCode/tags?per_page=10"
const MIRRORS = ["https://gh-proxy.com/", "https://gh.ddlc.top/"]

export const VERSION_SOURCES = ["local", "github", "mirror"]

export const normalizeVersion = (v) => {
  const s = String(v ?? "").trim().replace(/^v/i, "")
  return /^\d+\.\d+\.\d+$/.test(s) ? s : ""
}

export const compareVersions = (a, b) => {
  const pa = (normalizeVersion(a) || "0.0.0").split(".").map(Number)
  const pb = (normalizeVersion(b) || "0.0.0").split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

const detectLocal = () => {
  try {
    const root = join(homedir(), ".zcode", "v2", "runtime", "provider")
    for (const plat of readdirSync(root)) {
      const versions = readdirSync(join(root, plat))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      if (versions.length) return versions[versions.length - 1]
    }
  } catch {}
  return process.env.ZCODE_EGRESS_APP_VERSION || "3.17.2"
}

let remote = { version: "", via: "", error: "", at: 0 }
export const noteRemoteVersion = ({ version, via = "", error = "" } = {}) => {
  const v = normalizeVersion(version)
  remote = {
    version: v && compareVersions(v, remote.version) >= 0 ? v : remote.version,
    via: via || remote.via,
    error,
    at: Date.now(),
  }
}
export const remoteVersionInfo = () => ({ ...remote })

let versionCache = { at: 0, value: "" }
export const appVersion = () => {
  if (!versionCache.value || Date.now() - versionCache.at > 5_000) {
    const local = detectLocal()
    versionCache = { at: Date.now(), value: compareVersions(remote.version, local) > 0 ? remote.version : local }
  }
  return versionCache.value
}

export const fetchLatestVersion = async ({ source = "github", timeoutMs = 8000 } = {}) => {
  const bases = source === "mirror" ? MIRRORS : [""]
  const errors = []
  for (const base of bases) {
    const url = base ? base + TAGS_PATH : TAGS_PATH
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "magpie-zcode-egress" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json().catch(() => null)
      if (!Array.isArray(body)) throw new Error("tags 不合预期")
      const version = [...new Set(body.map((t) => normalizeVersion(t?.name)).filter(Boolean))]
        .sort((a, b) => compareVersions(b, a))[0]
      if (!version) throw new Error("没有可用 tag")
      return { version, via: base ? new URL(base).host : "api.github.com" }
    } catch (e) {
      errors.push(`${base || "api.github.com"}: ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  throw new Error(errors.join(" | "))
}
