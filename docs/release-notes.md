# 栖页 0.3.17 · 网页新窗口纳入环境内部标签栏

网页主动新开的窗口改为同一独立环境中的内部子标签，显示在原标签栏，可切换、关闭，标题随网页更新。普通当前页跳转保持原样，不覆盖原页面草稿。子标签沿用原Session及登录数据，不创建新环境。

使用Electron原生guest接管接口保留opener、postMessage、window.close、命名复用、表单POST、referrer、noopener/noreferrer和COOP语义；后台标签不抢选中，关闭子页返回opener或环境主页面。原标签栏视觉、导航、启动网址锁定、账号存储及业务模块保留。

关闭环境主标签关闭该环境全部页面；切换账号/模块保留进程内页面，退出后仍恢复原环境主页面，不重放临时授权子页。未知外部协议仍沿用原安全限制，具体第三方登录/支付平台需实页验证。详见[内部标签指南](internal-tabs.md)。

Windows [主分支检查](https://github.com/liu341567-sys/zhiwen/actions/runs/43554101008)与[发布检查](https://github.com/liu341567-sys/zhiwen/actions/runs/43554200519)均通过，对应 `c2d07ed1550a35a22413dd74b44da0e8d7979903` / `v0.3.17`：228项单元、84项内部标签真实窗口检查、72项数据中心、111项私信，以及23项隔离、16项登录兼容性、357项窗口UI、51项侧栏稳定性、45项导航、81项开发者工具、96项发布、57项发布选项检查。100%、125%、150%缩放、NSIS实际安装、图标、正常退出与重启均通过。

标准网页夹具验证了实际Chromium中的window.open、target blank、跨来源postMessage、命名窗口复用、window.close与closed回调、POST、noopener/noreferrer、COOP、Ctrl后台链接、连续请求、原页面草稿/存储、环境隔离和重启。全程无额外BrowserWindow；这是通用机制验证，不是所有真实第三方登录或支付平台认证。非HTTP/HTTPS外部协议仍沿用原安全限制。

发布于2026-11-14 12:15:30（北京时间）。安装包与ZIP均已匿名完整下载，GitHub摘要与SHA256SUMS一致；ZIP全部CRC通过，包内全部src文件匹配版本标签（文本规范化Windows行尾），原始品牌素材及依赖许可证已核对，未打包用户账号、私信/运营数据库、测试夹具或录制资料。

| 文件 | 字节数 | SHA256 |
| --- | --- | --- |
| [Qiye-0.3.17-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.17/Qiye-0.3.17-x64.zip) | 217934182 | `6ca12d4842805a96af00ab0c70bfb1c4af940f68afdb4a4f405051494343f41b` |
| [Qiye-Setup-0.3.17-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.17/Qiye-Setup-0.3.17-x64.exe) | 160788271 | `db8cb080fd997cad300ee0660dabe7d96d0172e95a3705d52228c890be5946d9` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.17/SHA256SUMS.txt) | 180 | `988929d963e7e78022f31af81be3dca39463bd10cf9cda8317aea41e7de96629` |
