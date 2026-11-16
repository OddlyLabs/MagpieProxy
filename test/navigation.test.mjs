import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { Script } from "node:vm"
import { patchMagpieNavigation } from "../integrations/magpie/patch.mjs"
import "../page/model.js"

test("navigation represents managed providers, counts and available pages without account data", () => {
  const snapshot = { sources: { total: 24 }, providers: [
    { id: "zcode", name: "ZCode", kind: "login", managed: true, accounts: [{ id: "private@example.com" }] },
    { id: "other", name: "Not managed", managed: false, accounts: [] },
    { id: "api", name: "API · Private", kind: "keys", managed: true, accounts: [] },
  ] }
  const model = EgressUI.navigationModel(snapshot, { tab: "egress", provider: "api" })
  assert.deepEqual(model.items.map((item) => item.id), ["egress", "sources", "claims", "provider:zcode", "provider:api"])
  assert.equal(model.active, "provider:api")
  assert.equal(model.items[0].count, 1)
  assert.equal(model.items[1].count, 24)
  assert.equal(model.items.at(-1).title, "API · Private")
  assert.equal(JSON.stringify(model).includes("private@example.com"), false)
  snapshot.providers = []
  const empty = EgressUI.navigationModel(snapshot, { tab: "claims", provider: "api" })
  assert.equal(empty.active, "egress")
  assert.deepEqual(empty.items.map((item) => item.id), ["egress", "sources"])
})

const originals = Object.fromEntries([["pluginpages", "pluginpages.js"], ["app", "navigation.js"]].map(([key, file]) => [key, readFileSync(new URL(`fixtures/magpie/${file}`, import.meta.url), "utf8")]))
test("host patch compiles against the pinned host and refuses duplicate or drifting sources", () => {
  const patched = patchMagpieNavigation(originals)
  for (const [name, code] of Object.entries(patched)) assert.doesNotThrow(() => new Script(code.replace(/^export default /m, ""), { filename: name + ".js" }))
  assert.throws(() => patchMagpieNavigation(patched), /already present/)
  assert.throws(() => patchMagpieNavigation({ ...originals, app: originals.app.replace('function navSubs() {', 'function changedNavSubs() {') }), /Unsupported magpie source/)
})
