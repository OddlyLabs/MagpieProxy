# 本机 API

[返回 README](../README.md)

sidecar 默认监听 `http://127.0.0.1:3468`。实际端口见插件数据目录的 `sidecar.pid` 的 `port` 字段；目录规则见[配置说明](configuration.md#数据位置)。

这些接口供同一台机器上的程序使用，包含修改绑定的能力，按本机进程可信的方式运行，不提供独立的远程用户认证。服务校验 Host 和 Origin，并只绑定回环地址。

## 接口

| 方法 | 路径 | 参数 / 请求体 |
| --- | --- | --- |
| GET | `/api/v1/providers` | 返回供应商、账号和绑定概览。 |
| GET | `/api/v1/binding` | 查询参数 `provider`、`account`。 |
| POST | `/api/v1/assign` | `{ "provider": "可选供应商 ID", "id": "可选请求 ID" }`；省略 `provider` 时处理全部受管供应商。 |
| POST | `/api/v1/bind` | `{ "provider": "供应商 ID", "account": "账号标识", "node": "可选节点名", "id": "可选请求 ID" }`；省略 `node` 时自动选择空闲出口。 |
| POST | `/api/v1/unbind` | `{ "provider": "供应商 ID", "account": "账号标识", "id": "可选请求 ID" }`；多出口账号会释放全部出口和入口。 |
| POST | `/api/v1/exits` | `{ "provider": "供应商 ID", "account": "账号标识", "count": 出口数量, "strategy": "可选分流策略", "id": "可选请求 ID" }`；设置该账号的出口数量，见[单 Key 多出口](#单-key-多出口)。 |
| GET | `/api/status` | 服务状态、快照、`running` 和当前 `task`。 |

`provider` 是 magpie 中的供应商 ID。登录账号的 `account` 是邮箱；API Key 的 `account` 是 Key 的 SHA-256 前 10 位，可直接使用 `/api/v1/providers` 返回的账号 `id`。

`/api/v1/*` 是供第三方对接的接口。查询不会返回原始 API Key 或登录密钥，但包含账号标识、别名、节点与出口信息。

## 示例

查询供应商：

```sh
curl --fail-with-body http://127.0.0.1:3468/api/v1/providers
```

查询某个账号的绑定；替换示例供应商和邮箱：

```sh
curl --fail-with-body --get http://127.0.0.1:3468/api/v1/binding \
  --data-urlencode 'provider=zcode' \
  --data-urlencode 'account=example@example.com'
```

为一个供应商分配未绑定账号的出口，操作会实际修改绑定：

```sh
curl --fail-with-body --max-time 3600 \
  -H 'Content-Type: application/json' \
  -d '{"provider":"zcode","id":"assign-example-001"}' \
  http://127.0.0.1:3468/api/v1/assign
```

分配与节点选择包含网络探测，可能需要数分钟。客户端超时后可先查询 `/api/status`，并使用同一个操作和请求 ID 重试，避免重复执行。

## 单 Key 多出口

`/api/v1/exits` 把一个已绑定账号的出口数量设为 `count`。账号需要先有主出口（通过 `assign` 或 `bind`）。

```sh
curl --fail-with-body --max-time 3600 \
  -H 'Content-Type: application/json' \
  -d '{"provider":"atlas","account":"0123456789","count":3,"strategy":"round-robin","id":"exits-example-001"}' \
  http://127.0.0.1:3468/api/v1/exits
```

- `count` 为 1 到上限的整数。上限是设置项 `maxExits`（默认 8，范围 2–64）；上限调低后，已超出的账号可以保持或减少出口，不能再增加。大于 1 时为账号增加或减少出口，并让 magpie 的代理地址指向本机入口端口；等于 1 时撤掉入口，恢复为主出口的单出口绑定。
- `strategy` 可选 `round-robin`（默认，每个新连接轮换）、`consistent-hashing`（同一目标域名固定出口）、`sticky-sessions`（会话保持）。`count` 与当前数量相同而 `strategy` 不同时仅切换策略。
- 新增出口从备用和空闲节点中选取，出口 IP 不与已有出口重复。候选不足时按实际数量生效，响应 `ok` 为 `true`，`kind` 为 `warn`，`message` 给出实际凑到的数量。
- 入口连通之后才会修改 magpie 的代理地址；入口不通或内核配置加载失败时回滚到调用前的状态，响应 `ok` 为 `false`。

成功响应包含 `exits`（每项为 `port`、`node`、`ip`、`primary`）、`front`（入口端口）、`strategy` 和 `proxy`（magpie 实际使用的本机地址）。

查询接口的对应字段：

| 接口 | 字段 |
| --- | --- |
| `/api/v1/providers` 的账号 | `port`、`node`、`ip` 是主出口；`exits` 为出口列表，单出口账号是空数组；`front`、`strategy` 在单出口时为 `null`。 |
| `/api/v1/binding` | `proxy` 为 magpie 实际使用的地址（多出口时是入口）；另有 `exits`、`front`、`strategy`。 |

`bind` 作用于主出口。要单独更换某个附加出口的节点，使用面板中该出口的更换按钮。

## 请求 ID 与任务状态

- 修改请求接受 JSON 对象，请求体最多 1 MB。
- 可选 `id` 长度为 1–160 字符。同一操作使用相同 ID 重试时会复用任务或返回已保存的结果；使用新 ID 表示一次新操作。
- 最近 32 条回执保存在 `snapshot.config.requestResults`；超出保留范围后不保证去重。
- 同一 ID 不应跨操作复用。并发执行冲突的修改任务会返回 409。
- `/api/status` 的 `task` 为空闲时的 `null`，或 `{ "action": "...", "requestId": "...", "startedAt": 0 }` 形式的任务信息；`startedAt` 是实际开始时间的毫秒时间戳。
- 页面心跳不会清除已保存的操作回执。

响应为 JSON，可用 `ok` 判断操作结果，失败时读取 `error` 或 `message`。响应带 `Cache-Control: no-store`。

| 状态码 | 含义 |
| --- | --- |
| 400 | JSON 或参数无效。 |
| 403 | Host / Origin 校验未通过。 |
| 404 | 接口不存在。 |
| 405 | 方法不受支持。 |
| 409 | 任务冲突或请求 ID 跨操作复用。 |
| 413 | 请求体超限。 |
| 500 | 未处理的服务错误。 |

## 节点查看与测试

面板还使用以下接口。它们不属于 `/api/v1` 契约：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/nodes` | 节点来源概览与详情，不含代理认证凭据。 |
| POST | `/api/nodes/probe` | `{ "names": ["节点名"], "id": "可选请求 ID" }`，每次 1–20 个节点。 |

测试使用独立探测实例，共用任务互斥与回执，不修改账号绑定。节点的 `test` 为 `null` 或最近实际结果，包含 `checkedAt`、`source`、`target`、`ip`、`code`、`tlsMs`、`totalMs` 和 `status`。延迟单位为毫秒，缺失值为 `null`。

当前探测目标是 ZCode API。401 表示目标可达，未证明账号的认证状态；节点定义改变后旧测试失效，最新失败也会覆盖旧的成功记录。
