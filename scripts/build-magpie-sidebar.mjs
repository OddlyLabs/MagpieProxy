// Writes reviewable host assets and a unified patch; never alters an installed host.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { patchMagpieNavigation } from "../integrations/magpie/patch.mjs"

const [sourceArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !outputArg) throw new Error("Usage: node scripts/build-magpie-sidebar.mjs <magpie-source-root> <output-directory>")
const source = resolve(sourceArg), out = resolve(outputArg), prefix = "internal/gui/assets/"
if (source === out || out === join(source, "internal/gui/assets")) throw new Error("Output must be separate from the host source")
const original = Object.fromEntries(["pluginpages", "app"].map((name) => [name, readFileSync(join(source, prefix, `${name}.js`), "utf8")]))
const hostLicense = readFileSync(join(source, "LICENSE"), "utf8")
const packageRoot = new URL("../", import.meta.url)
const version = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")).version
const sha256 = (text) => createHash("sha256").update(text).digest("hex")
const patched = patchMagpieNavigation(original), temporary = mkdtempSync(join(tmpdir(), "egress-nav-diff-"))
mkdirSync(out, { recursive: true })
try {
  const patches = []
  for (const [name, value] of Object.entries(patched)) {
    const file = `${name}.js`, before = join(temporary, file), after = join(out, file)
    writeFileSync(before, original[name] ?? ""); writeFileSync(after, value)
    const diff = spawnSync("diff", ["-u", "--label", original[name] === undefined ? "/dev/null" : `a/${prefix}${file}`, "--label", `b/${prefix}${file}`, before, after], { encoding: "utf8" })
    if (diff.status !== 1) throw new Error(diff.stderr || `Could not create ${file} patch`)
    patches.push(diff.stdout)
  }
  const patch = patches.join("")
  writeFileSync(join(out, "sidebar.patch"), patch)
  writeFileSync(join(out, "README.md"), readFileSync(new URL("integrations/magpie/README.md", packageRoot)))
  writeFileSync(join(out, "LICENSE"), readFileSync(new URL("LICENSE", packageRoot)))
  writeFileSync(join(out, "LICENSE.magpie"), hostLicense)
  writeFileSync(join(out, "LICENSE.lucide"), readFileSync(new URL("vendor/lucide/LICENSE", packageRoot)))
  writeFileSync(join(out, "manifest.json"), JSON.stringify({
    pluginVersion: version,
    reference: "https://github.com/yetone/magpie/tree/v0.1.4174",
    sha256: { "sidebar.patch": sha256(patch) },
    files: Object.fromEntries(Object.entries(patched).map(([name, value]) => [prefix + name + ".js", { before: original[name] === undefined ? null : sha256(original[name]), after: sha256(value) }])),
  }, null, 2) + "\n")
  console.log(`Host navigation assets and patch written to ${out}. The running magpie was not changed.`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
