# 出口管家原生侧栏接入

这份补丁让 magpie 原生导航的「出口管家」展开为工作台与供应商子菜单。
左侧导航点击父入口可展开／收起；顶部导航点击同一入口打开宿主下拉菜单。
子菜单直接切换页面或供应商，页面内切换也会同步选中状态。
支持方向键、Home / End 和 Enter，保留菜单焦点；卸载或停用插件会清除对应子菜单。

**插件 0.6.1 可独立使用多列视图与窄屏供应商菜单。原生下拉菜单需要宿主应用本补丁。**
单独安装插件、刷新插件面板或重启未修改的 magpie 都不会增加宿主菜单。
此生成器只输出文件，不修改已安装的 magpie，也不重启正在运行的服务。

已验证的宿主基线：[magpie v0.1.4174](https://github.com/yetone/magpie/tree/v0.1.4174)。
生成器在修改位置缺失、重复或补丁已存在时停止，不猜测其它版本的源码结构。

## 生成或查看补丁

在出口管家项目目录运行（发布包也包含此脚本）：

```sh
node scripts/build-magpie-sidebar.mjs /path/to/magpie-source /path/to/sidebar-output
```

输出文件：

- `sidebar.patch`：修改 `internal/gui/assets/pluginpages.js`，新增 `egress-navigation.js`。
- `pluginpages.js`、`egress-navigation.js`：应用补丁后的完整资源，可供源码构建与审查。
  原版 `app.js` 保持不变，桥接分发与扩展在插件页面首次发消息时加载。
- `manifest.json`：输入、输出及补丁的 SHA-256，附已验证基线。
- `LICENSE`：导航扩展的 MIT 许可；`LICENSE.magpie`、`LICENSE.lucide` 保留宿主代码与图标的原始许可。

## 接入源码构建

先在独立的 magpie 源码副本中检验并应用补丁：

```sh
cd /path/to/magpie-source
git apply --check /path/to/sidebar-output/sidebar.patch
git apply /path/to/sidebar-output/sidebar.patch

# 仅使用浏览器界面的服务器版本，包含 Web UI：
make cli

# 使用桌面窗口的版本（需要宿主文档列出的 GTK / WebKit 等构建依赖）：
# make build-release
```

按 magpie 自身的安装方式安装生成的二进制并重启宿主，再刷新浏览器或重新打开窗口。
正式版本的静态资源打包在二进制中，不能仅将输出 JS 复制进插件目录。
运行中的会话会使用宿主服务，应在合适的时间重启。

回退源码改动可运行 `git apply -R /path/to/sidebar-output/sidebar.patch` 后重新构建，
或恢复安装前保留的原版 magpie。宿主更新会替换自定义构建，需要重新检查补丁兼容性。

## 验证

开发仓库运行 `npm run dev`，打开：

- `/host-preview.html?scenario=providers`：应用补丁的原版侧栏与真实沙箱桥接，18 个示例供应商。
- `/host-preview.html?scenario=providers&nav=top`：同一宿主的顶部下拉菜单。
- `/host-stock.html?scenario=providers`：未修改宿主的兼容检查。

以上只使用虚构数据。运行 `npm run test:ui` 可验证两种导航布局、展开收起、页面联动、
供应商直达、插件停用清理、非法消息拒绝、沙箱偏好保存及多列视图；
`BROWSER=webkit npm run test:ui -- test/browser/navigation.spec.mjs --workers=1` 串行验证 WebKit 导航。

桥接只接受宿主已登记的页面 iframe，通过 `navigation.set` 注册本页的子项。
面板与其它窗口不能注册；项目数量、名称、ID、计数与选中项都会校验。
图标来自固定的 Lucide SVG 集合，标题按文本渲染，不接受插件传入 HTML。
原生菜单接通后，插件内的重复侧边导航会自动隐藏，顶部供应商选择器继续保留。
