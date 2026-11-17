# 接手说明

最后更新：2026-11-17。约定和命令见 [CLAUDE.md](CLAUDE.md)，这里只记录进展。

## 现在的状态

- 版本 1.1.0，项目名 MagpieProxy，源码在 <https://github.com/OddlyLabs/MagpieProxy>，默认分支 `main`，标签 `v1.1.0`。
- 仓库没有设置任何 topic。**不要加 `magpie-plugin`**（原因见 CLAUDE.md）。
- 安装方式三种：`magpie plugin add github:OddlyLabs/MagpieProxy`（README 的 Add to magpie）、Windows 安装包（`Install.cmd`）、macOS / Linux 目录安装（`install.sh`）。
- magpie 官方的 Add to magpie 导入链接只能添加模型供应商，不能安装插件。所以 README 里的官方徽章指向 `#add-to-magpie` 一节，由一条命令完成添加。官方以后支持插件链接时，把徽章换成真正的链接。

## 最近完成的工作

1. 单 Key 多出口（1.1.0 主功能）及可靠性改进，见 [CHANGELOG.md](CHANGELOG.md)。
   1.1.0 之后（CHANGELOG 的「未发布」）：出口上限可设置（`maxExits`，默认 8，最高 64）、账号行上的「多出口」入口、一批性能和健壮性改进、工作台界面改版（单行标题栏、出口健康条，README 截图已更新）。**还没有改版本号、打标签和发 Release。**
2. 改名 MagpieProxy：README、QUICKSTART、发布文件名、`package.json` 的仓库地址和展示名。包名、数据目录、环境变量没有改。
3. `doctor` 能识别从 git 或 npm 添加的副本（`lib/platform.mjs` 的 `findRegistration`）。
4. 发布包里脚本的可执行位按文件内容（`#!` 开头）确定；git 里三个脚本的模式是 100755。
5. 修复首次进入的白色遮挡：没有数据时供应商导航和开关保持隐藏（`page/index.html`、`page/app.js` 的 `render`）。

## 验证范围

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 73 / 73，Windows 11，Node.js 24.18.0。 |
| `npm test` | 132 / 132。 |
| `npm run test:ui`（Chromium） | 49 / 49，使用本机 Chrome。 |
| 按目录添加，magpie v0.1.4324，隔离环境 | 通过：页面、设置面板、7 个工具都列出，没有加载错误。 |
| 从 GitHub 添加，隔离环境 | 通过，见 [docs/VALIDATION.md](docs/VALIDATION.md)。 |
| GitHub Actions「Plugin checks」 | 首次推送通过：Windows / macOS / Ubuntu 的 Node.js 22 检查与测试，Ubuntu 上的 Chromium 和 WebKit 界面回归。 |

没有验证的：macOS / Linux 桌面实机（只有 CI）、改动后的 Windows 安装包重新安装、真实账号的领取和分配。

## 已知问题和待办

- **审查中确认但还没改的性能点。** 面板打开时每 5 秒重建一次约 1 MB 的快照（节点列表每次重新计算、整份发给页面）；可以给快照加版本号，未变化时不下发，并把 `nodes` 挪到已有的 `/api/nodes`。出口数量很大（上千个端口）时一轮体检仍然偏慢。
- **内核无响应时可能被重复拉起**（`lib/mihomo.mjs` 的启动判断只看 `/version` 是否在 1.5–2.5 秒内应答），旧进程会成为孤儿。启动前应先看 pid 文件里的进程是否还活着。

- **两种安装方式会并存。** `install.ps1` 只检查按目录注册的旧副本，不知道从 git 添加的副本；两种都装会出现两个「出口管家」。README 让用户只选一种。可以让安装器也检查 `plugins/package.json` 里的依赖。
- **3468 端口被别的程序占用时，从 git 添加的插件加载失败**，要在插件选项里设置 `port`。`index.mjs` 的 `exposeService` 可以改成自动顺延。
- **插件停用或移除后，后台和出口进程继续运行**，账号上的代理地址也保留。没有卸载钩子。README 提示用户先解绑。
- `server.mjs` 仍然把快照写进插件目录的 `page/data.js`，供旧沙箱面板使用。从 git 添加时这个目录在 magpie 的 `plugins/node_modules` 下，更新时会被覆盖，不影响主工作台。
- 没有发布到 npm。发布后可以用 `magpie plugin add magpie-zcode-egress`。

## 没有决定的事

- 是否把 magpie 里显示的「出口管家」也改成 MagpieProxy。目前两个名字并用，README 的「名称说明」有解释。
- 是否申请进入 magpie 的插件推荐列表。项目所有者目前不要 `magpie-plugin` topic，先不做。

## 隔离环境

用本机的 magpie 程序测试安装时，这样运行，真实的 magpie 配置、登录和插件数据都不会被碰到：

```sh
sb=$(mktemp -d)
m() { env HOME="$sb/home" USERPROFILE="$sb/home" \
  XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  APPDATA="$sb/appdata" LOCALAPPDATA="$sb/localappdata" \
  ZCODE_EGRESS_DATA="$sb/egress-data" ZCODE_EGRESS_PORT=3491 \
  MAGPIE_ADDR=127.0.0.1:3499 "$@"; }
mkdir -p "$sb/egress-data/magpie-zcode-egress"
echo '{"claimEnabled":false,"autoAssignNew":false,"apiPort":3491}' > "$sb/egress-data/magpie-zcode-egress/config.json"
m magpie data                 # 先确认两个目录都在 $sb 下
m magpie plugin add github:OddlyLabs/MagpieProxy </dev/null
m magpie plugin --json        # 看加载错误
```

Windows 的 Git Bash 里把 `$sb` 换成 `cygpath -m "$sb"` 的结果。真实后台在 3468 端口时，还要把插件选项的 `port` 设成别的端口：`m magpie plugin options magpie-zcode-egress '{"port":3491}'`。测试完用同一组环境变量运行 `node manage.mjs stop`，再删除 `$sb`。

## 发布步骤

1. 改 `package.json` 的版本号，写 CHANGELOG，更新 README 和 QUICKSTART 里的文件名。
2. `npm run check`、`npm test`、`npm run test:ui`。
3. 提交并推送 `main`，打标签 `v<版本>`。
4. `npm run release -- <输出目录>`，把两个 ZIP、`.tgz` 和 `SHA256SUMS.txt` 上传到 GitHub Release，说明用生成的 `RELEASE.md`。
