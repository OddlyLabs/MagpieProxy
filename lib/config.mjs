import { DEFAULT_CONFIG } from "./store.mjs"

export const CONFIG_RANGES = Object.freeze({
  apiPort: [1, 65535], portBase: [1, 65535], spareBase: [1, 65535], probePortBase: [1, 65280],
  checkIntervalMin: [2, 180], sparesCount: [2, 40],
  claimHour: [0, 23], claimMinute: [0, 59], claimIntervalMin: [2, 180], claimWindowHours: [1, 24],
})
const choices = { backend: ["auto", "docker", "binary"], versionSource: ["local", "github", "mirror"], unitStyle: ["zh", "en"] }

export class ConfigError extends Error {
  constructor(key, message) {
    super(`${key}：${message}`)
    this.statusCode = 400
    this.field = key
  }
}

// Validate the entire patch before writing anything. Zero is a valid hour/minute.
export function applyConfigPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigError("配置", "需要 JSON 对象")
  const next = { ...current }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    const fail = (message) => { throw new ConfigError(key, message) }
    if (CONFIG_RANGES[key]) {
      const [min, max] = CONFIG_RANGES[key]
      const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN
      if (!Number.isInteger(n) || n < min || n > max) fail(`需为 ${min}–${max} 的整数`)
      next[key] = n
    } else if (key === "managedProviders") {
      if (value === null) next[key] = null
      else {
        if (!Array.isArray(value) || value.length > 500 || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 160)) fail("需要供应商 ID 字符串数组或 null")
        next[key] = [...new Set(value.map((v) => v.trim()))]
      }
    } else if (typeof DEFAULT_CONFIG[key] === "boolean") {
      if (typeof value !== "boolean") fail("需要 true 或 false")
      next[key] = value
    } else {
      if (typeof value !== "string") fail("需要字符串")
      const text = value.trim()
      if (text.length > (key === "poolText" ? 1_000_000 : 8192)) fail("内容过长")
      if (choices[key] && !choices[key].includes(text)) fail(`可选值：${choices[key].join(" / ")}`)
      if ((key === "mirror" || key === "subUrl") && text) {
        try { if (!["http:", "https:"].includes(new URL(text).protocol) || /\s/.test(text)) throw new Error() }
        catch { fail("需要完整的 http:// 或 https:// 地址") }
      }
      next[key] = text
    }
  }
  if ((Object.hasOwn(patch, "spareBase") || Object.hasOwn(patch, "sparesCount")) && Number(next.spareBase) + Number(next.sparesCount) - 1 > 65535) {
    throw new ConfigError("spareBase", "备用端口范围不能超过 65535")
  }
  return next
}
