import { HttpError } from "./http.mjs"

// All operations touching egress share one gate, including API calls and timers.
export class TaskRunner {
  active = null
  constructor(onChange = () => {}) { this.onChange = onChange }
  async run(action, fn, requestId = null) {
    if (this.active) throw new HttpError(409, "已有任务在执行，请稍后再试")
    this.active = { action, requestId, startedAt: Date.now() }
    try {
      this.onChange()
      return await fn()
    } finally {
      this.active = null
      this.onChange()
    }
  }
}

export const rememberReceipt = (config, id, result) => ({
  ...config,
  lastRequest: id,
  lastRequestResult: result ? { id, ...result } : null,
  requestResults: result
    ? [...(Array.isArray(config.requestResults) ? config.requestResults : []).filter((r) => r.id !== id), { id, at: Date.now(), ...result }].slice(-32)
    : config.requestResults ?? [],
})
