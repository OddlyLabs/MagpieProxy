# 配置与数据

[返回 README](../README.md)

日常配置通过「出口管家 → 设置」保存。持久化配置位于插件数据目录的 `config.json`，默认值以 [`lib/store.mjs`](../lib/store.mjs) 的 `DEFAULT_CONFIG` 为准；参数范围在 [`lib/config.mjs`](../lib/config.mjs) 校验。

## 配置项

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `managedProviders` | `null` | 自动选择已有 `accountProxies` 的供应商；字符串数组表示明确的白名单，空数组表示不管理任何供应商。 |
| `backend` | `auto` | `auto`、`docker` 或 `binary`。Windows / macOS 自动选择独立内核；Linux 的自动模式检测 Docker。Docker 只支持 Linux host 网络。 |
| `baseDir` | 空字符串 | mihomo 配置和分配状态目录。为空时，在 Linux 上先检查旧部署的 `/opt/zcode-egress/docker-compose.yml`，否则使用插件数据目录下的 `egress/`。 |
| `portBase` | `17901` | 账号 SOCKS5 端口起点，范围 1–65535。分配会避开备用端口段和已有占用；多出口账号的附加出口和入口端口也从这里分配。 |
| `spareBase` | `17931` | 备用端口起点；完整备用段必须在 1–65535 内。 |
| `probePortBase` | `18200` | 独立探测实例的端口起点，范围 1–65280。 |
| `sparesCount` | `8` | 备用出口数量，范围 2–40。 |
| `checkIntervalMin` | `10` | 体检间隔，范围 2–180 分钟。 |
| `autoAssignNew` | `true` | 体检时为白名单内新发现的未绑定账号分配出口。 |
| `claimEnabled` | `true` | 是否启用 ZCode 自动领取。 |
| `claimHour` | `19` | 领取窗口的北京时间开始小时，0–23。 |
| `claimMinute` | `0` | 开始分钟，0–59。 |
| `claimIntervalMin` | `10` | 窗口内尝试间隔，2–180 分钟。 |
| `claimWindowHours` | `6` | 领取窗口长度，1–24 小时，可跨午夜。 |
| `versionSource` | `github` | ZCode 客户端版本查询来源：`local`、`github` 或 `mirror`。 |
| `mirror` | 空字符串 | 可选的 GitHub 下载镜像前缀，需为完整 HTTP(S) 地址。 |
| `unitStyle` | `zh` | 单位展示偏好，可选 `zh` 或 `en`。 |
| `cronLock` | 空字符串 | 仅 Linux `/opt/zcode-egress` 旧部署使用；空值沿用 `/tmp/zcode-egress.lock`。普通任务使用插件数据目录中的跨平台进程锁。 |
| `apiPort` | `3468` | sidecar 首选监听端口，1–65535，重启 sidecar 后生效。冲突时有限顺延，以 `sidecar.pid` 为准。 |
| `subUrl` | 空字符串 | 旧版单订阅兼容字段；新订阅从面板导入，统一保存到 `nodes.json`。 |
| `poolText` | 空字符串 | 手动节点来源文本，可能包含代理凭据。 |

magpie 的插件选项中还提供 `port` 等接入元数据。实际业务配置由 sidecar 的 `config.json` 管理；主工作台显示偏好保存在 `ui-preferences.json`；旧沙箱设置面板的 `pagePreferences` 通过宿主选项读写。

## 数据位置

`ZCODE_EGRESS_DATA` 优先，仍在其下追加 `magpie-zcode-egress/`。没有显式覆盖时：

- 便携版或其它非默认 magpie 配置目录：该目录下的 `zcode-egress/`，与便携数据一起移动。
- 明确指定的 `XDG_DATA_HOME`：其下的 `magpie-zcode-egress/`。
- 已存在旧版 `~/.local/share/magpie-zcode-egress` 配置或绑定：继续使用，避免升级丢失记录。
- Windows 新安装：`%LOCALAPPDATA%/magpie-zcode-egress`。
- macOS 新安装：`~/Library/Application Support/magpie-zcode-egress`。
- Linux 新安装：`~/.local/share/magpie-zcode-egress`。

magpie 自身在三个系统的普通目录都是 `~/.config/magpie`（或 `XDG_CONFIG_HOME/magpie`）；插件优先使用宿主传入的实际目录，安装器通过 `magpie data` 确定便携、迁移或自定义位置。不要把 Windows 的 magpie 配置误认为 AppData 目录。

| 文件 / 目录 | 用途 |
| --- | --- |
| `config.json` | 插件设置和任务回执。 |
| `bindings.json` | 供应商与账号到本机端口的显式绑定。多出口账号另外记录附加出口端口（`extra`）、入口端口（`front`）和分流策略（`strategy`）。 |
| `nodes.json` | 订阅、节点缓存和手动来源，可能含订阅令牌和代理凭据。 |
| `node-tests.json` | 节点实际测试结果；按节点定义指纹匹配，最多保留 5000 个现存节点的结果。 |
| `records.json`、`daily.json` | 领取记录与北京时间当日台账。 |
| `snapshot.json` | 面板状态快照。 |
| `sidecar.pid`、`sidecar.log`、`startup.log` | 服务身份、实际端口、运行与启动日志。 |
| `sidecar.lock/`、`egress.lock/` | 后台单实例和任务互斥；记录所有者 PID，崩溃后可回收。 |
| `ui-preferences.json` | 浏览器工作台显示偏好。 |
| `egress/` | 默认的 mihomo 配置、内核和状态目录。 |

`baseDir/state.json` 保存端口到节点的分配状态。单 Key 多出口不增加配置项：出口数量和策略按账号保存在 `bindings.json`，在账号详情、`egress-cli.mjs exits` 或 [`/api/v1/exits`](api.md#单-key-多出口) 中设置。插件目录中的 `page/data.js` 为旧沙箱设置面板提供快照，已在发布包和 `.gitignore` 中排除；写入失败不影响主工作台的 HTTP 数据。`installation.json` 是 Windows 安装器的本机信息，也不会进入发布包。

备份应覆盖插件数据目录、实际使用的 `baseDir` 和 magpie 供应商配置；这些属于运行数据，不应上传到公开仓库。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `ZCODE_EGRESS_DATA` | 覆盖插件数据根目录；仍会追加 `magpie-zcode-egress/`。 |
| `ZCODE_EGRESS_MAGPIE_DIR` | 覆盖读取、写入 magpie 配置的目录。 |
| `ZCODE_EGRESS_PAGE_DIR` | 覆盖生成 `data.js` 的目录。 |
| `ZCODE_EGRESS_PORT` | 覆盖 sidecar 首选 API 端口。 |
| `ZCODE_CHROME_PATH` | 指定自动领取使用的 Chrome / Edge 可执行文件。 |
| `ZCODE_EGRESS_APP_VERSION` | 本地未检测到 ZCode 版本时的回退版本。 |
| `PREVIEW_PORT` | 虚构数据预览端口，默认 4177。 |
| `BROWSER` | 浏览器测试设置为 `webkit` 时使用 WebKit；默认 Chromium。 |
| `BROWSER_EXECUTABLE` | 指定 Chromium 测试使用的浏览器可执行文件。 |
| `TEST_RUNTIME` | 为隔离 sidecar 集成测试指定运行时，例如 Bun 的绝对路径。 |

## 开发隔离

`npm run dev` 使用虚构数据。`npm test` 的集成测试也会创建自己的临时目录。

手动启动 `server.mjs` 时，应同时将 `ZCODE_EGRESS_DATA`、`ZCODE_EGRESS_MAGPIE_DIR`、`ZCODE_EGRESS_PAGE_DIR` 指向测试目录，并选择独立的 `ZCODE_EGRESS_PORT`。测试配置中的 `baseDir` 和 `cronLock` 也应指向测试路径，避免空的 `baseDir` 自动继承已有部署。

## 从旧部署迁移

首次加载绑定时，会把已有 `accountProxies` 迁入显式绑定表。多个账号引用同一端口时，登录型账号优先，冲突的 Key 标记为待分配；缺失的端口在后续分配中处理。

如曾使用 `/opt/zcode-egress` 的旧脚本，在启用统一管理之前停用旧 crontab 中的 `check` 任务。旧检查脚本可能按账号位置重新配对端口，与当前显式绑定规则冲突。仅这类 Linux 旧部署沿用原 `flock` 路径；其它安装不需要 flock。

旧版单订阅和手动节点来源会兼容迁移。对某个订阅的更新失败会保留它上次成功获取的节点，其它订阅仍可独立更新。
