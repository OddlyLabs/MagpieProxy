// Pure snapshot projection; no credentials or raw node definitions enter the panel.
import { managedIds } from "./providers.mjs"
import { claimKey, dayKeyBeijing } from "./claims.mjs"
import { exitPortsOf, isMultiExit, proxyUrlOf } from "./bindings.mjs"

export function claimsToday(records, now = Date.now()) {
  const day = dayKeyBeijing(now), seen = new Set(), byAccount = new Map()
  for (const record of records) {
    const time = new Date(record.time).getTime()
    if (!Number.isFinite(time) || dayKeyBeijing(time) !== day || !["claimed", "done"].includes(record.status)) continue
    const key = `${record.email}\0${claimKey(record.plan || record.planName || "")}`
    if (seen.has(key)) continue
    seen.add(key)
    byAccount.set(record.email, (byAccount.get(record.email) ?? 0) + 1)
  }
  return { total: seen.size, byAccount }
}

export function providersView({ providers, cfg, bindings, state, records = [], authenticatedEmails = [], now }) {
  const managed = new Set(managedIds(cfg, providers))
  const authenticated = new Set(authenticatedEmails)
  const today = claimsToday(records, now).byAccount
  // 单个出口端口的视图：节点、最近一次实测 IP 与探测结果
  const exitView = (providerId, port) => {
    const assignment = state?.assignments?.[String(port)]
    const savedCheck = state?.last_check?.ports?.[String(port)] ?? {}
    const check = !savedCheck.node || savedCheck.node === assignment?.node ? savedCheck : {}
    return {
      check, port, node: assignment?.node ?? null,
      // A failed *latest* probe must not fall back to an old, successful IP.
      ip: Object.hasOwn(check, "ip") ? check.ip : assignment?.ip ?? null,
      zcode: providerId === "zcode" ? check.zcode ?? null : null,
    }
  }
  return providers.map((provider) => ({
    id: provider.id, name: provider.name, kind: provider.kind, managed: managed.has(provider.id),
    accounts: provider.accounts.map((account) => {
      const bind = bindings?.bindings?.[provider.id]?.[account.id]
      const port = bind?.port ?? null
      const { check, ...main } = exitView(provider.id, port)
      // 多出口：port / node / ip 仍是主出口；proxy 是 magpie 实际使用的地址（入口）。
      const multi = isMultiExit(bind)
      const proxy = proxyUrlOf(bind)
      const exits = multi ? exitPortsOf(bind).map((exitPort, i) => {
        const { check: _check, ...exit } = exitView(provider.id, exitPort)
        return { ...exit, primary: i === 0 }
      }) : []
      return {
        id: account.id, label: account.label, alias: account.alias || "", plan: account.plan || "",
        on: account.on, lapsed: account.lapsed, port, proxy,
        node: main.node, ip: main.ip, zcode: main.zcode,
        exits, front: multi ? Number(bind.front) : null, strategy: multi ? bind.strategy ?? null : null,
        proxySet: !!provider.proxies?.[account.id],
        proxyMismatch: !!port && provider.proxies?.[account.id] !== proxy,
        hasJwt: provider.id === "zcode" ? authenticated.has(account.id) : null,
        claimsToday: provider.id === "zcode" ? today.get(account.id) ?? 0 : 0,
        lastChecked: check.checkedAt ?? (state?.last_check?.ts ? state.last_check.ts * 1000 : null),
        mode: bind?.mode ?? null,
      }
    }),
  }))
}

export function accountTotals(providers) {
  const accounts = providers.filter((p) => p.managed).flatMap((p) => p.accounts)
  return { accounts: accounts.length, accountsBound: accounts.filter((a) => a.port).length, pending: accounts.filter((a) => !a.port).length }
}
