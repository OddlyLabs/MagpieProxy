// Print the text of a GitHub Release: the generated RELEASE.md followed by this
// version's section of CHANGELOG.md. Fails when the changelog has no such section.
// usage: node scripts/release-notes.mjs <path to RELEASE.md>
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (!process.argv[2]) throw new Error("usage: node scripts/release-notes.mjs <path to RELEASE.md>")
const intro = readFileSync(process.argv[2], "utf8").trimEnd()
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n")
const start = lines.findIndex((line) => line === `# ${version}` || line.startsWith(`# ${version} `))
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`)
let end = lines.findIndex((line, index) => index > start && line.startsWith("# "))
if (end < 0) end = lines.length
const title = lines[start].slice(2 + version.length).replace(/^[\s·]+/, "")
const changes = lines.slice(start + 1, end).join("\n").trim()
process.stdout.write(`${intro}\n\n---\n\n# 本版更新${title ? `：${title}` : ""}\n\n${changes}\n`)
