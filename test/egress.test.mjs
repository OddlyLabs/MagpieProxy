// pickCandidates 单测：跨 /24 轮询、排除、耗尽（bun run test/egress.test.mjs）
import { pickCandidates } from "../lib/egress.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"

const eq = (a, b, label) => test(label, () => assert.deepEqual(a, b))
const P = (name, server) => ({ name, server })

const proxies = [
  P("a2", "1.1.1.7"), P("a1", "1.1.1.9"),                      // /24 A：两个节点（桶内排序 a1, a2）
  P("b1", "2.2.2.3"),                                          // /24 B：一个
  P("c1", "3.3.3.3"), P("c2", "3.3.3.4"), P("c3", "3.3.3.5"), // /24 C：三个
]

// 桶按大小降序（C3 → A2 → B1），每轮各取一个
eq(pickCandidates(proxies, 4), ["c1", "a1", "b1", "c2"], "跨 /24 轮询取 4")
eq(pickCandidates(proxies, 100), ["c1", "a1", "b1", "c2", "a2", "c3"], "limit 超额时返回全部（去重后）")
eq(pickCandidates(proxies, 4, new Set(["c1", "a1"])), ["b1", "c2", "a2", "c3"], "排除已用节点")
eq(pickCandidates([], 3), [], "空订阅")
eq(pickCandidates([P("x", "9.9.9.9"), P("x", "9.9.9.8")], 5), ["x"], "重名节点去重")
eq(pickCandidates([P("d1", "example.com"), P("d2", "example.com")], 5), ["d1", "d2"], "域名 server 同桶轮询")
