import assert from "node:assert/strict"
import { test } from "node:test"
import { applyConfigPatch } from "../lib/config.mjs"
import { DEFAULT_CONFIG } from "../lib/store.mjs"

test("midnight and minute zero are saved exactly, including numeric strings", () => {
  const next = applyConfigPatch({ ...DEFAULT_CONFIG, claimHour: 19, claimMinute: 30 }, { claimHour: 0, claimMinute: "0" })
  assert.equal(next.claimHour, 0); assert.equal(next.claimMinute, 0)
})
test("invalid settings fail atomically instead of silently coercing or clamping", () => {
  const current = { ...DEFAULT_CONFIG }
  for (const patch of [{ claimHour: 24 }, { claimMinute: -1 }, { claimWindowHours: 0 }, { claimIntervalMin: 1.5 }, { checkIntervalMin: "" }, { apiPort: 65536 }, { sparesCount: null }, { claimEnabled: "false" }, { autoAssignNew: 0 }, { backend: "unknown" }, { mirror: "javascript:alert(1)" }, { managedProviders: [{}] }]) assert.throws(() => applyConfigPatch(current, patch))
  assert.deepEqual(current, DEFAULT_CONFIG)
})
test("settings preserve unknown stored metadata but never accept it from a patch", () => {
  const next = applyConfigPatch({ ...DEFAULT_CONFIG, lastRequest: "owned" }, { lastRequest: "injected", claimHour: 0, managedProviders: [" zcode ", "zcode", "atlas"] })
  assert.equal(next.lastRequest, "owned"); assert.equal(next.claimHour, 0)
  assert.deepEqual(next.managedProviders, ["zcode", "atlas"])
})
test("the full spare range must fit valid ports", () => {
  assert.throws(() => applyConfigPatch(DEFAULT_CONFIG, { spareBase: 65530, sparesCount: 8 }), /65535/)
  assert.equal(applyConfigPatch(DEFAULT_CONFIG, { spareBase: 65528, sparesCount: 8 }).spareBase, 65528)
})
