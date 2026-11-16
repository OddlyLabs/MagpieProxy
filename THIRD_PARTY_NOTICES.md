# 第三方许可说明

本项目自身代码采用根目录的 [MIT License](LICENSE)。下列第三方内容保留原作者的版权声明和许可证。

| 内容 | 来源 / 版本 | 许可证 | 本地位置 |
| --- | --- | --- | --- |
| YAML 解析器 | [eemeli/yaml](https://github.com/eemeli/yaml)，2.9.0 | ISC | [vendor/yaml/LICENSE](vendor/yaml/LICENSE) |
| 图标与 Waypoints 标志 | [Lucide](https://lucide.dev/)，lucide-static 1.72.0 | ISC；其中派生自 Feather 的图标同时保留 MIT 声明 | [vendor/lucide/LICENSE](vendor/lucide/LICENSE) |
| ZIP 解压器 | [fflate](https://github.com/101arrowz/fflate)，0.8.3 | MIT | [vendor/fflate/LICENSE](vendor/fflate/LICENSE) |
| 宿主导航、菜单与页面桥接测试片段 | [yetone/magpie v0.1.4174](https://github.com/yetone/magpie/tree/v0.1.4174) | MIT | [上游 MIT 许可证](https://github.com/yetone/magpie/blob/v0.1.4174/LICENSE) |

Lucide 的 SVG 源文件、版本清单和生成方式保存在 `vendor/lucide/`。
magpie 测试片段的出处和提取范围记在源码包的 `test/fixtures/magpie/README.md` 中；历史宿主导航补丁仅保留在源码中，不参与 1.0 安装。

magpie、mihomo 和浏览器的可执行文件由用户环境提供或在运行时单独获取，不包含在插件安装包或源码包中。
