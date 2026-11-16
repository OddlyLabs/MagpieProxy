// claimKey 单测（名额机制已随一号一 IP 设计移除）：bun run test/claims.test.mjs
import { claimKey } from "../lib/claims.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"

const eq = (a, b, label) => test(label, () => assert.equal(a, b))

eq(claimKey("zcode-v3-start-plan-1112"), "1112|", "基础批次")
eq(claimKey("zcode-v3-start-plan-1112-wk"), "1112|wk", "周末批次")
eq(claimKey("zcode-v3-start-plan-1112-1"), "1112|", "entitlement 尾巴")
eq(claimKey("other-plan"), "other-plan", "未知 id 原样")
