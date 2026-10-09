# 平台预设与环境关联

入口数据唯一来源是用户提供的[创作者中心入口原附件](references/creator-centers.docx)，归档副本保留原始字节，SHA256 为 `66fd6887a6fb0e180e8202b8e4dbed8d943bd5cb226fe80b086232732f0de008`。运行时唯一配置是 [src/platform-presets.json](../src/platform-presets.json)，主进程、环境清单和界面共同使用它。图标来源不改变附件中的入口网址。

## 配置字段与九个入口

`id` 是稳定的平台关联键，`displayName` 是界面名称，`launchUrl` 是新环境首次打开的原文入口，`iconResource` 是相对 renderer 的本地图片路径。链接的路径、大小写、查询参数及编码按配置保留。

| id | displayName | launchUrl | iconResource |
| --- | --- | --- | --- |
| `douyin` | 抖音 | [https://creator.douyin.com/](https://creator.douyin.com/) | `../assets/platforms/douyin.svg` |
| `xiaohongshu` | 小红书 | [https://creator.xiaohongshu.com/login](https://creator.xiaohongshu.com/login) | `../assets/platforms/xiaohongshu.svg` |
| `weixin-channels` | 视频号 | [https://channels.weixin.qq.com/login.html](https://channels.weixin.qq.com/login.html) | `../assets/platforms/weixin-channels.svg` |
| `kuaishou` | 快手 | [https://cp.kuaishou.com/profile](https://cp.kuaishou.com/profile) | `../assets/platforms/kuaishou.svg` |
| `weixin-official` | 公众号 | [https://mp.weixin.qq.com/](https://mp.weixin.qq.com/) | `../assets/platforms/weixin-official.webp` |
| `toutiao` | 头条号 | [https://mp.toutiao.com/profile_v4/index](https://mp.toutiao.com/profile_v4/index) | `../assets/platforms/toutiao.png` |
| `baijiahao` | 百家号 | [https://baijiahao.baidu.com/builder/theme/bjh/login](https://baijiahao.baidu.com/builder/theme/bjh/login) | `../assets/platforms/baijiahao.png` |
| `sohu` | 搜狐号 | [https://mp.sohu.com/mpfe/v4/login](https://mp.sohu.com/mpfe/v4/login) | `../assets/platforms/sohu.ico` |
| `zhihu` | 知乎 | [https://www.zhihu.com/signin?next=%2F](https://www.zhihu.com/signin?next=%2F) | `../assets/platforms/zhihu.ico` |

## 环境生命周期

环境可以保存可选的 `profile.platformId`。选择平台新建时，保存其 `id`，并将 `startUrl` 和初始 `lastUrl` 设置为配置中的原文 `launchUrl`。同一平台可创建多个环境；每次新建仍生成独立 UUID 和会话分区，不按平台共用 Cookie 或网站存储。

平台关联与环境名称分开保存。只改名或备注时，不重写原 `startUrl` 和 `platformId`，包括未识别的已有平台值；关闭重开及程序重启保留关联。侧栏和账号卡片按已识别关联显示平台图标。当前网页跳转或访问其他域名不会推断、替换平台关联。旧环境没有 `platformId` 时沿用默认环境图标，加载时不会根据网址自动补齐或迁移。

从 0.1.7 起，新建环境创建成功后锁定当次保存的 `startUrl` 与 `platformId`；升级前已有环境则锁定升级时已保存的原值，包括自定义环境及未识别的旧平台字段。编辑对话框只读展示启动网址和平台类型，不允许换平台、清除关联或改自定义网址；名称、备注与颜色仍可修改。旧环境没有 `platformId` 时继续保留字段缺省，不按网址新增关联；未识别的旧值也保持原样，界面使用默认图标。升级只增加校验，不迁移或重写旧数据。

配置更新层同样限制启动字段：允许提交与已保存值严格相同的字段，任何实际变更则拒绝整个更新，不会先保存名称等其他改动。相同值也不经过规范化重写，不将缺省关联补为平台值。这一限制适用于界面和其他配置更新路径；首次新建环境仍按原有规则选择预设或验证自定义网址。

锁定的是启动配置，不是网页访问范围。地址栏导航、网页跳转和 `lastUrl` 更新继续正常工作，当前环境仍可访问其他网站；重新打开优先恢复上次页面，不会因改名或排序强制回到启动入口。环境 UUID、会话分区、Cookie 和网站存储保持原样。

新建对话框在本次填写期间保留手输网址草稿，来回切换平台预设与自定义模式时可以恢复；只有创建成功才保存选定配置。点击弹窗背景或按 Escape 不关闭新建窗口，未保存内容保持；右上角「×」主动关闭，创建成功按原流程关闭。编辑对话框继续保留原有取消与 Escape 关闭方式。

0.1.6 曾允许编辑时切换平台或自定义网址，其验证记录保留为版本历史；该行为不适用于 0.1.7。

## 图标与验证边界

平台选择项、侧栏与账号卡片从本地静态资源读取图标；标签页保持原有颜色标记。侧栏和卡片仅在图片成功加载后替换默认首字母图标，失败时保留默认图标；选择项失败时仍显示平台名称与文字备用标记。

九份资源来自固定 GitHub 提交中的公开品牌镜像，来源、平台关联证据、实际格式、原始字节数与 SHA256 均记录在[图标来源清单](../branding/platform-assets.json)。抖音、小红书、视频号、快手使用原始 SVG；公众号为原始 WEBP；头条号、百家号为原始 PNG；搜狐号和知乎使用从镜像 ZIP 解出的原始站点 ICO，知乎为蓝底白字 favicon。公众号镜像文件虽名为 PNG，实际为 WEBP，本地按实际类型命名，字节保持原样。图形与颜色没有重新绘制或转换，显示缩放由 CSS 完成，运行时使用本地资源。

来源核验范围为镜像内容与平台关联证据，当前官网原始图片字节尚未直接比对。0.1.6 已通过本地 UI 及 Windows 实际安装检查，九份本地图标与环境关联在重启后恢复的检查通过，详见 [验证记录](validation.md)。入口与本地检查不证明真实账号登录成功，网络 401 / 403 也不表示登录问题已修复；真实登录仍待 Windows 实机复测。
