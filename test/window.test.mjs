import { inClaimWindow, dayKeyBeijing, nextWindowAt } from "../lib/claims.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
const cfg = { claimHour: 19, claimWindowHours: 6 }
const Z = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m)
const eq = (a, b, label) => test(label, () => assert.equal(a, b))
eq(inClaimWindow(cfg, Z(13, 10, 59)), false, "18:59BJ 窗口前")
eq(inClaimWindow(cfg, Z(13, 11, 0)), true, "19:00BJ 开窗")
eq(inClaimWindow(cfg, Z(13, 16, 59)), true, "00:59BJ（跨午夜仍在窗口）")
eq(inClaimWindow(cfg, Z(13, 17, 0)), false, "01:00BJ 窗口结束")
eq(inClaimWindow(cfg, Z(13, 20, 0)), false, "04:00BJ 窗口外")
eq(inClaimWindow(cfg, Z(12, 16, 30)), true, "Nov12 16:30Z=Nov13 00:30BJ 在 Nov12 的窗口内")
eq(dayKeyBeijing(Z(12, 16, 30)), "2026-11-13", "dayKey 00:30BJ Nov13")

// claimMinute：窗口自 claimHour:claimMinute 起（与 nextWindowAt 口径一致）
const cfg30 = { claimHour: 19, claimMinute: 30, claimWindowHours: 6 }
eq(inClaimWindow(cfg30, Z(13, 10, 29)), false, "19:29BJ 未开窗（claimMinute=30）")
eq(inClaimWindow(cfg30, Z(13, 11, 30)), true, "19:30BJ 开窗（claimMinute=30）")
eq(inClaimWindow(cfg30, Z(13, 17, 29)), true, "01:29BJ 仍在窗口")
eq(inClaimWindow(cfg30, Z(13, 17, 30)), false, "01:30BJ 窗口结束")
eq(nextWindowAt(cfg30, Z(12, 9, 0)), Z(12, 11, 30), "17:00BJ 下窗=今天 19:30")
eq(nextWindowAt(cfg30, Z(12, 12, 0)), Z(13, 11, 30), "20:00BJ 下窗=明天 19:30")
eq(nextWindowAt(cfg, Z(12, 17, 0)), Z(13, 11, 0), "18:00BJ（Nov13 01:00）下窗=Nov13 19:00")

const midnight = { claimHour: 0, claimMinute: 0, claimWindowHours: 2 }
eq(inClaimWindow(midnight, Z(13, 16, 0)), true, "午夜 0 点按配置开窗，不回退到 19 点")
eq(inClaimWindow(midnight, Z(13, 18, 0)), false, "午夜窗口到 02:00 结束")
eq(nextWindowAt(midnight, Z(13, 15, 59)), Z(13, 16, 0), "午夜窗口的下一次时间为 00:00")
