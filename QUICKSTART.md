# MagpieProxy（出口管家）1.2.1

此版本使用 magpie 官方插件接口，不需要修改或替换 magpie 程序。只复制目录不会把插件注册到 magpie；下面的安装方式选一种即可，运行数据通用。

## 最快：Add to magpie

```sh
magpie plugin add github:OddlyLabs/MagpieProxy
```

或者在 magpie 的 **插件** 页点 **添加插件**，填入 `github:OddlyLabs/MagpieProxy`，点 **安装**。完成后从导航栏的 **插件 → 出口管家** 进入；看不到入口时刷新窗口。以后在插件页点更新，或运行 `magpie plugin update`。

## Windows 安装包

1. 从 [Releases](https://github.com/OddlyLabs/MagpieProxy/releases/latest) 下载 `MagpieProxy-1.2.1.zip` 并完整解压，不要直接在压缩包里运行脚本。
2. 双击 **Install.cmd**。自动查找 magpie；找不到时，选择你平时运行的 magpie EXE。
3. 安装成功后自动打开浏览器工作台。magpie 已打开时，刷新窗口。

入口任选其一：

- magpie 导航栏的 **插件 → 出口管家**；插件分组可能在导航栏底部，需要向下滚动。
- **设置 → 插件**中的出口管家面板，点击“在设置中打开工作台”。
- 双击 **Open.cmd**，直接在本机浏览器中使用。
- 供应商菜单中的 **打开出口管家**。

安装器将运行文件复制到当前 magpie 数据目录下的 `local-plugins/magpie-zcode-egress`，并完成注册、启用、启动和检查。安装成功后可移走最初解压的目录；固定安装目录中的 `Open.cmd` 可创建快捷方式。无需管理员权限，无需另装 Node.js；优先复用 magpie 自带的 Bun。首次安装需要联网供 magpie 下载 Bun，首次分配出口会下载已固定版本并校验 SHA-256 的 mihomo。

无法连接时运行 **Diagnose.cmd**。它会说明是否注册、是否启用、后台是否启动，以及真实数据目录，并保存 `diagnostics.txt`，不输出账号密钥和订阅。

指定便携版程序或安装目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -MagpiePath 'D:\软件\magpie\magpie.exe'
```

## macOS / Linux 目录安装

将目录放到长期保留的位置后运行：

```sh
./install.sh
# 后续直接打开
./open.sh
```

也可使用 magpie 的插件管理界面添加包含 `package.json` 的目录，或执行 `magpie plugin add /absolute/path/to/MagpieProxy`。

## 开始使用

打开设置选择供应商 → 导入节点订阅或 SOCKS5 地址 → 分配出口。Windows / macOS 使用独立内核，不需要 Docker、curl、gzip 或 flock。自动领取需要 Chrome / Edge；关闭自动领取不影响出口管理。

需要让一个账号或 API Key 同时使用多个出口时，点账号行上的「多出口」按钮，在「出口数量」中填写数量并应用。默认最多 8 个，可在「设置 → 体检与备用」中把上限调到 64。magpie 中仍然只有这一条账号记录，说明见 [README](README.md#单-key-多出口)。

## 升级

用 Add to magpie 添加的，在 magpie 插件页点更新。Windows 安装包解压新版并再次运行 `Install.cmd`：正在执行任务时会提示等待；正常升级保留账号绑定、订阅和设置，备份旧运行文件，并停用同一插件的旧目录副本。完整说明见 [README](README.md)。
