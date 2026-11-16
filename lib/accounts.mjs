// magpie 侧的账号读取与 accountProxies 下发。
//
// 账号的两个来源（都是 magpie 自己维护的文件，只读不抢）：
//   providers.json  → zcode provider 的 accountNames（编号↔邮箱）、accountProxies（邮箱→出口代理）
//   plugin-auth.json → zcode / zcode#xxxx 的登录态（refresh 里有 jwt/device）
//
// 写 accountProxies 是本插件唯一会动 magpie 的地方：
//   临时文件 + 原子 rename，magpie 会热加载（已实测：不改 providers.json 的其它字段、
//   不停 magpie，下一次该账号的请求就走新出口）。
import { join } from "node:path"
import { readJson as readJSON, writeJsonAtomic } from "./files.mjs"
import { defaultMagpieDir } from "./platform.mjs"

export const magpieDir = () =>
  process.env.ZCODE_EGRESS_MAGPIE_DIR
  || defaultMagpieDir()

export const zcodeProvider = () => {
  const d = readJSON(join(magpieDir(), "providers.json"), null)
  if (!d) throw new Error("providers.json 读不到")
  const p = (d.providers ?? []).find((x) => x?.id === "zcode")
  if (!p) throw new Error("providers.json 里没有 zcode provider")
  return p
}

// 编号排序的邮箱列表（01..20；没有编号的退回 accountProxies 的键）
export const zcodeEmails = () => {
  const p = zcodeProvider()
  const names = p.accountNames ?? {}
  let emails = Object.entries(names).sort((a, b) => String(a[1]).localeCompare(String(b[1]), undefined, { numeric: true })).map(([e]) => e)
  if (!emails.length) emails = Object.keys(p.accountProxies ?? {}).sort()
  return { provider: p, emails }
}

export const proxyOfEmail = (email) => (zcodeProvider().accountProxies ?? {})[email] ?? ""

// 登录态：[{key, email, jwt, device, site}]
export const authAccounts = () => {
  const store = readJSON(join(magpieDir(), "plugin-auth.json"), {})
  const out = []
  for (const [key, value] of Object.entries(store)) {
    if (key.split("#")[0] !== "zcode") continue
    let state = {}
    try { state = typeof value.refresh === "string" ? JSON.parse(value.refresh) : value.refresh } catch {}
    if (!state?.jwt) continue
    out.push({
      key,
      email: String(value.accountId ?? ""),
      jwt: state.jwt,
      device: state.device,
      site: state.site ?? "zai",
    })
  }
  return out
}

export const parseJwt = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) } catch { return {} }
}

// 只改指定 provider 的 accountProxies，其余内容原样保留；mapping 是完整目标态
// （不在 mapping 里的旧键会被清掉——账号/Key 已删时 provider.json 里的记录跟着清）。
// 原子写 + 热加载生效，绝不停 magpie。
// 返回 {changed: [acc→新代理], removed: [acc], wrote: bool}
export function setProviderAccountProxies(providerId, mapping, { log = () => {} } = {}) {
  const path = join(magpieDir(), "providers.json")
  const d = readJSON(path, null)
  if (!d) throw new Error("providers.json 读不到")
  const p = (d.providers ?? []).find((x) => x?.id === providerId)
  if (!p) throw new Error(`providers.json 里没有 ${providerId} provider`)
  const old = p.accountProxies ?? {}
  const changed = Object.entries(mapping).filter(([k, v]) => old[k] !== v)
  const removed = Object.keys(old).filter((k) => !(k in mapping))
  if (!changed.length && !removed.length) return { changed: [], removed: [], wrote: false }
  for (const [k, v] of changed) log(`  ${providerId}/${k}: ${old[k] ?? "(无)"} → ${v}`)
  for (const k of removed) log(`  - ${providerId}/${k}（原 ${old[k]}，账号/Key 已不在）`)
  // mapping 是完整目标态：直接替换，不在 mapping 里的旧记录清掉
  // （同步前调用方会先确认枚举完整，防止 logins.json 短暂读不到时误清，见 syncAll）
  p.accountProxies = { ...mapping }
  writeJsonAtomic(path, d)
  return { changed, removed, wrote: true }
}

// 兼容旧调用（zcode 单供应商时代）：等价于 setProviderAccountProxies("zcode", …)
export function setAccountProxies(mapping, opts = {}) {
  return setProviderAccountProxies("zcode", mapping, opts)
}
