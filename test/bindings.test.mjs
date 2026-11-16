// bindings / providers / 绑定写入 单测（bun run test/bindings.test.mjs）
// 全程走临时目录：ZCODE_EGRESS_DATA + ZCODE_EGRESS_MAGPIE_DIR，不碰 live 数据。
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

const root = join(tmpdir(), `zce-test-${process.pid}`)
const magpieDir = join(root, "magpie")
const dataDir = join(root, "data")
mkdirSync(magpieDir, { recursive: true })
mkdirSync(dataDir, { recursive: true })
process.env.ZCODE_EGRESS_DATA = dataDir
process.env.ZCODE_EGRESS_MAGPIE_DIR = magpieDir

const sha10 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 10)

// —— 夹具：zcode 3 个账号（17901-17903 无歧义）；fakeamd 2 个 key（一个撞 17901，
// 一个没配过）；emptyprov 没有任何账号，不应出现在枚举结果里。
const key1 = "tl-ce5c2d0a398dcbe46a353421e452ebbf4bca039dba967dc9"
const key2 = "tl-bc0652d63c394780b8c19c635863f82fdbeb065ebed81bfe"
const key3 = "tl-fresh-new-key-not-bound-yet"
writeFileSync(join(magpieDir, "providers.json"), JSON.stringify({
  providers: [
    {
      id: "zcode", name: "", key: "",
      accountProxies: {
        "a@duck.com": "socks5://127.0.0.1:17901",
        "b@duck.com": "socks5://127.0.0.1:17902",
        "c@duck.com": "socks5://127.0.0.1:17903",
      },
      accountNames: { "a@duck.com": "01", "b@duck.com": "02", "c@duck.com": "03" },
    },
    {
      id: "fakeamd", name: "FakeAMD", key: key1,
      keys: [{ key: key2 }],
      accountProxies: { [sha10(key1)]: "socks5://127.0.0.1:17901", [sha10(key2)]: "socks5://127.0.0.1:17942" },
    },
    { id: "emptyprov", name: "Empty", key: "", },
    { id: "freshkeys", name: "FreshKeys", key: key3 },
  ],
}, null, 1))
writeFileSync(join(magpieDir, "logins.json"), JSON.stringify([
  { agent: "plugin:zcode", user: "a@duck.com", plan: "ZCODE" },
  { agent: "plugin:zcode", user: "b@duck.com", plan: "ZCODE" },
  { agent: "plugin:zcode", user: "c@duck.com", plan: "ZCODE" },
], null, 1))

const { listProviders, managedIds, parseProxyPort, maskKey } = await import("../lib/providers.mjs")
const { allocPort, migrateBindings, loadBindings, saveBindings, pendingList, bindingOf, bindingPorts, countPending, pruneOrphanBindings } = await import("../lib/bindings.mjs")
const { setProviderAccountProxies } = await import("../lib/accounts.mjs")

let pass = 0, fail = 0
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// —— providers 枚举 ——
const provs = listProviders()
eq(provs.map((p) => p.id), ["zcode", "fakeamd", "freshkeys"], "枚举：只含有账号的供应商")
const zc = provs.find((p) => p.id === "zcode")
eq(zc.kind, "login", "zcode 是登录型")
eq(zc.accounts.map((a) => a.alias), ["01", "02", "03"], "zcode 账号带别名")
const fa = provs.find((p) => p.id === "fakeamd")
eq(fa.kind, "keys", "fakeamd 是 Key 型")
eq(fa.accounts.map((a) => a.id), [sha10(key1), sha10(key2)], "Key 账号 id = sha256 前 10 位")
eq(fa.accounts[0].label, maskKey(key1), "Key 展示掩码")
const fk = provs.find((p) => p.id === "freshkeys")
eq(fk.accounts.length, 1, "没绑定过的 Key 也枚举出来")

eq(parseProxyPort("socks5://user:pa:ss@127.0.0.1:17901"), 17901, "带凭据的代理解析端口")
eq(parseProxyPort("direct"), null, "解析不出端口返回 null")
eq(managedIds({ managedProviders: ["zcode"] }, provs), ["zcode"], "显式白名单")
eq(managedIds({}, provs), ["zcode", "fakeamd"], "默认白名单 = 已有 accountProxies 的供应商")

// —— 迁移 ——
const mig = migrateBindings({}, { log: () => {} })
eq(mig.migrated, true, "首次迁移执行")
const b = loadBindings()
eq(b.bindings.zcode["a@duck.com"].port, 17901, "zcode 01 钉住 17901（登录型赢下冲突端口）")
eq(b.bindings.zcode["c@duck.com"].port, 17903, "zcode 03 钉住 17903")
eq(b.bindings.fakeamd[sha10(key1)].port, null, "撞 17901 的 key 标 pending")
eq(b.bindings.fakeamd[sha10(key2)].port, 17942, "无歧义的 key 原样钉住")
eq(b.bindings.freshkeys, undefined, "默认白名单外的供应商不建绑定组")
eq(countPending(b), 1, "待分配数 = 1（key1 撞端口 + freshkeys 不在白名单）")
eq(migrateBindings({}, { log: () => {} }).migrated, false, "二次调用不再迁移")

// —— 端口分配 ——
const cfg = { portBase: 17901, spareBase: 17931, sparesCount: 8, probePortBase: 18200 }
eq(allocPort(cfg, new Set([17901, 17902, 17903, 17942]), 0), 17904, "顺延到第一个空闲端口")
eq(allocPort(cfg, new Set([...Array.from({ length: 30 }, (_, i) => 17901 + i)]), 0), 17931 + 8, "跳过备用段 17931-17938")
eq(allocPort(cfg, new Set(), 10), 17901, "备用段按实际长度跳过")
const usedAll = new Set(Array.from({ length: 4000 }, (_, i) => 17901 + i))
eq(allocPort(cfg, usedAll, 0), null, "段耗尽返回 null")

// —— pendingList / bindingOf ——
eq(pendingList(b, { managedProviders: ["zcode"] }).length, 0, "显式白名单只看 zcode（无待分配）")
eq(pendingList(b, {}).map((x) => `${x.provider}/${x.account}`), [`fakeamd/${sha10(key1)}`], "默认白名单待分配清单")
eq(bindingOf(b, "zcode", "b@duck.com")?.port, 17902, "bindingOf 反查")
eq(bindingPorts(b).has(17901), true, "bindingPorts 含已绑端口")
eq(bindingPorts(b).has(17942), true, "bindingPorts 含 17942")

// —— 绑定写入（只动目标供应商） ——
const r1 = setProviderAccountProxies("fakeamd", { [sha10(key1)]: "socks5://127.0.0.1:17999" })
eq(r1.wrote, true, "写入成功")
const after = JSON.parse(readFileSync(join(magpieDir, "providers.json"), "utf8"))
eq(after.providers.find((p) => p.id === "fakeamd").accountProxies[sha10(key1)], "socks5://127.0.0.1:17999", "fakeamd 的代理已更新")
eq(after.providers.find((p) => p.id === "fakeamd").accountProxies[sha10(key2)], undefined, "mapping 是完整目标态：未提及的键被清掉")
eq(after.providers.find((p) => p.id === "zcode").accountProxies["a@duck.com"], "socks5://127.0.0.1:17901", "zcode 不受影响")
const r2 = setProviderAccountProxies("fakeamd", { [sha10(key2)]: "socks5://127.0.0.1:17942" })
eq(r2.removed, [sha10(key1)], "mapping 之外的旧键被清掉")
const r3 = setProviderAccountProxies("fakeamd", { [sha10(key2)]: "socks5://127.0.0.1:17942" })
eq(r3.wrote, false, "无变化不写盘")

// —— 枚举兜底：accountNames 里有但 logins.json 没枚举到的账号也要显示（防误清 + 面板盲区） ——
writeFileSync(join(magpieDir, "logins.json"), JSON.stringify([
  { agent: "plugin:zcode", user: "a@duck.com", plan: "ZCODE" },
  { agent: "plugin:zcode", user: "b@duck.com", plan: "ZCODE" },
  // c@duck.com 的登录态暂时丢了，但 accountNames / accountProxies 都还在
], null, 1))
const provs2 = listProviders()
const zc2 = provs2.find((p) => p.id === "zcode")
eq(zc2.accounts.length, 3, "登录态短暂缺失时账号不从枚举里消失")
eq(zc2.accounts.find((a) => a.id === "c@duck.com")?.via, "names", "缺登录态账号标为 names 来源")

// —— 孤儿绑定清理 ——
// 场景：fakeamd 的 key2 被删（三处都没了）→ 绑定应清掉并释放 :17942；
//       c@duck.com 只丢了登录态（accountNames 还在）→ 绝不能清。
writeFileSync(join(magpieDir, "providers.json"), JSON.stringify({
  providers: [
    {
      id: "zcode", name: "", key: "",
      accountProxies: {
        "a@duck.com": "socks5://127.0.0.1:17901",
        "b@duck.com": "socks5://127.0.0.1:17902",
        "c@duck.com": "socks5://127.0.0.1:17903",
      },
      accountNames: { "a@duck.com": "01", "b@duck.com": "02", "c@duck.com": "03" },
    },
    { id: "fakeamd", name: "FakeAMD", key: key1, accountProxies: { [sha10(key1)]: "socks5://127.0.0.1:17999" } },
  ],
}, null, 1))
const pruneR = pruneOrphanBindings({ managedProviders: ["zcode", "fakeamd"] }, { log: () => {} })
eq(pruneR.pruned, 1, "清掉 1 个孤儿绑定（被删的 key2）")
eq(pruneR.freed[0]?.port, 17942, "释放端口 17942")
eq(bindingOf(loadBindings(), "fakeamd", sha10(key2)), null, "key2 的绑定已删")
eq(bindingOf(loadBindings(), "zcode", "c@duck.com")?.port, 17903, "c@duck.com 登出态但 accountNames 在 → 不清")
eq(pruneOrphanBindings({ managedProviders: ["zcode", "fakeamd"] }, { log: () => {} }).pruned, 0, "二次调用无孤儿可清")

rmSync(root, { recursive: true, force: true })
console.log(`\n${fail ? "❌" : "✅"} ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
