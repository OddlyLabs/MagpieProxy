// ZCode 账号 API：余额 / 活动投递 / 领取 / 激活上报，全部经由账号自己的出口代理。
import { proxiedFetch } from "./socks.mjs"
import { appVersion } from "./version.mjs"

const ORIGIN = "https://zcode.z.ai"

export const headersOf = (jwt, device, extra = {}) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": `ZCode/${appVersion()}`,
  ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  "X-Device-Mid": device || crypto.randomUUID(),
  "X-ZCode-App-Version": appVersion(),
  "X-Platform": `${process.platform}-${process.arch}`,
  ...extra,
})

async function call(name, url, { proxy, jwt, device, method = "GET", extraHeaders = {}, body, timeoutMs = 25000 } = {}) {
  const r = await proxiedFetch(url, {
    proxy, method, timeoutMs,
    headers: headersOf(jwt, device, extraHeaders),
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  })
  let env = null
  try { env = JSON.parse(r.text) } catch {}
  return { name, http: r.status, code: env?.code ?? "", msg: env?.msg ?? "", data: env?.data ?? null, text: r.text.slice(0, 400), ms: r.ms }
}

// 余额：各套餐与用量桶（面板展示 + 已持有判断）
export const balance = (acc) =>
  call("balance", `${ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${appVersion()}`, { ...acc })

// 活动投递（活动卡）：v3.17 客户端只看这个 feed，旧 preview 已废
export const touch = (acc, seq = 0) =>
  call("touch", `${ORIGIN}/api/v1/marketing/touch?seq=${seq}`, {
    ...acc, extraHeaders: { "X-Client-Language": /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || "") ? "zh-CN" : "en-US" },
  })

// touch 的 deliveries 里找 claim_zcode_plan 动作（官方插件同款解析）
export function touchPlans(deliveries) {
  if (!Array.isArray(deliveries)) return []
  const out = []
  for (const dv of deliveries) {
    const ids = [], names = []
    const walk = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 12) return
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
      if (v.type === "claim_zcode_plan" && typeof v.args?.plan_id === "string" && v.args.plan_id.trim()) ids.push(v.args.plan_id.trim())
      if (v.zcode_plan && typeof v.zcode_plan === "object" && typeof v.zcode_plan.name === "string") names.push(v.zcode_plan.name)
      for (const k of Object.keys(v)) walk(v[k], depth + 1)
    }
    walk(dv, 0)
    for (const id of ids) out.push({ plan_id: id, name: names[0] ?? id })
  }
  return out
}

// 领取一个计划。attestation 是阿里云验证码的回执；没有它服务端回 3007。
export const claim = (acc, planId, attestation) =>
  call("claim", `${ORIGIN}/api/v1/zcode-plan/billing/claim`, {
    ...acc, method: "POST", body: { plan_id: planId },
    extraHeaders: attestation?.param
      ? { "X-Aliyun-Captcha-Verify-Param": attestation.param, ...(attestation.region ? { "X-Aliyun-Captcha-Verify-Region": attestation.region } : {}) }
      : {},
  })

// 上报激活（app_launch / app_daily_active）：客户端每次启动都发，领取前补一次
export const reportActivation = async (acc) => {
  const out = []
  for (const element of ["app_launch", "app_daily_active"]) {
    const body = {
      event_id: crypto.randomUUID(),
      client_timezone: "Asia/Shanghai",
      client_language: "zh",
      element_name: element,
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: acc.subject,
      screen_resolution: "2560x1440",
      app_version: appVersion(),
      device_os_category: process.platform,
      device_os_version: "",
      device_mid: acc.device,
      mac_id: "",
      marketing_params: "{}",
    }
    try {
      const r = await proxiedFetch(`${ORIGIN}/api/v1/event/report`, {
        proxy: acc.proxy, method: "POST", timeoutMs: 20000,
        headers: headersOf(acc.jwt, acc.device),
        body: JSON.stringify(body),
      })
      out.push({ element, status: r.status })
    } catch (e) {
      out.push({ element, error: String(e?.message ?? e).slice(0, 80) })
    }
  }
  return out
}

// 人机验证开关：captcha.enabled=false 时领取不需要 attestation
export const captchaConfig = async (acc) => {
  const r = await proxiedFetch(`${ORIGIN}/api/v1/client/configs`, {
    proxy: acc.proxy, timeoutMs: 20000, headers: headersOf(acc.jwt ?? "", acc.device),
  })
  let env = null
  try { env = JSON.parse(r.text) } catch {}
  if (env?.code !== 0) throw new Error(`client/configs 异常（HTTP ${r.status} code ${env?.code ?? "?"}）`)
  const c = env?.data?.configs?.captcha ?? env?.data?.captcha ?? {}
  if (!c.enabled || !c.sceneId) throw new Error("ZCode 的验证码未开启或没有 sceneId")
  return { enabled: !!c.enabled, region: c.region ?? "", prefix: c.prefix ?? "", sceneId: c.sceneId }
}

export const jwtSubject = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub } catch { return "" }
}
