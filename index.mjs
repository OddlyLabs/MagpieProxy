// Official Magpie plugin entry. UI and task execution use the local service;
// no host source patch, shell, or frontend build is required.
import { ensureService, exposeService, validPort } from "./lib/service.mjs"
import { defaultMagpieDir } from "./lib/platform.mjs"

const REQUEST_ROUTES = {
  check: "/api/check", seed: "/api/seed", sync: "/api/sync", claims: "/api/claims/run",
  subscribe: "/api/subscribe", "subscription-remove": "/api/subscribe/remove",
  "pool-import": "/api/pool/import", "pool-clear": "/api/pool/clear", "probe-nodes": "/api/nodes/probe",
  swap: "/api/swap", assign: "/api/assign", bind: "/api/bind", unbind: "/api/unbind", exits: "/api/exits",
  config: "/api/config", "page-seen": "/api/page-seen",
}

export const ZcodeEgressPlugin = async (input, options = {}) => {
  const directory = process.env.ZCODE_EGRESS_MAGPIE_DIR || input?.directory || defaultMagpieDir()
  const service = await ensureService({ magpieDirectory: directory })
  const port = service.port
  const preferred = validPort(options.port) ? Number(options.port) : 3468
  await exposeService(preferred, service)
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65 * 60_000),
    })
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error || result.message || `HTTP ${response.status}`)
    return result
  }
  // Older sandbox pages and the Settings panel keep the documented options
  // transport. The normal workbench talks to the service without host reloads.
  if (options.request) {
    try {
      const request = typeof options.request === "string" ? JSON.parse(options.request) : options.request
      const path = REQUEST_ROUTES[request?.action]
      if (!path) throw new Error("未知的面板操作")
      void call(path, { ...(request.patch || {}), id: request.id }).catch((error) => console.error("[出口管家]", error.message))
    } catch (error) { console.error("[出口管家]", error.message) }
  }
  return {
    tool: {
      status: {
        description: "出口管家状态：各供应商账号/Key 的出口绑定（端口/节点/出口 IP/健康）、备用池、领取记录与配置。不含任何登录密钥。",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const s = await call("/api/status")
          const snap = s?.snapshot ?? {}
          return {
            port, running: s.running,
            egress: {
              hasState: snap.egress?.hasState, lastCheck: snap.egress?.lastCheck, lastReseed: snap.egress?.lastReseed,
              managed: snap.onboard?.managed ?? [],
              pending: snap.onboard?.pending ?? 0,
              providers: (snap.providers ?? []).map((p) => ({
                id: p.id, managed: p.managed,
                accounts: p.accounts.map((a) => ({
                  label: a.label, alias: a.alias, port: a.port, node: a.node, ip: a.ip, zcode: a.zcode,
                  ...(a.front ? { front: a.front, strategy: a.strategy, exits: (a.exits ?? []).map((e) => ({ port: e.port, node: e.node, ip: e.ip })) } : {}),
                })),
              })),
              spares: snap.egress?.spares ?? [],
            },
            claims: { enabled: snap.claims?.enabled, inWindow: snap.claims?.inWindow, nextWindowAt: snap.claims?.nextWindowAt, lastResult: snap.claims?.lastResult },
            records: (snap.records ?? []).slice(0, 10),
          }
        },
      },
      check: {
        description: "立即跑一轮出口健康检查（坏端口从备用池换节点；白名单内未绑定的账号/Key 会顺手自动分配；与旧 cron 同锁互斥）。",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => call("/api/check", {}),
      },
      assign: {
        description: "一键分配：给白名单供应商里还没有绑定出口的账号/Key 自动挑选节点（出口 IP 互不重复、按 TLS 延迟排序）并固定绑定，写入 magpie 热加载。",
        args: {
          type: "object",
          properties: {
            provider: { type: "string", description: "只给这个供应商分配（缺省 = 全部白名单供应商）" },
          },
          additionalProperties: false,
        },
        execute: async (args) => call("/api/assign", { provider: args?.provider }),
      },
      bind: {
        description: "绑定/换绑：把某供应商的一个账号（登录账号）或 Key（sha256 前 10 位）绑到指定节点，或解绑。",
        args: {
          type: "object",
          properties: {
            provider: { type: "string" },
            account: { type: "string", description: "登录账号（邮箱）或 Key 的 sha256 前 10 位" },
            node: { type: "string", description: "目标节点名；缺省 = 自动挑一个空闲出口" },
            unbind: { type: "boolean", description: "true = 解绑并释放端口" },
          },
          required: ["provider", "account"],
          additionalProperties: false,
        },
        execute: async (args) => args?.unbind
          ? call("/api/unbind", { provider: args.provider, account: args.account })
          : call("/api/bind", { provider: args.provider, account: args.account, node: args?.node }),
      },
      exits: {
        description: "单 Key 多出口：让一个已绑定的账号/Key 同时使用多个出口。magpie 里仍只有一条代理（本地分流入口），由 mihomo 在几个出口之间分流；每个出口照常体检、坏了自动换备用。count=1 改回单出口。",
        args: {
          type: "object",
          properties: {
            provider: { type: "string" },
            account: { type: "string", description: "登录账号（邮箱）或 Key 的 sha256 前 10 位；需已绑定出口" },
            count: { type: "number", description: "出口总数，1 到设置里的上限（默认 8，最高 64）；1 = 改回单出口" },
            strategy: { type: "string", enum: ["round-robin", "sticky-sessions", "consistent-hashing"], description: "分流策略：round-robin 每条新连接轮换（默认）；sticky-sessions 同一目标一段时间内固定；consistent-hashing 同一目标始终固定" },
          },
          required: ["provider", "account", "count"],
          additionalProperties: false,
        },
        execute: async (args) => call("/api/exits", { provider: args.provider, account: args.account, count: args.count, strategy: args?.strategy }),
      },
      claim: {
        description: "立即跑一轮 ZCode 赠送 Token 领取（每号继承自己的出口 IP；窗口外也可手动触发）。",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => call("/api/claims/run", {}),
      },
      configure: {
        description: "查看或修改配置：backend(docker/binary/auto)、baseDir、subUrl（追加单个订阅；多个可在面板批量导入）、mirror、checkIntervalMin、autoAssignNew（新账号自动分配）、managedProviders（受管供应商白名单，数组）、claimEnabled、claimHour、claimMinute、claimIntervalMin、claimWindowHours、sparesCount、portBase、apiPort。",
        args: {
          type: "object",
          properties: {
            backend: { type: "string", enum: ["auto", "docker", "binary"] },
            baseDir: { type: "string" },
            subUrl: { type: "string" },
            mirror: { type: "string" },
            checkIntervalMin: { type: "number" },
            autoAssignNew: { type: "boolean" },
            managedProviders: { type: "array", items: { type: "string" } },
            claimEnabled: { type: "boolean" },
            claimHour: { type: "number" },
            claimMinute: { type: "number" },
            claimIntervalMin: { type: "number" },
            claimWindowHours: { type: "number" },
            sparesCount: { type: "number" },
            portBase: { type: "number" },
            apiPort: { type: "number" },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          if (!args || Object.keys(args).length === 0) {
            const s = await call("/api/status")
            return s?.snapshot?.config ?? {}
          }
          return call("/api/config", args)
        },
      },
    },
  }
}

