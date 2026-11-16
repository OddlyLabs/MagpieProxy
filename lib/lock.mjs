// Atomic mkdir works on NTFS, APFS and Unix filesystems; no external flock.
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

export class LockBusyError extends Error {
  constructor() { super("已有出口任务在执行，请稍后再试"); this.code = "EGRESS_BUSY" }
}
const ownerOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) } catch { return null } }
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
const abandoned = (dir) => {
  const owner = ownerOf(dir)
  if (owner?.pid) return !alive(owner.pid)
  try { return Date.now() - statSync(dir).mtimeMs > 30_000 } catch { return false }
}

export function acquireLock(dir) {
  mkdirSync(dirname(dir), { recursive: true })
  const token = randomUUID(), reaper = dir + ".reclaim"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir, { mode: 0o700 })
      try { writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 0o600, flag: "wx" }) }
      catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
      let released = false
      return () => {
        if (released) return
        released = true
        if (ownerOf(dir)?.token === token) rmSync(dir, { recursive: true, force: true })
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!abandoned(dir)) throw new LockBusyError()
      // Only one process may reclaim a dead owner's directory. Recheck after
      // acquiring the recovery guard so a new owner is never removed.
      try {
        mkdirSync(reaper, { mode: 0o700 })
        writeFileSync(join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 })
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        if (abandoned(reaper)) rmSync(reaper, { recursive: true, force: true })
        throw new LockBusyError()
      }
      try { if (abandoned(dir)) rmSync(dir, { recursive: true, force: true }) }
      finally { if (ownerOf(reaper)?.token === token) rmSync(reaper, { recursive: true, force: true }) }
    }
  }
  throw new LockBusyError()
}
