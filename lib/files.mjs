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
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 12) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
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

// 读不到或解析失败一律回落到 fallback：调用方把「文件还没生成」当正常状态处理。
export const readJson = (path, fallback = null) => {
  try { return parseJson(readFileSync(path, "utf8")) } catch { return fallback }
}

export const writeJsonAtomic = (path, value, options) =>
  writeFileAtomic(path, JSON.stringify(value, null, 1) + "\n", options)
