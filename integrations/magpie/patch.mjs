import { readFileSync } from "node:fs"

const root = new URL("../../", import.meta.url)
const exact = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error(`Unsupported magpie source: ${label} must occur exactly once`)
  return source.replace(before, after)
}
const shapes = () => {
  const aliases = JSON.parse(readFileSync(new URL("vendor/lucide/manifest.json", root), "utf8")).aliases
  return Object.fromEntries(["logo", "cloud", "clock", "users", "key", "chevron"].map((name) => {
    const svg = readFileSync(new URL(`vendor/lucide/icons/${aliases[name]}.svg`, root), "utf8")
    return [name, [...svg.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\/?\s*>/g)].map(([, tag, attrs]) => [tag, Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]))])]
  }))
}

export function patchMagpieNavigation({ pluginpages, app }) {
  if (pluginpages.includes("Egress page navigation extension")) throw new Error("The navigation extension is already present")
  exact(app, 'function navSubs() {\n  if (mode !== "window") return;', 'function navSubs() {\n  if (mode !== "window") return;', "navigation renderer")
  const start = '  async function answer(p, m) {'
  const end = '\n\n  addEventListener("message", async (ev) => {'
  if (pluginpages.split(start).length !== 2 || pluginpages.split(end).length !== 2) throw new Error("Unsupported magpie source: page bridge dispatcher must occur exactly once")
  const originalAnswer = pluginpages.slice(pluginpages.indexOf(start), pluginpages.indexOf(end))
  const answer = exact(originalAnswer, '    switch (m.method) {', '    switch (m.method) {\n      case "navigation.set":\n        return setPageNavigation(p, m.params);', "bridge method switch")
  const license = readFileSync(new URL("vendor/lucide/LICENSE", root), "utf8").replaceAll("*/", "* /")
  const template = readFileSync(new URL("navigation-host.js", import.meta.url), "utf8").replace("__LUCIDE_NAVIGATION_SHAPES__", JSON.stringify(shapes())).replace("__MAGPIE_PAGE_ANSWER__", answer)
  const host = `/* Lucide icons, ISC license:\n${license}\n*/\n${template.trimEnd()}\n`
  const dispatch = `  // Egress page navigation extension v2: the dispatcher loads on the first page message.\n  let pageNavigation, pageNavigationLoading;\n  async function answer(p, m) {\n    pageNavigation ||= await (pageNavigationLoading ||= import("./egress-navigation.js").then(({ default: install }) => install({ pages, post, theme, titled })));\n    return pageNavigation.answer(p, m);\n  }`
  pluginpages = exact(pluginpages, originalAnswer, dispatch, "page bridge dispatcher")
  pluginpages = exact(pluginpages, '      p.gone = true;', '      p.gone = true;\n      pageNavigation?.remove(k);', "plugin removal")
  pluginpages = exact(pluginpages, '      p.frame.remove();', '      pageNavigation?.remove(key);\n      p.frame.remove();', "idle page removal")
  pluginpages = exact(pluginpages, '      } else if (p.entry.url !== e.url || p.gone) {', '      } else if (p.entry.url !== e.url || p.gone) {\n        pageNavigation?.remove(e.key);', "page replacement")
  return { pluginpages, "egress-navigation": host }
}
