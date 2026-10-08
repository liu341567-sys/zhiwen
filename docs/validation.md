# 当前验证记录

## 测试条件更正

0.1.0 / 0.1.1 使用的 Playwright Electron 启动器默认曾注入 `--no-sandbox`，还改变第三方存储分区、使用基本密码库与 mock keychain、允许弹窗等测试行为。此前将这些 Linux 测试描述为“真实 Chromium 用户命名空间沙箱”过强，现予更正。旧结果仍证明所记录的真实 Electron 测试流程成功，不能单凭它们认定生产版沙箱或完全原生的存储、密钥库、弹窗行为已经验证。

0.1.2 改为显式 `chromiumSandbox: true`，在测试入口移除上述行为开关，并通过测试专用私有预加载脚本，直接检查实际主框架的沙箱与上下文隔离状态。测试需要的调试接口仍用于检查应用；该启动器和探针不进入生产包。下方保留历史测试与发布结果，并单独记录修正后的证据。

## 0.1.3 视觉与品牌验证

2026-10-08，Linux 本地使用真实 Electron 与 Xvfb 完成以下检查。品牌素材来自用户提供的两份原始 PNG，原图及来源摘要已保留；界面、窗口尺寸和图标配置调整不改变环境数据与登录流程。

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 39 项通过 |
| 真实浏览器隔离检查 | 23 项通过 |
| 登录兼容性检查 | 16 项通过 |
| 真实窗口界面检查 | 135 项通过，覆盖 100%、125%、150% 的实际设备缩放 |
| Chromium 沙箱与上下文隔离 | 测试保留 Chromium 沙箱，实际网页主框架状态断言通过 |
| 界面截图 | 已人工检查多缩放、小窗口、标签及对话框的截图 |
| Windows 原生 CI、安装包与 ZIP 构建 | 待验证 |
| Windows PE、安装后图标与快捷方式 | 待验证 |
| 0.1.3 发布及附件下载、校验 | 待验证 |

真实窗口检查覆盖长短名称、标签省略与横向滚动、悬停和选中状态下关闭按钮位置、工作区限制、900 × 480 小内容视口、对话框滚动及按钮可点击性；同时通过界面操作检查改名、关闭重开、独立数据和诊断功能。测试使用临时环境和本地测试网页，不包含真实平台账号。

当前 Linux 没有原生安全存储，会话 Cookie 与 sessionStorage 的加密跨程序退出恢复分支仍跳过；其他已列检查实际执行。0.1.2 的 Windows DPAPI 结果保留在下方历史记录中，不能替代本次 0.1.3 的 Windows 验证。抖音、知乎真实登录尚未验证，本次视觉改动不构成平台登录问题已解决的证据。README 暂保留已验证的 0.1.2 下载链接，0.1.3 附件须在实际发布和校验后更新。

## 0.1.2 验证与待办

2026-10-07，本地 Linux 检查使用 Node.js 24、Electron 44.6.0 / Chromium 152.0.7977.130 与 Xvfb。以下分别记录本地结果及后续 Windows 原生验证：

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 39 项通过：14 项诊断、2 项浏览器标识及原有 23 项检查 |
| 真实浏览器隔离检查 | 23 项通过 |
| 登录兼容性检查 | 16 项通过 |
| 真实网站主框架运行状态 | `sandboxed: true`、`contextIsolated: true`、`isMainFrame: true` |
| 非 Playwright 的 Linux 原生启动探针 | `navigator.webdriver: false`；webdriver 这一项仅为 Linux 原生探针的观察 |
| 全局浏览器标识 | 页面、异源 iframe、弹窗和 Service Worker 的 JavaScript / HTTP 标识一致，为 ASCII；不含 `Qiye` / `Electron` 产品标识，保留真实系统和完整 Chromium 版本，Client Hints 与引擎一致 |
| Windows 原生单元与集成检查 | 39 项单元、23 项隔离、16 项登录兼容性检查及语法检查通过 |
| Windows 实际主框架沙箱与上下文隔离 | 严格断言通过，测试注入的行为开关已移除 |
| Windows 系统加密恢复 | 原生安全存储强制断言通过，DPAPI 下会话 Cookie / sessionStorage 跨退出恢复分支实际执行并通过 |
| Windows NSIS 安装包构建与上传 | 通过 |
| 发布流程、NSIS / ZIP 构建与附件下载 | 通过，三个附件最终 HTTP 200，校验文件与附件摘要一致 |

原生安全存储在当前 Linux 机器不可用，加密会话 Cookie 与 sessionStorage 跨程序退出恢复仍明确跳过；同次运行的关闭重开、持久 Cookie 及其他网站存储的检查实际执行。单元测试中的加密替身不能代替 Windows DPAPI 验证。

[Windows 原生验证（run 37583761902）](https://github.com/liu341567-sys/zhiwen/actions/runs/37583761902)对应提交 `ed6ceb51d625af13c3ea94a123f60f3d320bdc5a`，所有检查、NSIS 安装器构建和上传均成功。该版本在 Windows 上要求 `nativeCookieEncryption === true`，否则测试立即失败，因此本次成功确认了原生系统加密可用，并实际执行了重启后恢复会话 Cookie 和在网站脚本运行前恢复 sessionStorage 的检查。这一结果验证本地测试网页的加密恢复流程，不能代替真实知乎或抖音登录。

[0.1.2 发布工作流（run 37584006111）](https://github.com/liu341567-sys/zhiwen/actions/runs/37584006111)对应同一提交，构建与发布作业均已成功。[v0.1.2 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.2)已作为非草稿预发布版本发布。发布页和下列三个附件的直接下载链接，跟随重定向后最终均返回 HTTP 200；实际读取的 `SHA256SUMS.txt` 两行与 ZIP、安装包的 GitHub 附件 SHA256 摘要逐项一致。

| 附件 | 字节数 | SHA256 |
| --- | --- | --- |
| [Qiye-0.1.2-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.2/Qiye-0.1.2-x64.zip) | 153134100 | `3d7eee980a1a5963e5decb9e7456864be28171de4cd1f3e77574e29ebe804efe` |
| [Qiye-Setup-0.1.2-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.2/Qiye-Setup-0.1.2-x64.exe) | 111399617 | `cf2aa8f9f9eb809bc08fe0fc2c45ea46dd44e18358a82bdd2f90034329cf38a5` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.2/SHA256SUMS.txt) | 178 | `26916b62f7034219e9c4cec22bb65a5dba69cf4d08afcd3218d916e6cc2d0e69` |

新增知乎登录诊断必须手动开启，限定开始时选中的环境、知乎请求和 120 秒时限。统计定义为记录期间完成或失败的请求，可能包含记录前发出而记录内结束的在途请求。测试检查固定统计字段、错误提示布尔值和报告数据边界；报告不保留 URL / 路径 / 查询、头或正文、Cookie、手机号、输入值、页面正文、原始 UA、环境 ID 或名称。标识设置与诊断不改写平台登录参数或签名，不通过页面脚本伪造 navigator，不禁用 TLS 验证。

用户确认 0.1.1 中知乎扫码和手机验证码登录均出现 `10001：请求参数异常，请升级客户端后重试`。原因尚未确认。云网络无法访问知乎，没有可用的真实平台登录验证；上述本地及 Windows 原生测试结果不能当作知乎或抖音账号登录已成功的证据。当前 README 已提供通过下载与校验检查的 0.1.2 附件，真实平台登录仍待实机复测。

## 0.1.1 修复的本地证据

2026-10-07，用户报告同一 Windows 电脑、同一网络下，普通浏览器正常，栖页扫码和获取手机验证码均提示「操作频繁」。目前没有用户的 Windows 平台会话或平台请求日志；云环境访问抖音受到网络代理 `CONNECT 403` 阻断，不能在云机器完成真实登录复现。

本地使用真实 Electron 44.6.0 / Chromium 152.0.7977.130 和环回测试网页，已取得以下证据：

| 检查 | 已观察到的结果 | 验证状态 |
| --- | --- | --- |
| 浏览器 User-Agent 编码 | 旧默认标识包含中文「栖页」，`btoa(navigator.userAgent)` 抛出 `InvalidCharacterError`，HTTP 请求中的中文呈现乱码；修复后主页面、异源 iframe、Service Worker 和弹窗的 HTTP / JavaScript 标识均为 ASCII，编码成功且引擎版本与原生 Client Hints 一致 | Windows 集成检查通过 |
| 弹窗中的旧 sessionStorage | 旧实现向 `noopener` 弹窗注入旧 nonce，本地登录流程产生 2 次 POST；修复后与原生对照均为 1 次 POST，弹窗初始为空且不会覆盖主页面快照，页面清空后在同一视图后续导航保持为空 | Windows 集成检查通过 |
| 启动恢复与用户导航 | 旧实现的测试流程先访问 `/chosen`，随后被恢复中的 `/initial` 覆盖；修复后的受控真实 Electron 测试先恢复 `/initial`，再执行 `/chosen`，最终保留用户选择 | 本地受控测试通过；Windows 自动检查未单独覆盖此竞态 |

User-Agent 修复保留真实系统、Chromium 和 Electron 标识以及原生 Client Hints；测试工具 Playwright 产生的 `navigator.webdriver` 状态不能作为用户生产版启用自动化的证据。弹窗修复限定恢复和检查点归属，并保留已有主标签页关闭重开时继续环境的行为；不承诺捕获所有网站 `pagehide` 清理之后的最终状态。

0.1.1 本地单元测试 23 项通过，语法检查通过，真实浏览器隔离检查 22 项通过，新增 `tests/login-compatibility.cjs` 的 10 项登录兼容性检查通过。当前 Linux 无原生安全存储，加密会话 Cookie 与 sessionStorage 跨程序重启分支仍明确跳过，其他隔离和持久化检查实际执行。

以上是本地兼容性与状态流程的证据，不是抖音登录成功的证据。尚未确认「操作频繁」的根因。[0.1.1 Windows 发布工作流（run 37578110003）](https://github.com/liu341567-sys/zhiwen/actions/runs/37578110003)的单元测试、语法检查、两套集成检查、NSIS / ZIP 构建与发布均已成功。启动竞态使用受控真实 Electron 本地 fixture 验证，未纳入 Windows 自动检查。下方 0.1.0 记录保留为历史证据。

已发布 [v0.1.1 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.1)，对应提交 `7a2e8c4`。安装包、ZIP 和校验文件的直接下载链接跟随重定向均为 HTTP 200，已读取的 `SHA256SUMS.txt` 与 GitHub 附件摘要一致。

## 0.1.0 已完成的历史验证

2026-10-07，Linux 云机器，Node.js 24、Electron 44.6.0 与 Xvfb。以下记录对应 0.1.0，测试启动参数的限制见上方更正：

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
