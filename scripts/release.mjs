// Build reviewable archives from an explicit allowlist. No runtime state is copied.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { zipSync } from "../vendor/fflate/index.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Release version must be x.y.z")
const output = resolve(process.argv[2] || join(root, "..", "releases", `v${pkg.version}`))
mkdirSync(output, { recursive: true })
const excluded = /(?:^|\/)(?:node_modules|test-results|playwright-report|data\.js|installation\.json|diagnostics\.txt)(?:\/|$)|\.bak-|\.(?:log|pid|tmp)$/
const collect = (relative) => {
  if (excluded.test(relative)) return []
  if (relative.includes("*")) {
    if (relative !== "lib/*.mjs") throw new Error(`Unsupported release glob: ${relative}`)
    return readdirSync(join(root, "lib")).filter((name) => name.endsWith(".mjs")).map((name) => `lib/${name}`)
  }
  const info = statSync(join(root, relative))
  return info.isDirectory() ? readdirSync(join(root, relative)).flatMap((name) => collect(`${relative}/${name}`)) : [relative]
}
const runtime = [...new Set(["package.json", ...pkg.files].flatMap(collect))].sort()
const source = [...new Set([...runtime, ...["scripts", "test", "integrations", ".github", "package-lock.json", "playwright.config.mjs", ".gitignore", ".gitattributes", ".npmignore", "CLAUDE.md", "HANDOFF.md"].flatMap(collect)])].sort()
const stamp = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date("2026-11-15T00:00:00Z")
// The project is published as MagpieProxy; the package keeps its original name
// because installers, data folders and upgrades are keyed on it.
const brand = "MagpieProxy", repository = "OddlyLabs/MagpieProxy"
function archive(name, files) {
  const items = {}
  for (const file of files) {
    const data = readFileSync(join(root, file))
    // Windows reports no execute bit, so a script is recognised by its first line.
    const mode = data.subarray(0, 2).toString("latin1") === "#!" ? 0o100755 : 0o100644
    items[`${brand}-${pkg.version}/${file}`] = [new Uint8Array(data), { mtime: stamp, os: 3, attrs: (mode << 16) >>> 0 }]
  }
  writeFileSync(join(output, name), zipSync(items, { level: 9 }))
}
const installZip = `${brand}-${pkg.version}.zip`, sourceZip = `${brand}-${pkg.version}-source.zip`
archive(installZip, runtime); archive(sourceZip, source)
if (!process.env.npm_execpath) throw new Error("Run with npm run release so npm can be called without a shell on Windows")
// npm ≤ 11 prints an array; npm 12 prints an object keyed by package name.
const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: root, encoding: "utf8" }))
const pack = Array.isArray(packed) ? packed[0] : Object.values(packed ?? {})[0]
if (!pack?.filename || !Array.isArray(pack.files)) throw new Error("npm pack did not report the packed files")
for (const entry of pack.files) if (excluded.test(entry.path)) throw new Error(`Unexpected runtime file: ${entry.path}`)
const note = `# ${brand}（出口管家）${pkg.version}\n\n使用 magpie 官方插件入口，不需要宿主补丁或自定义 magpie 程序。\n\n最快的安装方式不需要下载：在终端执行 \`magpie plugin add github:${repository}\`，或在 magpie 的「插件 → 添加插件」中填入 \`github:${repository}\`。\n\n- ${installZip}：直接解压的安装包。Windows 双击 Install.cmd；以后用 Open.cmd；故障运行 Diagnose.cmd。\n- ${sourceZip}：完整开发源码、测试、CI 配置和许可证。\n- ${pack.filename}：npm 格式运行包，未发布到 npm。\n\nWindows 安装器自动注册和启用插件，支持便携目录及中文／空格路径，升级保留运行数据并备份旧文件。两种安装方式选一种即可，运行数据通用。\n入口：magpie 导航「插件 → 出口管家」、设置面板、供应商菜单，或本机浏览器。\n\n运行文件 ${runtime.length} 个，源码文件 ${source.length} 个。包内不含账号、订阅、运行快照、机器安装信息或日志，也不附宿主和 mihomo 二进制。测试目录中的证书和示例凭据是虚构测试数据。\n\n验证范围与系统限制详见 docs/VALIDATION.md；快速步骤见 QUICKSTART.md。\n\n校验：Linux 运行 sha256sum -c SHA256SUMS.txt；Windows 可用 Get-FileHash -Algorithm SHA256。\n`
writeFileSync(join(output, "RELEASE.md"), note)
const names = [installZip, sourceZip, pack.filename, "RELEASE.md"]
writeFileSync(join(output, "SHA256SUMS.txt"), names.map((name) => `${createHash("sha256").update(readFileSync(join(output, name))).digest("hex")}  ${name}\n`).join(""))
console.log(JSON.stringify({ output, runtimeFiles: runtime.length, sourceFiles: source.length, npmFiles: pack.files.length, files: names }, null, 2))
