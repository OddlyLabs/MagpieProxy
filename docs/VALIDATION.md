# 1.1.0 验证记录

1.2.0 没有重新做下面的整套验证。它在 Windows 11 上通过了 `npm run check`、132 项单元与集成测试和 49 项 Chromium 界面回归，GitHub Actions 上通过了三个系统的检查以及 Chromium、WebKit 界面回归；没有重新在真实的 magpie 宿主里安装验证。

验证日期：2026-11-16 至 17。运行环境为 Windows 11 x64，Node.js 24.18.0；宿主使用未修改的 magpie v0.1.4324，配置、缓存和插件数据全部指向临时目录。

| 检查 | 结果 |
| --- | --- |
| JavaScript 语法 | 73 / 73 个文件通过。 |
| 核心单元与集成测试 | 130 / 130 项通过。 |
| Chromium 界面回归 | 47 / 47 项通过（本机 Chrome），包含首屏无数据时不显示供应商导航的新用例。 |
| 按目录添加 | 从 git 暂存区导出的干净副本，`magpie plugin add <目录>` 成功；magpie 列出页面、设置面板和 7 个工具，没有加载错误；后台在指定端口启动。 |
| 从 GitHub 添加 | 隔离环境中 `magpie plugin add github:OddlyLabs/MagpieProxy` 成功，列为 `magpie-zcode-egress 1.1.0`，页面、设置面板和 7 个工具都在，没有加载错误。 |
| GitHub Actions | 首次推送通过：Windows / macOS / Ubuntu 的检查与测试，Ubuntu 上的 Chromium 和 WebKit 界面回归。 |

本轮没有验证：macOS 和 Linux 桌面实机（只有 CI）、Windows 安装包在本次改动后的重新安装、真实账号的领取与分配。

# 1.0.0 验证记录

验证日期：2026-11-15。实际运行环境为 Linux ARM64，Node.js 26.10.0、Bun 1.4.4、PowerShell 7.7.0；宿主使用未修改的 magpie CLI v0.1.4245，独立便携配置和虚构账号数据。

## 已完成

| 检查 | 结果 |
| --- | --- |
| JavaScript 语法 | 72 / 72 个文件通过。 |
| 核心单元与集成测试 | 110 / 110 项通过，覆盖平台路径、锁、原子写入、下载解压、代理、绑定、任务回执、HTTP 服务和安装诊断。 |
| Chromium 界面回归 | 46 / 46 项通过，覆盖搜索、设置、节点选择、窄屏、明暗主题、键盘和无障碍检查。 |
| WebKit 界面回归 | 全量首次 45 / 46 项通过；一项无障碍检测采样到弹窗淡入过程，单独复测通过。检测改为等待入场动画结束后，亮色及暗色两项均复测通过。 |
| Bun 网络与后台集成 | 15 / 15 项通过。 |
| 官方 magpie 实际入口 | 从原版导航进入官方页面服务，显示“实时同步”；在页面修改并恢复体检间隔，API 收到实际写入，页面实例保留且无脚本错误。 |
| PowerShell 安装 | 语法解析通过；在 Linux PowerShell 下完成真实 CLI 注册、启用、启动、检查及重复安装，使用包含中文和空格的目录；重复安装生成旧文件备份。 |
| Windows 文件格式 | PowerShell 脚本保留 UTF-8 BOM；三个 CMD 启动器使用 ASCII 和 CRLF。 |
| mihomo 发布包 | 实际下载 Windows x64、Windows ARM64 和 Linux ARM64 的 v1.19.34 官方包，SHA-256 验证及内置解压均通过。 |
| mihomo 独立进程 | 在隔离端口实际启动和停止 Linux ARM64 内核，控制接口返回 v1.19.34。 |

安装包和源码包由明确文件清单生成，不打包运行快照、账号配置、订阅、机器安装信息、日志、备份或 node_modules。源码中的证书、凭据和供应商数据仅为测试样例。运行包不含 magpie 主程序、宿主补丁或 mihomo 二进制。

## 尚未实机验证的范围

- 没有 Windows 桌面、Windows PowerShell 5.1 或 WebView2 实机；Linux 上的 PowerShell 执行和 Windows 路径、ZIP 回归不能代替 Windows 实机验证。
- 没有 macOS 桌面实机。已实现原生路径、浏览器发现和内核选择。
- 仓库提供 Windows / macOS / Linux 的 Node.js 22 CI 矩阵及 Chromium / WebKit 检查配置，本次未在 GitHub 上执行。
- 本次未使用真实账号执行领取、订阅更新或出口重新分配；对应逻辑由隔离集成测试覆盖。

## 复现

完整开发源码包中运行：

```sh
npm ci
npm run check
npm test
npx playwright install chromium webkit
npm run test:ui
BROWSER=webkit npm run test:ui
```

Windows PowerShell 可先设置 `$env:BROWSER = 'webkit'`，再执行 `npm run test:ui`。运行包无需安装 npm 依赖；Windows 安装步骤见 [快速开始](../QUICKSTART.md)。
