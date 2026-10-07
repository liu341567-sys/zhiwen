# 当前验证记录

## 0.1.1 修复的本地证据

2026-10-07，用户报告同一 Windows 电脑、同一网络下，普通浏览器正常，栖页扫码和获取手机验证码均提示「操作频繁」。目前没有用户的 Windows 平台会话或平台请求日志；云环境访问抖音受到网络代理 `CONNECT 403` 阻断，不能在云机器完成真实登录复现。

本地使用真实 Electron 44.6.0 / Chromium 152.0.7977.130 和环回测试网页，已取得以下证据：

| 检查 | 已观察到的结果 | 尚需完成 |
| --- | --- | --- |
| 浏览器 User-Agent 编码 | 旧默认标识包含中文「栖页」，`btoa(navigator.userAgent)` 抛出 `InvalidCharacterError`，HTTP 请求中的中文呈现乱码；修复后主页面、异源 iframe、Service Worker 和弹窗的 HTTP / JavaScript 标识均为 ASCII，编码成功且引擎版本与原生 Client Hints 一致 | 修复版 Windows 检查 |
| 弹窗中的旧 sessionStorage | 旧实现向 `noopener` 弹窗注入旧 nonce，本地登录流程产生 2 次 POST；修复后与原生对照均为 1 次 POST，弹窗初始为空且不会覆盖主页面快照，页面清空后在同一视图后续导航保持为空 | 修复版 Windows 检查 |
| 启动恢复与用户导航 | 旧实现的测试流程先访问 `/chosen`，随后被恢复中的 `/initial` 覆盖；修复后的受控真实 Electron 测试先恢复 `/initial`，再执行 `/chosen`，最终保留用户选择 | 修复版 Windows 检查 |

User-Agent 修复保留真实系统、Chromium 和 Electron 标识以及原生 Client Hints；测试工具 Playwright 产生的 `navigator.webdriver` 状态不能作为用户生产版启用自动化的证据。弹窗修复限定恢复和检查点归属，并保留已有主标签页关闭重开时继续环境的行为；不承诺捕获所有网站 `pagehide` 清理之后的最终状态。

0.1.1 本地单元测试 23 项通过，语法检查通过，真实浏览器隔离检查 22 项通过，新增 `tests/login-compatibility.cjs` 的 10 项登录兼容性检查通过。当前 Linux 无原生安全存储，加密会话 Cookie 与 sessionStorage 跨程序重启分支仍明确跳过，其他隔离和持久化检查实际执行。

以上是本地兼容性与状态流程的证据，不是抖音登录成功的证据。尚未确认「操作频繁」的根因。0.1.1 的 Windows 原生构建与发布验收尚未完成；下方 0.1.0 的成功结果不能代替这些检查。

## 0.1.0 已完成的历史验证

2026-10-07，Linux 云机器，Node.js 24、Electron 44.6.0、真实 Chromium 用户命名空间沙箱与 Xvfb。以下记录对应 0.1.0：

| 检查 | 结果 |
| --- | --- |
| 从锁文件重新安装并安装 Electron 可执行文件 | 通过 |
| JavaScript 语法检查 | 通过 |
| 环境清单及系统加密存储接口单元测试 | 23 项通过，无失败或跳过 |
| 本地站点的真实 Electron 隔离检查 | 22 项通过 |
| `npm start` 启动并通过界面接口完成本地页面请求 | 通过 |
| 中文界面新建、编辑、删除、对话框遮挡、快捷键和最小窗口 | 实际 Electron 操作验证通过 |
| Windows x64 ZIP 构建、整个压缩包完整性与包内源码一致性 | 通过；8 个运行时源文件与已测试源码逐字节一致 |

真实浏览器检查覆盖 Cookie、sessionStorage、localStorage、IndexedDB、Cache Storage、Service Worker、HTTP 缓存；验证不同环境同时登录互不影响、退出不影响其他账号、关闭重开与先于网站脚本恢复会话存储、改名、弹窗、并发关闭重开、程序重启，以及删除单个环境。退出后重开不会重新注入已清除的旧账号状态。

当前 Linux 没有原生安全存储。因此“会话型 Cookie 与 sessionStorage 的加密跨程序重启恢复”明确跳过；这两个类型在同次程序运行的关闭重开已验证。持久 Cookie、其他网站存储及缓存的跨程序重启检查通过，缺失安全存储的界面提示也已验证。CookieVault 单元测试使用 AES-GCM 测试替身验证加密接口与数据行为，不能代替 Windows DPAPI 原生检查。

已推送提交 `be68465` 并执行 [Windows Actions 验证（run 37559683661）](https://github.com/liu341567-sys/zhiwen/actions/runs/37559683661)：单元测试、语法检查、真实 Chromium 会话隔离检查、NSIS 安装器构建及构建产物上传全部成功。匿名访问无法查看详细日志，因此尚不能确认 DPAPI 专属恢复分支是否实际执行。Windows 实机手动安装与使用、抖音等平台的真实登录/扫码/验证码及下载流程仍待人工验收。

同日，[发布工作流（run 37559967650）](https://github.com/liu341567-sys/zhiwen/actions/runs/37559967650)通过版本校验、Windows 测试、NSIS 和 ZIP 构建、文件校验及发布步骤。已创建 [v0.1.0 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.0)，对应 `be68465`。安装包与 ZIP 的直接下载链接跟随重定向均返回 HTTP 200；下载的 `SHA256SUMS.txt` 与 GitHub 公布的两个附件摘要一致。

本地测试不使用真实账号。测试数据置于临时目录，应用包不包含测试账号数据或环境快照。
