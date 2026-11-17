// Write beside the destination so rename stays atomic, even across concurrent hosts.
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export function writeFileAtomic(path, contents, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  try { mode = statSync(path).mode & 0o777 } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { mode, flag: "wx" })
    // Windows scanners can briefly hold the destination without FILE_SHARE_DELETE.
    // Retry the atomic rename; never unlink a working configuration to make room.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, path); break }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 20) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(15 + attempt * 5, 80))
      }
    }
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

// Windows 记事本和 PowerShell 5.1 保存的 UTF-8 文件常带 BOM，JSON.parse 不接受它。
export const parseJson = (text) => JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE", "EAGAIN"])
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 读不到或解析失败回落到 fallback：调用方把「文件还没生成」当正常状态处理。
// 但文件被另一个进程短暂占用（Windows 上改名替换、杀毒扫描）不等于不存在：
// 先重试几次，免得调用方拿着默认值把真实数据覆盖掉。
export const readJson = (path, fallback = null) => {
  for (let attempt = 0; ; attempt++) {
    let text
    try { text = readFileSync(path, "utf8") } catch (error) {
      if (TRANSIENT.has(error.code) && attempt < 8) { nap(25); continue }
      return fallback
    }
    try { return parseJson(text) } catch { return fallback }
  }
}

export const writeJsonAtomic = (path, value, options) =>
  writeFileAtomic(path, JSON.stringify(value, null, 1) + "\n", options)
