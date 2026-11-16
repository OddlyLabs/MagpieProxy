import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { writeJsonAtomic, writeFileAtomic, readJson } from "../lib/files.mjs"
test("JSON saved with a UTF-8 BOM by Windows editors is still readable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-bom-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "providers.json")
  writeFileSync(path, "﻿" + JSON.stringify({ providers: [{ id: "atlas" }] }))
  assert.deepEqual(readJson(path), { providers: [{ id: "atlas" }] })
  writeFileSync(path, "﻿{broken")
  assert.equal(readJson(path, "fallback"), "fallback")
  assert.equal(readJson(join(root, "missing.json")), null)
})
test("atomic writes preserve permissions and leave a destination intact on failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-files-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "nested", "config.json")
  writeJsonAtomic(path, { value: 1 }); if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600)
  writeJsonAtomic(path, { value: 2 }); assert.deepEqual(JSON.parse(readFileSync(path)), { value: 2 })
  const directory = join(root, "directory"); mkdirSync(directory)
  assert.throws(() => writeFileAtomic(directory, "cannot replace a directory"))
  assert.ok(statSync(directory).isDirectory())
  assert.ok(readdirSync(root).every((name) => !name.endsWith(".tmp")))
})
test("concurrent hosts use distinct temporary files and only publish complete JSON", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-concurrent-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "shared.json"), moduleUrl = new URL("../lib/files.mjs", import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, (_, id) => new Promise((resolve, reject) => {
    const worker = new Worker(`const { workerData } = require('node:worker_threads'); import(workerData.moduleUrl).then(({writeJsonAtomic}) => { for (let i=0; i<30; i++) writeJsonAtomic(workerData.path, { id: workerData.id, value: 'x'.repeat(4000), i }); });`, { eval: true, workerData: { path, moduleUrl, id } })
    worker.on("error", reject); worker.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)))
  })))
  const result = JSON.parse(readFileSync(path))
  assert.equal(result.value.length, 4000); assert.equal(result.i, 29)
  assert.deepEqual(readdirSync(root), ["shared.json"])
})
