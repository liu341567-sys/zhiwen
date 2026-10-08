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

编辑已有环境并选择另一平台，会更新 `platformId` 与 `startUrl`，保留 `lastUrl`、环境 UUID、分区和登录数据。现有页面不会因此跳转，重新打开仍恢复上次页面。例如，将抖音环境改为知乎预设后，上次打开的抖音页面仍会恢复；需要访问新入口时，可手动在地址栏打开该链接。选择平台与重置登录是不同操作。

实际切换为「自定义网址」并保存时，会清除平台关联，按输入保存启动网址，继续保留上次页面与会话数据。在本次对话框编辑期间保留手输网址草稿，来回切换平台预设与自定义模式时可以恢复草稿；再次打开对话框时按已保存的启动网址初始化。自定义与旧环境使用默认图标；未识别的关联在界面按默认图标处理，不从域名猜测平台。

## 图标与验证边界

平台选择项、侧栏与账号卡片从本地静态资源读取图标；标签页保持原有颜色标记。侧栏和卡片仅在图片成功加载后替换默认首字母图标，失败时保留默认图标；选择项失败时仍显示平台名称与文字备用标记。

九份资源来自固定 GitHub 提交中的公开品牌镜像，来源、平台关联证据、实际格式、原始字节数与 SHA256 均记录在[图标来源清单](../branding/platform-assets.json)。抖音、小红书、视频号、快手使用原始 SVG；公众号为原始 WEBP；头条号、百家号为原始 PNG；搜狐号和知乎使用从镜像 ZIP 解出的原始站点 ICO，知乎为蓝底白字 favicon。公众号镜像文件虽名为 PNG，实际为 WEBP，本地按实际类型命名，字节保持原样。图形与颜色没有重新绘制或转换，显示缩放由 CSS 完成，运行时使用本地资源。

来源核验范围为镜像内容与平台关联证据，当前官网原始图片字节尚未直接比对。入口链接、图标加载和本地环境检查不能证明真实平台登录成功；网络返回 401 / 403 也不能作为登录兼容性已修复的证据。本次提供入口与环境标识，真实登录仍待 Windows 实机复测。
