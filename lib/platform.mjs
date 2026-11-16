import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Magpie uses ~/.config/magpie on every OS. Its plugin input.directory is
// authoritative for portable installations and alternate profiles.
export function defaultMagpieDir({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix
  return p.join(env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, ".config"), "magpie")
}

export function resolveDataDir({ env = process.env, home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix
  if (env.ZCODE_EGRESS_DATA) return p.join(env.ZCODE_EGRESS_DATA, "magpie-zcode-egress")
  const normal = defaultMagpieDir({ env, home, platform })
  const samePath = (a, b) => platform === "win32" ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase() : p.resolve(a) === p.resolve(b)
  if (env.ZCODE_EGRESS_MAGPIE_DIR && !samePath(env.ZCODE_EGRESS_MAGPIE_DIR, normal)) {
    return p.join(env.ZCODE_EGRESS_MAGPIE_DIR, "zcode-egress")
  }
  if (env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME)) return p.join(env.XDG_DATA_HOME, "magpie-zcode-egress")
  const legacy = p.join(home, ".local", "share", "magpie-zcode-egress")
  if (exists(p.join(legacy, "config.json")) || exists(p.join(legacy, "bindings.json"))) return legacy
  const root = platform === "win32" ? env.LOCALAPPDATA || p.join(home, "AppData", "Local")
    : platform === "darwin" ? p.join(home, "Library", "Application Support") : p.join(home, ".local", "share")
  return p.join(root, "magpie-zcode-egress")
}

// Magpie lists a folder plugin by its path. A git or npm plugin is listed by
// its source and installed into <magpie>/plugins/node_modules/<package name>;
// for git, plugins/package.json maps that name back to the listed source.
export function findRegistration({ entries = [], dependencies = {}, root, magpieDir, name, platform = process.platform } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix
  const samePath = (a, b) => platform === "win32" ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase() : p.resolve(a) === p.resolve(b)
  const listed = (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry?.spec === "string")
  const folder = listed.find((entry) => samePath(entry.spec, root))
  if (folder) return folder
  if (!name || !magpieDir || !samePath(p.join(magpieDir, "plugins", "node_modules", ...name.split("/")), root)) return null
  const packageOf = (spec) => spec.lastIndexOf("@") > 0 ? spec.slice(0, spec.lastIndexOf("@")) : spec
  return listed.find((entry) => entry.spec === dependencies?.[name] || packageOf(entry.spec) === name) ?? null
}

export const executableName = (name, platform = process.platform) => name + (platform === "win32" ? ".exe" : "")

export function browserCandidates({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix
  const candidates = [env.ZCODE_CHROME_PATH]
  if (platform === "win32") {
    for (const root of [env.PROGRAMFILES, env["ProgramFiles(x86)"], env.LOCALAPPDATA, "C:\\Program Files", "C:\\Program Files (x86)"]) {
      if (root) candidates.push(p.join(root, "Google", "Chrome", "Application", "chrome.exe"), p.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
    }
  } else if (platform === "darwin") {
    for (const root of ["/Applications", p.join(home, "Applications")]) {
      candidates.push(p.join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), p.join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"), p.join(root, "Chromium.app", "Contents", "MacOS", "Chromium"))
    }
  } else candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser")
  return [...new Set(candidates.filter(Boolean))]
}

export function nativeDisplayReady({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  return platform === "win32" || platform === "darwin" || !!env.DISPLAY || exists("/usr/bin/xvfb-run")
}
