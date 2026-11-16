import { readdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
const directory = new URL("../test/", import.meta.url)
const files = readdirSync(directory).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => fileURLToPath(new URL(name, directory)))
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit", windowsHide: true })
child.once("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.once("exit", (code) => { process.exitCode = code ?? 1 })
