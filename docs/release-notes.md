# 栖页 0.3.18 · 一个账号环境对应一个标签

网页功能入口、普通新窗口链接和 Ctrl 点击默认在当前环境的页面导航。顶部标签按已打开的账号环境显示，前进和后退沿用原页面的历史。

需要浏览器原生弹窗语义的登录、授权、支付与 POST 表单通过同环境内的临时页面处理。完成后可由网站关闭，也可点击地址栏旁的「关闭临时页面」。顶栏的关闭按钮仍用于关闭对应环境。

具体站点的特殊授权流程可能需要单独适配。详见 [网页跳转说明](https://github.com/liu341567-sys/zhiwen/blob/main/docs/internal-tabs.md)。

Windows 三种显示缩放下通过 60 项网页跳转与临时页面检查，覆盖普通链接、页面内打开脚本、Ctrl 点击、前进后退、授权消息回传、表单 POST、Cookie 隔离、标签关闭和重启恢复。

站点测试使用本机测试页面和真实 Chromium 内核。具体第三方登录和支付流程仍需按站点验证。

发布标签 `v0.3.18` 对应提交 `ff465c7cae837bbd9548abcd34b6634abfde2e07`。229 项单元检查以及布局、开发者工具、私信、数据中心、发布和 Windows 实际安装回归通过。已完整下载安装包与 ZIP 并核对 SHA256 和包内源码版本。

[主分支检查](https://github.com/liu341567-sys/zhiwen/actions/runs/44224943886) · [发布检查](https://github.com/liu341567-sys/zhiwen/actions/runs/44225117638)

| 文件 | SHA256 |
| --- | --- |
| [Qiye-0.3.18-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.18/Qiye-0.3.18-x64.zip) | `1da4cb80a3eb8f5985626b86574cdf5e53ef00cbb660952e082f12fac2559f9a` |
| [Qiye-Setup-0.3.18-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.18/Qiye-Setup-0.3.18-x64.exe) | `1999a7aac44fb46eab92320366bb57e028fa6ae144c927cc782ab103e5b4e79e` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.3.18/SHA256SUMS.txt) | `e1c409a2a54c5e83d0f4c2b95a35437221252bd8336e3f686285cbcea97d8386` |
