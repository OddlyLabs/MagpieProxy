# MagpieProxy（出口管家）

magpie 插件：给每个供应商账号和 API Key 分配独立的代理出口。仓库 <https://github.com/OddlyLabs/MagpieProxy>，默认分支 `main`。

开始工作前先读 [HANDOFF.md](HANDOFF.md)：当前进展、验证范围、已知问题和待办都在那里。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 语法检查。 |
| `npm test` | 单元与集成测试。使用各自的临时目录，不需要先安装依赖。 |
| `npm ci && npm run test:ui` | 浏览器回归（Playwright）。`BROWSER=webkit` 换用 WebKit；`BROWSER_EXECUTABLE` 指定本机的 Chromium。 |
| `npm run dev` | 虚构数据预览，<http://127.0.0.1:4177>。 |
| `npm run release -- <输出目录>` | 生成安装 ZIP、源码 ZIP、npm 包和校验清单。必须通过 npm 运行。 |

## 不能改的约定

- **包名 `magpie-zcode-egress` 不改。** 安装器、插件目录、数据目录、`ZCODE_EGRESS_*` 环境变量和后台身份识别都靠它，改了已有安装就无法升级。项目名是 MagpieProxy，magpie 里显示的名字是「出口管家 / Egress Manager」。
- **仓库不加 `magpie-plugin` 这个 GitHub topic**，`package.json` 的 `keywords` 里也不加。带这个 topic 的仓库会被 magpie 的插件发现页自动收录，项目所有者明确要求不带。
- **`main` 上的每次提交都要能直接使用。** 用 `magpie plugin add github:OddlyLabs/MagpieProxy` 添加的用户跟随 `main` 更新。提交前运行 `npm run check` 和 `npm test`；改了 `page/` 再运行 `npm run test:ui`。
- **文件按字节保存**（`.gitattributes` 是 `* -text`）。`Install.cmd`、`Open.cmd`、`Diagnose.cmd` 用 CRLF，`install.ps1` 带 UTF-8 BOM，其余文件用 LF。
- **`install.sh`、`open.sh`、`manage.mjs` 在 git 里是可执行文件**（模式 100755）。在 Windows 上新增脚本时用 `git update-index --chmod=+x <文件>`。
- **不提交运行数据。** `page/data.js` 是真实运行快照，里面有账号信息；`installation.json`、`diagnostics.txt`、日志、账号配置、订阅和运行备份同样不能提交。它们都在 `.gitignore` 里，提交前用 `git status --short` 再看一遍。

## 不要碰真实环境

手动启动 `server.mjs`，或者用本机的 magpie 程序做安装测试之前，先把数据目录、magpie 配置目录和端口指到临时位置。做法见 [HANDOFF.md 的「隔离环境」](HANDOFF.md#隔离环境) 和 [docs/configuration.md 的「开发隔离」](docs/configuration.md#开发隔离)。

## 代码入口

- `index.mjs`：向 magpie 注册页面、设置面板、供应商菜单和工具。
- `lib/service.mjs`：启动后台并核对它的身份。
- `server.mjs`：后台，负责任务调度和本机 API。
- `manage.mjs`：安装、诊断、打开工作台的命令行。
- `page/`：工作台界面。`page/entry.html` 接入 magpie 的插件页，`page/index.html` 是界面本身。
- `scripts/release.mjs`：生成发布文件。

后台按代码指纹识别新旧实例。指纹由版本号加上 `server.mjs`、`index.mjs`、`egress-cli.mjs` 和 `lib/*.mjs` 的内容算出，改动这些文件后，运行中的旧后台会在空闲时被新版接管。`page/` 不参与指纹，改界面刷新即可生效。
