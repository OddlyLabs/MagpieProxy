// CLI：由 server.mjs 在 flock 下调用（与旧 cron 的 egress.py check 互斥），
// 也可以手动跑：bun egress-cli.mjs check|assign|bind|unbind|exits|seed|sync|claims|status
//   ZCODE_EGRESS_CONFIG='{"..."}'  覆盖配置（server 传入）
import { loadConfig, dataDir } from "./lib/store.mjs"
import { join } from "node:path"
import { acquireLock } from "./lib/lock.mjs"
import * as egress from "./lib/egress.mjs"
import { claimRound } from "./lib/claims.mjs"
import { loadBindings, frontsOf } from "./lib/bindings.mjs"

const cfg = { ...loadConfig(), ...(process.env.ZCODE_EGRESS_CONFIG ? JSON.parse(process.env.ZCODE_EGRESS_CONFIG) : {}) }
const ctx = { log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`) }

// 预期内的业务错误（节点/端口冲突、配置自检不通过等）只打一行。
// 面板取的是子进程输出的「末尾 160 字」，抛原始堆栈的话用户只能看到调用栈，
// 看不到真正原因。
const run = async (fn) => {
  try { return await fn() } catch (e) { console.error(`错误：${String(e?.message ?? e)}`); process.exit(1) }
}
const cmd = process.argv[2] ?? "status"
if (cmd !== "status") {
  try {
    const release = acquireLock(join(dataDir(), "egress.lock"))
    process.once("exit", release)
    process.once("SIGTERM", () => process.exit(143))
    process.once("SIGINT", () => process.exit(130))
  } catch (error) { console.error(error.message); process.exit(error.code === "EGRESS_BUSY" ? 75 : 1) }
}

if (cmd === "probe-nodes") {
  const r = await run(() => egress.inspectNodes(cfg, ctx, JSON.parse(process.argv[3] || "[]")))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "check") {
  const r = await run(() => egress.check(cfg, ctx, { force: process.argv.includes("--force") }))
  process.exit(r.ok === false ? 1 : 0)
} else if (cmd === "seed" || cmd === "reseed") {
  const r = await run(() => egress.seed(cfg, ctx))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "assign") {
  // assign [provider]：给待分配的账号/Key 挑新出口并固定绑定（已有绑定不动）
  const provider = process.argv[3]
  const r = await run(() => egress.assignPending(cfg, ctx, { provider }))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "bind") {
  // bind <provider> <account> [--node <节点>]：绑定（带 node = 手动指定；不带 = 自动挑）
  const [provider, account] = [process.argv[3], process.argv[4]]
  const ni = process.argv.indexOf("--node")
  const node = ni > 0 ? process.argv.slice(ni + 1).join(" ").trim() : undefined
  if (!provider || !account) { console.log("用法: bind <provider> <account> [--node <node>]"); process.exit(2) }
  const r = await run(() => egress.bindAccount(cfg, ctx, provider, account, { node }))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "unbind") {
  // unbind <provider> <account>：解绑并释放端口
  const [provider, account] = [process.argv[3], process.argv[4]]
  if (!provider || !account) { console.log("用法: unbind <provider> <account>"); process.exit(2) }
  const r = await run(() => egress.unbindAccount(cfg, ctx, provider, account))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "exits") {
  // exits <provider> <account> <数量> [--strategy <策略>]：单 Key 多出口。
  // 数量 1 = 改回单出口；策略 round-robin | sticky-sessions | consistent-hashing
  const [provider, account, count] = [process.argv[3], process.argv[4], process.argv[5]]
  const si = process.argv.indexOf("--strategy")
  const strategy = si > 0 ? process.argv[si + 1] : undefined
  if (!provider || !account || !count) { console.log("用法: exits <provider> <account> <数量> [--strategy round-robin|sticky-sessions|consistent-hashing]"); process.exit(2) }
  const r = await run(() => egress.setExits(cfg, ctx, provider, account, Number(count), { strategy }))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "sync") {
  const r = egress.syncAll(cfg, { log: ctx.log, dryRun: process.argv.includes("--dry-run") })
  console.log(JSON.stringify(r, null, 1))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "claims") {
  const r = await run(() => claimRound({ cfg, log: ctx.log }))
  console.log(JSON.stringify({ claimed: r.claimed, done: r.done, failed: r.failed, captcha: r.captcha, skipped: r.skipped }))
  process.exit(0)
} else if (cmd === "swap") {
  // swap <port> <node...>：单端口换节点（group 模式走 API 即时切换）
  const port = process.argv[3]
  const node = process.argv.slice(4).join(" ").trim()
  if (!port || !node) { console.log("用法: swap <port> <node>"); process.exit(2) }
  const r = await run(() => egress.swapPort(cfg, ctx, port, node))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === "status") {
  const st = egress.loadState(cfg)
  if (!st) { console.log("无 state"); process.exit(1) }
  const fronts = frontsOf(loadBindings())
  const frontOf = new Map(fronts.flatMap((f) => f.members.map((p) => [String(p), f.port])))
  const ports = Object.keys(st.assignments).sort((a, b) => a - b)
  console.log(`主出口 ${ports.length}，备用 ${(st.spares ?? []).length}，withGroups=${!!st.withGroups}`)
  for (const p of ports) {
    const a = st.assignments[p]
    const lc = st.last_check?.ports?.[p] ?? {}
    console.log(`  ${p}  ${a.node}  ${a.ip ?? lc.ip ?? "?"}  zcode=${lc.zcode ?? "-"}${frontOf.has(p) ? `  入口 :${frontOf.get(p)}` : ""}`)
  }
  for (const f of fronts) console.log(`  入口 :${f.port}  ${f.provider}/${f.account}  ${f.strategy ?? "round-robin"}  → ${f.members.map((p) => ":" + p).join(" ")}`)
  process.exit(0)
} else {
  console.log("用法: egress-cli.mjs check|assign|bind|unbind|exits|seed|sync|claims|swap|probe-nodes|status [--force] [--dry-run] [--node <node>] [--strategy <策略>]")
  process.exit(2)
}
