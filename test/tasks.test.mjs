import assert from "node:assert/strict"
import { test } from "node:test"
import { TaskRunner, rememberReceipt } from "../lib/tasks.mjs"
test("overlapping jobs are rejected and failures always release the task gate", async () => {
  const runner = new TaskRunner(), states = []
  runner.onChange = () => states.push(runner.active?.action || null)
  let release
  const first = runner.run("assign", () => new Promise((resolve) => { release = resolve }), "request-1")
  assert.equal(runner.active.requestId, "request-1")
  await assert.rejects(runner.run("swap", () => assert.fail("must never run")), { statusCode: 409 })
  release("done"); assert.equal(await first, "done")
  await assert.rejects(runner.run("config", () => { throw new Error("disk full") }), /disk full/)
  assert.equal(runner.active, null)
  assert.deepEqual(states, ["assign", null, "config", null])
})
test("heartbeats retain action receipts for a page that missed the initial acknowledgement", () => {
  const completed = rememberReceipt({}, "action-1", { action: "config", kind: "ok", message: "saved" })
  const heartbeat = rememberReceipt(completed, "heartbeat-1")
  assert.equal(heartbeat.lastRequest, "heartbeat-1")
  assert.equal(heartbeat.requestResults.find((r) => r.id === "action-1").message, "saved")
  const again = rememberReceipt(heartbeat, "action-1", { action: "config", kind: "err", message: "changed" })
  assert.equal(again.requestResults.filter((r) => r.id === "action-1").length, 1)
})
