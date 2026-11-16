import { gunzipSync } from "node:zlib"
import { unzipSync } from "../vendor/fflate/index.mjs"
import { createHash } from "node:crypto"

export const MIHOMO_VERSION = "1.19.34"
// Digests published by MetaCubeX's GitHub release API for v1.19.34.
const RELEASE_DIGESTS = {
  "mihomo-darwin-amd64-compatible-v1.19.34.gz": "703bceaa494732fa456f47e6ac2f06bf0bc5593d4c927d5f61e10f1a31039c37",
  "mihomo-darwin-arm64-v1.19.34.gz": "1a7a20eca63fbbaec90137717465bfde488d0db2a3a79b8fadebf9b2545b6e4c",
  "mihomo-linux-amd64-compatible-v1.19.34.gz": "2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06",
  "mihomo-linux-arm64-v1.19.34.gz": "daaf78a6240a282cdfd75bcbf98fe321f6bd52765cc29e79f344191198f0b50f",
  "mihomo-windows-amd64-compatible-v1.19.34.zip": "cd6738d4648cc1a5f48049a1343b697ab510889d648f045c5c780fc1ab443a79",
  "mihomo-windows-arm64-v1.19.34.zip": "076cb04a21377675bcf009b8d1dd83006ce2464aa537e37bce1faf6d3504f554",
}
export function verifyMihomo(archive, asset) {
  const digest = RELEASE_DIGESTS[asset]
  if (!digest) throw new Error("此版本尚未录入内核校验值，请更新插件或手动安装内核")
  if (createHash("sha256").update(archive).digest("hex") !== digest) throw new Error("mihomo SHA-256 校验失败，请重试或更换下载镜像")
}
export function mihomoAsset(version = MIHOMO_VERSION, platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", linux: "linux", darwin: "darwin" }[platform]
  const cpu = { x64: "amd64-compatible", arm64: "arm64" }[arch]
  if (!os || !cpu) throw new Error(`暂不支持自动下载：${platform}/${arch}；请自行安装 mihomo 内核`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("无效的 mihomo 版本号")
  return `mihomo-${os}-${cpu}-v${version}.${platform === "win32" ? "zip" : "gz"}`
}

export function unpackMihomo(archive, platform = process.platform) {
  let result
  if (platform === "win32") {
    const files = unzipSync(new Uint8Array(archive), { filter: (file) => {
      const wanted = /^mihomo[^/\\]*\.exe$/i.test(file.name)
      if (wanted && file.originalSize > 128 * 1024 * 1024) throw new Error("mihomo 内核文件过大")
      return wanted
    } })
    const entries = Object.values(files)
    if (entries.length !== 1) throw new Error("Windows 安装包必须包含一个 mihomo.exe")
    result = Buffer.from(entries[0])
    if (result.subarray(0, 2).toString() !== "MZ") throw new Error("不是 Windows 可执行文件")
  } else {
    result = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
    if (platform === "linux" && result.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("不是 Linux 可执行文件")
    if (platform === "darwin" && !["cffaedfe", "cefaedfe", "feedfacf", "cafebabe"].includes(result.subarray(0, 4).toString("hex"))) throw new Error("不是 macOS 可执行文件")
  }
  if (result.length < 5 * 1024 * 1024) throw new Error("mihomo 内核文件不完整")
  return result
}

export async function downloadBytes(url, { maxBytes = 64 * 1024 * 1024, timeoutMs = 240_000 } = {}) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`下载 HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("下载文件过大") }
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error("下载文件过大")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
