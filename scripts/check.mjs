import { readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const sourceFiles = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = `${dir}/${entry.name}`
  if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sourceFiles(path)
  return /\.(mjs|js)$/.test(entry.name) && entry.name !== "data.js" ? [path] : []
})
const files = ["index.mjs", "server.mjs", "egress-cli.mjs", "manage.mjs", ...["lib", "page", "scripts", "integrations", "test"].flatMap(sourceFiles)]
let failures = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" })
  if (result.status !== 0) { console.error(`${file}\n${result.stderr}`); failures++ }
}
console.log(`Syntax: ${files.length - failures}/${files.length} files passed`)
process.exitCode = failures ? 1 : 0
