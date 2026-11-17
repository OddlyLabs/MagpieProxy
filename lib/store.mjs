// 插件本地存储：配置、节点来源（订阅缓存 + 手动号池）、领取记录、当日台账、快照。
// 出口的端口→节点分配（state.json）在 baseDir 下，见 lib/egress.mjs。
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readJson as readJSON, writeJsonAtomic } from "./files.mjs"
import { resolveDataDir } from "./platform.mjs"

export const dataDir = () => resolveDataDir()

// baseDir 是 mihomo 配置 / state / compose 所在。空 = 自动：
//   本机已有 /opt/zcode-egress（旧脚本的一套）→ 直接继承它；
//   否则落在自己的数据目录里，自举一套（compose / 内核 / 配置都由插件生成）。
export const LEGACY_DIR = "/opt/zcode-egress"
export const resolveBaseDir = (cfg) => {
  const want = String(cfg?.baseDir ?? "").trim()
  if (want && !(process.platform !== "linux" && want.replace(/\/$/, "") === LEGACY_DIR)) return want
  if (process.platform === "linux" && existsSync(join(LEGACY_DIR, "docker-compose.yml"))) return LEGACY_DIR
  return join(dataDir(), "egress")
}

const writeAtomic = writeJsonAtomic

export const DEFAULT_CONFIG = {
  backend: "auto",          // auto | docker | binary —— mihomo 跑法
  baseDir: "",              // 空 = 自动：继承 /opt/zcode-egress，否则自举到数据目录
  subUrl: "",               // 旧版单订阅配置兼容；多个订阅统一保存在 nodes.json
  poolText: "",             // 手动号池（原始文本，粘贴的 socks 列表或 clash 片段）
  mirror: "",               // GitHub 下载加速前缀（mihomo 内核、版本号查询）
  portBase: 17901,          // 账号出口端口起点
  spareBase: 17931,         // 备用出口端口起点
  probePortBase: 18200,     // 探测临时端口起点
  sparesCount: 8,
  maxExits: 8,              // 单 Key 多出口：每个账号最多几个出口（2–64）
  checkIntervalMin: 10,
  autoAssignNew: true,      // 白名单内出现未绑定账号/Key（新登录/新 Key）时，体检顺手自动分配
  claimEnabled: true,       // 每晚自动领取（每号继承自己的出口 IP，天然一号一 IP）
  claimHour: 19,            // 北京时间几点后开始
  claimMinute: 0,
  claimIntervalMin: 10,     // 窗口内每轮间隔
  claimWindowHours: 6,      // 窗口时长（小时）
  unitStyle: "zh",
  versionSource: "github",
  cronLock: "",              // 仅 Linux 旧 cron 共存时使用 flock；普通安装使用跨平台进程锁
  managedProviders: null,   // null = 自动接管已有 accountProxies 的供应商；数组 = 显式白名单
  apiPort: 3468,            // sidecar 固定 API 端口（第三方插件对接；ZCODE_EGRESS_PORT 环境变量可覆盖）
}

export const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJSON(join(dataDir(), "config.json"), {}) })
export const saveConfig = (config) => writeAtomic(join(dataDir(), "config.json"), config)

export const loadRecords = () => readJSON(join(dataDir(), "records.json"), [])
export const addRecords = (entries) => {
  const all = [...loadRecords(), ...entries].slice(-800)
  writeAtomic(join(dataDir(), "records.json"), all)
  return all
}
export const clearRecords = () => { writeAtomic(join(dataDir(), "records.json"), []) }

// 当日台账：{ "2026-11-13": { "<email>": { "<批次键>": 时间戳 } } }
export const loadDaily = () => readJSON(join(dataDir(), "daily.json"), {})
export const saveDaily = (v) => writeAtomic(join(dataDir(), "daily.json"), v)

// 快照：页面唯一的数据来源（沙箱页面不能联网）
export const writeSnapshot = (snapshot) => writeAtomic(join(dataDir(), "snapshot.json"), snapshot)
export const loadSnapshot = () => readJSON(join(dataDir(), "snapshot.json"), null)
