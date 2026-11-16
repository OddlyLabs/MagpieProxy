// 插件代码指纹：server.mjs / index.mjs 共用。gen 变了 = 代码变了，
// sidecar 该换代（旧进程退位）。
import { readFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = join(dirname(fileURLToPath(import.meta.url)), "..")

export const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version ?? "" } catch { return "" }
})()

export const GEN = PLUGIN_VERSION + "@" + (() => {
  const hash = createHash("sha256")
  const files = ["server.mjs", "index.mjs", "egress-cli.mjs", ...readdirSync(join(here, "lib")).filter((name) => name.endsWith(".mjs")).sort().map((name) => `lib/${name}`)]
  for (const file of files) hash.update(file).update(readFileSync(join(here, file)))
  return hash.digest("hex").slice(0, 16)
})()
