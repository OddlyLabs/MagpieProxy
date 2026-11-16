import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
test("opening diagnostics and stopping an already stopped service work on fresh installs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-manage-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, ZCODE_EGRESS_DATA: join(root, "data"), ZCODE_EGRESS_MAGPIE_DIR: join(root, "magpie") }
  const cli = fileURLToPath(new URL("../manage.mjs", import.meta.url))
  const state = JSON.parse((await run(process.env.TEST_RUNTIME || process.execPath, [cli, "status", "--json"], { env })).stdout)
  assert.equal(state.available, false); assert.equal(state.running, false)
  const stopped = JSON.parse((await run(process.env.TEST_RUNTIME || process.execPath, [cli, "stop", "--json"], { env })).stdout)
  assert.equal(stopped.ok, true)
  try { await run(process.env.TEST_RUNTIME || process.execPath, [cli, "doctor", "--json"], { env }); assert.fail("An unregistered copy must not pass installation checks") }
  catch (error) {
    const result = JSON.parse(error.stdout)
    assert.equal(result.ok, false); assert.equal(result.registered, false); assert.equal(result.service, "stopped"); assert.equal(result.error, undefined)
  }
})
