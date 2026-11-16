// magpie 供应商与账号的统一枚举。
//
// 账号的两个来源（都是 magpie 自己维护的文件，这里只读）：
//   providers.json → 供应商条目（id/name/key/keys/accountProxies/accountNames）
//   logins.json    → 登录态（agent: "plugin:<id>"，user 是账号标识）
//
// 账号标识口径（也就是 accountProxies 的键）：
//   登录型供应商（如 zcode）：user（邮箱）
//   Key 型供应商（含自定义供应商的多 Key）：sha256(key) 前 10 位十六进制
//     —— 与 magpie 自己写 accountProxies 的规则一致（2026-11-13 对 amd 实测比对）。
//   gptfree-pool 之类的内置号池不在 providers.json 里，天然被排除（不归本插件管）。
import { createHash } from "node:crypto"
import { join } from "node:path"
import { readJson as readJSON } from "./files.mjs"
import { magpieDir } from "./accounts.mjs"

export const sha10 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 10)

// 掩码展示：保留协议前缀（sk- / tl- …）+ 首 4 末 4，中间省略
export const maskKey = (key) => {
  const s = String(key ?? "")
  const m = /^([A-Za-z0-9]+-)(.*)$/.exec(s)
  const body = m ? m[2] : s
  const pre = m ? m[1] : ""
  if (body.length <= 8) return pre + "••••" + (body.length > 2 ? body.slice(-2) : "")
  return `${pre}${body.slice(0, 4)}…${body.slice(-4)}`
}

// socks5://[user:pass@]127.0.0.1:17901 → 17901（解析不出端口返回 null）
export const parseProxyPort = (url) => {
  const m = /:(\d+)$/.exec(String(url ?? "").trim())
  if (!m) return null
  const n = Number(m[1])
  return n > 0 && n < 65536 ? n : null
}

// 全部供应商 + 账号。只列有账号（登录或 Key）的供应商——没有账号就没有可绑定的东西。
// 返回 [{id, name, kind: "login"|"keys"|"mixed", accounts: [{id, label, alias, plan, on, lapsed}], proxies: {accId: url}}]
export function listProviders() {
  const d = readJSON(join(magpieDir(), "providers.json"), null)
  if (!d) throw new Error("providers.json 读不到")
  const logins = readJSON(join(magpieDir(), "logins.json"), [])
  const byAgent = new Map()
  for (const l of Array.isArray(logins) ? logins : []) {
    const id = String(l?.agent ?? "").replace(/^plugin:/, "")
    if (!id) continue
    if (!byAgent.has(id)) byAgent.set(id, [])
    byAgent.get(id).push(l)
  }
  const out = []
  for (const p of d.providers ?? []) {
    if (!p?.id) continue
    const proxies = p.accountProxies ?? {}
    const names = p.accountNames ?? {}
    const accounts = new Map()
    for (const l of byAgent.get(p.id) ?? []) {
      if (!l?.user) continue
      accounts.set(l.user, { id: l.user, label: l.user, alias: names[l.user] ?? "", plan: l.plan ?? "", on: l.on, lapsed: !!l.lapsed, via: "login" })
    }
    const keys = [p.key, ...(Array.isArray(p.keys) ? p.keys.map((k) => k?.key).filter(Boolean) : [])].filter(Boolean)
    for (const k of keys) {
      const id = sha10(k)
      if (!accounts.has(id)) accounts.set(id, { id, label: maskKey(k), alias: "", plan: "API Key", on: true, lapsed: false, via: "key" })
    }
    // accountNames / accountProxies 里还有键但登录态没枚举到（登出态、logins.json 短暂
    // 缺失、agent 字段变化等）也要显示出来——否则面板出现「看不见的账号」，绑定清理
    // 还会把它误判成孤儿。这类账号 plan 留空，zcode 侧按「缺登录态」提示。
    for (const acc of [...new Set([...Object.keys(names), ...Object.keys(proxies)])]) {
      if (!accounts.has(acc)) accounts.set(acc, { id: acc, label: acc, alias: names[acc] ?? "", plan: "", on: null, lapsed: false, via: "names" })
    }
    if (!accounts.size) continue
    const hasLogin = [...accounts.values()].some((a) => a.via === "login")
    out.push({
      id: p.id,
      name: p.name || p.id,
      kind: hasLogin && keys.length ? "mixed" : hasLogin ? "login" : "keys",
      accounts: [...accounts.values()],
      proxies,
    })
  }
  return out
}

export const providerInfo = (id) => listProviders().find((p) => p.id === id) ?? null

// 受管供应商白名单：cfg.managedProviders 里仍然存在的那些。
// config 未配置时回退 =「已经有 accountProxies 的供应商」（迁移前的默认接管面）。
export function managedIds(cfg, provs) {
  const all = provs ?? listProviders()
  const want = Array.isArray(cfg?.managedProviders) ? cfg.managedProviders.filter((x) => typeof x === "string") : null
  if (want) return all.filter((p) => want.includes(p.id)).map((p) => p.id)
  return all.filter((p) => Object.keys(p.proxies ?? {}).length).map((p) => p.id)
}
