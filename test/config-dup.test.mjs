// 回归：主出口与备用池撞名时，配置必须仍然唯一可加载（2026-11-14 502 事故）
// 事故链：换绑把备用节点挂成主出口 → 重建配置写出两条同名 proxy →
// mihomo 启动 fatal → 容器无限重启 → 全部 socks5 端口消失 → magpie 502。
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildEgressConfig, validateEgressConfig, writeConfig } from "../lib/mihomo.mjs"

const node = (name, server) => ({ name, type: "ss", server, port: 1080 })

test("同一节点既在主出口又在备用池：proxies 去重、listeners 数量不变", () => {
  const conf = buildEgressConfig({
    proxies: [node("A", "1.1.1.1"), node("B", "2.2.2.2"), node("C", "3.3.3.3")],
    assignments: { 17901: { node: "A" }, 17902: { node: "B" } },
    spares: [{ node: "A" }, { node: "C" }],
    sparePortBase: 17931,
    controller: "127.0.0.1:19093",
    withGroups: true,
  })
  const names = conf.proxies.map((p) => p.name)
  assert.equal(new Set(names).size, names.length, "proxies 不能有重名")
  assert.equal(conf.listeners.length, 4)
  assert.deepEqual(validateEgressConfig(conf), [])
})

test("自检能抓出重名节点（mihomo 会 fatal 的那种配置）", () => {
  const bad = {
    proxies: [node("A", "1.1.1.1"), node("A", "1.1.1.1")],
    listeners: [{ name: "eg-17901", type: "socks", port: 17901, listen: "127.0.0.1", proxy: "A" }],
  }
  assert.ok(validateEgressConfig(bad).some((p) => p.includes("节点名重复")))
})

test("自检能抓出重复监听端口和指向不存在的 listener", () => {
  const bad = buildEgressConfig({
    proxies: [node("A", "1.1.1.1")],
    assignments: { 17901: { node: "A" } },
    spares: [],
    sparePortBase: 17931,
    controller: "127.0.0.1:19093",
    withGroups: false,
  })
  bad.listeners.push({ ...bad.listeners[0] })
  bad.listeners.push({ name: "x", type: "socks", port: 17999, listen: "127.0.0.1", proxy: "NOPE" })
  const problems = validateEgressConfig(bad)
  assert.ok(problems.some((p) => p.includes("监听端口重复")))
  assert.ok(problems.some((p) => p.includes("不存在")))
})

test("writeConfig 拒绝坏配置，且不会留下写了一半的文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-"))
  const target = join(dir, "config.yaml")
  const bad = {
    proxies: [node("A", "1.1.1.1"), node("A", "1.1.1.1")],
    listeners: [],
    rules: ["MATCH,DIRECT"],
  }
  assert.throws(() => writeConfig(target, bad), /配置自检失败/)
  assert.throws(() => readFileSync(target), /ENOENT/, "坏配置不能落盘")
})

test("好配置正常写入（JSON 形式 YAML）", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-"))
  const target = join(dir, "config.yaml")
  const conf = buildEgressConfig({
    proxies: [node("A", "1.1.1.1")],
    assignments: { 17901: { node: "A" } },
    spares: [],
    sparePortBase: 17931,
    controller: "127.0.0.1:19093",
    withGroups: false,
  })
  writeConfig(target, conf)
  const back = JSON.parse(readFileSync(target, "utf8"))
  assert.equal(back.proxies.length, 1)
  assert.equal(back.listeners[0].port, 17901)
})
