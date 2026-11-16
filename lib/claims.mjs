// 领取引擎（附带功能）：每晚北京时间 claimHour 点后，按轮次给每个账号探测活动
// 投递并领取赠送 Token。领取完全继承一号一出口：每个账号的请求都走它自己绑定
// 的出口端口（providers.json accountProxies），出口 IP 天然一号一个，无需任何
// 名额管理。
//
// 判定口径与官方插件一致：
//   claimed=0 领取成功 / done=1003 已领过 / 3007 验证码被拒 / 1004 暂不可领 /
//   failed 其它。
import { loadRecords, addRecords, loadDaily, saveDaily } from "./store.mjs"
import { authAccounts, zcodeProvider } from "./accounts.mjs"
import { loadBindings, isMultiExit } from "./bindings.mjs"
import { balance, touch, touchPlans, claim, reportActivation, captchaConfig, jwtSubject } from "./zcodeapi.mjs"
import { attestation } from "./captcha.mjs"

// 批次键：同一礼包的变体 id 归到一起（-1/-2 是 entitlement 尾巴）
export const claimKey = (planId) => {
  const id = String(planId ?? "")
  const b = /^zcode-v3-start-plan-([0-9]{4})/.exec(id)
  if (b) return `${b[1]}|${/-wk/.test(id) ? "wk" : ""}`
  const b2 = /^zcode-v3-start-plan-([0-9]{4})/.exec(id.replace(/-\d+$/, ""))
  return b2 ? `${b2[1]}|` : id
}

export const dayKeyBeijing = (now = Date.now()) => {
  const d = new Date(now + 8 * 3600_000) // UTC+8
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

// 北京时间窗口：自 claimHour:claimMinute 起 claimWindowHours 小时（可跨午夜）
const windowSettings = (cfg) => {
  const number = (value, fallback, min, max) => { const n = Number(value ?? fallback); return Number.isInteger(n) && n >= min && n <= max ? n : fallback }
  return { hour: number(cfg.claimHour, 19, 0, 23), minute: number(cfg.claimMinute, 0, 0, 59), hours: number(cfg.claimWindowHours, 6, 1, 24) }
}
export function inClaimWindow(cfg, now = Date.now()) {
  const d = new Date(now + 8 * 3600_000)
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  const { hour, minute, hours } = windowSettings(cfg)
  return ((h - hour - minute / 60) % 24 + 24) % 24 < hours
}

// 距下一个窗口开窗的时间戳
export function nextWindowAt(cfg, now = Date.now()) {
  const d = new Date(now + 8 * 3600_000)
  const { hour: start, minute: minutes } = windowSettings(cfg)
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600_000 + (start * 60 + minutes) * 60_000
  if (todayStart > now) return todayStart
  return todayStart + 24 * 3600_000
}

// 花名册：magpie 的 zcode 账号 × 它绑定的出口代理。没配出口的号跳过（面板可见）。
// 多出口的账号在 magpie 里配的是分流入口，同一轮领取的几步请求（验证码取证、
// 领取）会从不同 IP 出去；领取必须一号一 IP，所以这里固定走绑定的主出口。
export function buildRoster(cfg) {
  const prov = zcodeProvider()
  const proxyOf = prov.accountProxies ?? {}
  const names = prov.accountNames ?? {}
  const binds = loadBindings()?.bindings?.zcode ?? {}
  const proxyFor = (email) => isMultiExit(binds[email]) ? `socks5://127.0.0.1:${binds[email].port}` : proxyOf[email] ?? ""
  const accounts = authAccounts()
    .map((a) => ({
      ...a,
      proxy: proxyFor(a.email),
      alias: names[a.email] ?? "",
      subject: jwtSubject(a.jwt),
      port: Number(String(proxyFor(a.email)).match(/:(\d+)$/)?.[1]) || null,
    }))
    .sort((x, y) => String(x.alias).localeCompare(String(y.alias), undefined, { numeric: true }))
  return accounts
}

// —— 一轮领取 ——

let touchSeq = 0

export async function claimRound({ cfg, log = () => {} } = {}) {
  const day = dayKeyBeijing()
  const roster = buildRoster(cfg)
  const daily = loadDaily()
  const today = (daily[day] ??= {})
  const records = []
  let claimed = 0, done = 0, failed = 0, skipped = 0, captcha = 0

  // 非领取类记录（inactive/skipped）每号每天只记一次，防止窗口内每轮刷屏
  const noteOnce = (entry) => {
    const slot = (today[entry.email] ??= {})
    if (slot._noted) return
    slot._noted = true
    records.push(entry)
  }

  for (const a of roster) {
    if (!a.jwt) continue
    const entry = { time: new Date().toISOString(), account: a.alias ? `${a.alias} (${a.email})` : a.email, email: a.email, port: a.port, plan: "", units: null, status: "failed", reason: "", code: null }
    if (!a.proxy) {
      entry.status = "skipped"; entry.reason = "没有绑定出口（先在出口页分配）"
      noteOnce(entry); skipped++
      continue
    }
    try {
      // 余额：已持有的计划（领取判断）
      const bal = await balance({ proxy: a.proxy, jwt: a.jwt, device: a.device })
      const held = new Set()
      for (const p of bal?.data?.plans ?? []) held.add(p.plan_id)
      // 活动投递
      const t = await touch({ proxy: a.proxy, jwt: a.jwt, device: a.device }, touchSeq++)
      const offered = touchPlans(t?.data?.deliveries)
      const wanted = offered.filter((p) => !held.has(p.plan_id))
      const doneKeys = Object.keys(today[a.email] ?? {}).filter((k) => !k.startsWith("_"))
      const pendingPlans = wanted.filter((p) => !doneKeys.includes(claimKey(p.plan_id)))
      if (!pendingPlans.length) {
        entry.status = doneKeys.length ? "settled" : "inactive"
        entry.reason = wanted.length ? "无可领计划（都已持有或今日已领）" : "无活动投递"
        noteOnce(entry)
        continue
      }
      // 领取：走账号自己的出口（验证码 attestation 也走同一出口，IP 一致）
      for (const p of pendingPlans) {
        const rec = { ...entry, plan: p.plan_id, planName: p.name }
        try {
          await reportActivation({ proxy: a.proxy, jwt: a.jwt, device: a.device, subject: a.subject })
          const cfgCaptcha = await captchaConfig({ proxy: a.proxy, jwt: a.jwt, device: a.device })
          const att = await attestation(cfgCaptcha, { proxy: a.proxy })
          const r = await claim({ proxy: a.proxy, jwt: a.jwt, device: a.device }, p.plan_id, att)
          rec.code = r.code
          if (r.code === 0) { rec.status = "claimed"; claimed++; (today[a.email] ??= {})[claimKey(p.plan_id)] = Date.now() }
          else if (r.code === 1003) { rec.status = "done"; done++; (today[a.email] ??= {})[claimKey(p.plan_id)] = Date.now() }
          else if (r.code === 3007) { rec.status = "captcha"; captcha++; rec.reason = "人机验证被拒：" + (r.msg || "3007") }
          else { rec.status = "failed"; failed++; rec.reason = `code ${r.code} ${r.msg}`.trim() }
        } catch (e) {
          rec.status = "failed"; failed++; rec.reason = String(e?.message ?? e).slice(0, 180)
        }
        records.push(rec)
      }
    } catch (e) {
      entry.status = "failed"; failed++
      entry.reason = String(e?.message ?? e).slice(0, 180)
      records.push(entry)
    }
  }

  // 台账只留 3 天
  const days = Object.keys(daily).sort()
  while (days.length > 3) delete daily[days.shift()]
  saveDaily(daily)

  const all = records.length ? addRecords(records) : loadRecords()
  log(`领取轮完成：成功 ${claimed}，已领过 ${done}，失败 ${failed}，验证码 ${captcha}，跳过 ${skipped}`)
  return { claimed, done, failed, captcha, skipped, records, recordsAll: all }
}
