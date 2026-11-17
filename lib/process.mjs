import { spawn, execFile } from "node:child_process"

export function killProcessTree(child, { tree = true } = {}) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    // /T 按父进程关系找后代：由这个子进程拉起的常驻进程（出口内核）也会被一起结束，
    // 调用方不想这样时传 tree: false，只结束子进程本身。
    execFile("taskkill.exe", ["/PID", String(child.pid), ...(tree ? ["/T"] : []), "/F"], { windowsHide: true, timeout: 10_000 }, () => {
      try { child.kill("SIGKILL") } catch {}
    })
  } else {
    try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} }
  }
}

export function runProcess(command, args = [], { timeoutMs = 60_000, env = process.env, cwd, maxOutput = 64_000, killTree = true } = {}) {
  return new Promise((resolve) => {
    let child, out = "", timedOut = false, finished = false, timer
    const finish = (code, error) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      resolve({ pid: child?.pid ?? null, timedOut, code: timedOut ? 124 : code, out: timedOut ? `${out}\n任务超时，请查看最近状态后重试` : error ? `${out}\n${error.message}`.trim() : out })
    }
    try { child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) }
    catch (error) { finish(1, error); return }
    const capture = (data) => { out = (out + String(data)).slice(-maxOutput) }
    child.stdout.on("data", capture); child.stderr.on("data", capture)
    child.once("error", (error) => finish(1, error))
    child.once("close", (code) => finish(code ?? 1))
    timer = setTimeout(() => { timedOut = true; killProcessTree(child, { tree: killTree }) }, timeoutMs)
  })
}
