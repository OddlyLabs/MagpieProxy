import assert from "node:assert/strict"
import { test } from "node:test"
import { gzipSync } from "node:zlib"
import { defaultMagpieDir, resolveDataDir, executableName, browserCandidates, nativeDisplayReady, findRegistration } from "../lib/platform.mjs"
import { mihomoAsset, unpackMihomo, verifyMihomo } from "../lib/download.mjs"
import { zipSync } from "../vendor/fflate/index.mjs"

test("Windows installed and portable profiles resolve writable native paths", () => {
  const options = { platform: "win32", home: "C:\\Users\\测试 用户", env: { LOCALAPPDATA: "D:\\用户 数据\\Local" }, exists: () => false }
  assert.equal(defaultMagpieDir(options), "C:\\Users\\测试 用户\\.config\\magpie")
  assert.equal(resolveDataDir(options), "D:\\用户 数据\\Local\\magpie-zcode-egress")
  assert.equal(resolveDataDir({ ...options, env: { ...options.env, ZCODE_EGRESS_MAGPIE_DIR: "E:\\便携 软件\\Magpie\\data" } }), "E:\\便携 软件\\Magpie\\data\\zcode-egress")
  assert.equal(resolveDataDir({ ...options, env: { ZCODE_EGRESS_DATA: "F:\\出口 数据", ZCODE_EGRESS_MAGPIE_DIR: "E:\\portable\\data" } }), "F:\\出口 数据\\magpie-zcode-egress")
})
test("existing data wins over new defaults, and unrelated portable profiles stay separate", () => {
  const opts = { platform: "darwin", home: "/Users/test", env: {}, exists: (p) => p === "/Users/test/.local/share/magpie-zcode-egress/config.json" }
  assert.equal(resolveDataDir(opts), "/Users/test/.local/share/magpie-zcode-egress")
  assert.equal(resolveDataDir({ ...opts, exists: () => false }), "/Users/test/Library/Application Support/magpie-zcode-egress")
  assert.equal(resolveDataDir({ ...opts, env: { ZCODE_EGRESS_MAGPIE_DIR: "/Volumes/USB/Magpie/data" } }), "/Volumes/USB/Magpie/data/zcode-egress")
  assert.equal(resolveDataDir({ platform: "linux", home: "/home/test", env: { XDG_DATA_HOME: "/data" }, exists: () => false }), "/data/magpie-zcode-egress")
})
test("a copy added from a folder, a git repository or npm is recognised as registered", () => {
  const name = "magpie-zcode-egress", magpieDir = "C:\\Users\\测试 用户\\.config\\magpie"
  const installed = `${magpieDir}\\plugins\\node_modules\\${name}`, folder = "D:\\便携 软件\\local-plugins\\magpie-zcode-egress"
  const git = { spec: "github:OddlyLabs/MagpieProxy" }, other = { spec: "github:someone/another-plugin" }
  const dependencies = { [name]: git.spec, "another-plugin": other.spec }
  const find = (options) => findRegistration({ platform: "win32", magpieDir, name, dependencies, ...options })
  assert.equal(find({ entries: [other, { spec: folder.toUpperCase(), off: true }], root: folder }).off, true)
  assert.equal(find({ entries: [other, git], root: installed }), git)
  assert.equal(find({ entries: [{ spec: `${name}@latest` }], dependencies: { [name]: "1.1.0" }, root: installed }).spec, `${name}@latest`)
  // Listed sources never stand for a copy somewhere else, and an unlisted package is not registered.
  assert.equal(find({ entries: [other, git], root: folder }), null)
  assert.equal(find({ entries: [other], root: installed }), null)
  assert.equal(find({ entries: [git], dependencies: {}, root: installed }), null)
  assert.equal(find({ entries: undefined, dependencies: undefined, root: installed }), null)
  const unix = { platform: "linux", magpieDir: "/home/test/.config/magpie", name: "@scope/egress", dependencies: { "@scope/egress": "owner/repo#main" } }
  assert.equal(findRegistration({ ...unix, entries: [{ spec: "owner/repo#main" }], root: "/home/test/.config/magpie/plugins/node_modules/@scope/egress" }).spec, "owner/repo#main")
  assert.equal(findRegistration({ ...unix, entries: [{ spec: "/opt/Egress" }], root: "/opt/egress" }), null)
})
test("Windows and macOS use native browsers without DISPLAY or Xvfb", () => {
  for (const platform of ["win32", "darwin"]) assert.equal(nativeDisplayReady({ platform, env: {}, exists: () => false }), true)
  assert.equal(nativeDisplayReady({ platform: "linux", env: {}, exists: () => false }), false)
  assert.equal(nativeDisplayReady({ platform: "linux", env: {}, exists: (p) => p === "/usr/bin/Xvfb" }), false)
  assert.equal(nativeDisplayReady({ platform: "linux", env: {}, exists: (p) => p === "/usr/bin/xvfb-run" }), true)
  assert.ok(browserCandidates({ platform: "win32", home: "C:\\Users\\test", env: { LOCALAPPDATA: "D:\\个人 应用" } }).includes("D:\\个人 应用\\Microsoft\\Edge\\Application\\msedge.exe"))
  assert.ok(browserCandidates({ platform: "darwin", home: "/Users/test", env: {} }).includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
  assert.equal(executableName("mihomo", "win32"), "mihomo.exe")
})
test("release assets match the actual Windows ZIP and Unix gzip naming", () => {
  for (const platform of ["win32", "linux", "darwin"]) for (const arch of ["x64", "arm64"]) {
    const name = mihomoAsset("1.19.34", platform, arch)
    assert.match(name, platform === "win32" ? /\.zip$/ : /\.gz$/)
    assert.ok(name.includes(arch === "x64" ? "amd64-compatible" : "arm64"))
  }
  assert.throws(() => mihomoAsset("1.19.34", "linux", "riscv64"), /不支持/)
})
test("native extraction rejects incomplete and ambiguous archives before publication", () => {
  const binary = Buffer.alloc(5 * 1024 * 1024); binary.write("MZ")
  const zipped = zipSync({ "mihomo-windows-arm64.exe": binary, "README.txt": new Uint8Array([65]) })
  assert.deepEqual(unpackMihomo(zipped, "win32"), binary)
  assert.throws(() => unpackMihomo(zipSync({ "../mihomo.exe": binary }), "win32"), /一个/)
  assert.throws(() => unpackMihomo(zipSync({ "mihomo-a.exe": binary, "mihomo-b.exe": binary }), "win32"), /一个/)
  assert.throws(() => unpackMihomo(zipSync({ "mihomo.exe": new Uint8Array([77, 90]) }), "win32"), /不完整/)
  binary.write("\x7fELF")
  assert.deepEqual(unpackMihomo(gzipSync(binary), "linux"), binary)
  assert.throws(() => verifyMihomo(zipped, mihomoAsset("1.19.34", "win32", "arm64")), /SHA-256/)
})
