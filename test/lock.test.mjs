import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { acquireLock } from "../lib/lock.mjs"

test("portable process lock excludes competing processes and recovers after a crash", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "出口 锁-")), dir = join(root, "task.lock")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = acquireLock(dir)
  assert.throws(() => acquireLock(dir), { code: "EGRESS_BUSY" })
  release(); release(); assert.equal(existsSync(dir), false)
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireLock } from ${JSON.stringify(new URL("../lib/lock.mjs", import.meta.url).href)}; acquireLock(${JSON.stringify(dir)}); console.log('ready'); setInterval(()=>{}, 1000);`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  t.after(() => { try { child.kill("SIGKILL") } catch {} })
  await once(child.stdout, "data")
  assert.throws(() => acquireLock(dir), { code: "EGRESS_BUSY" })
  const exit = once(child, "exit"); child.kill("SIGKILL"); await exit
  const recovered = acquireLock(dir)
  assert.equal(JSON.parse(readFileSync(join(dir, "owner.json"))).pid, process.pid)
  recovered(); assert.equal(existsSync(dir), false)
})
test("a new lock without metadata is held, and a release never removes a different owner", (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-lock-")), dir = join(root, "lock")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(dir)
  assert.throws(() => acquireLock(dir), { code: "EGRESS_BUSY" })
  rmSync(dir, { recursive: true })
  const release = acquireLock(dir)
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, token: "another-owner" }))
  release(); assert.equal(existsSync(dir), true)
})
