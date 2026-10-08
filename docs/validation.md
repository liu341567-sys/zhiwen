# 当前验证记录

## 测试条件更正

0.1.0 / 0.1.1 使用的 Playwright Electron 启动器默认曾注入 `--no-sandbox`，还改变第三方存储分区、使用基本密码库与 mock keychain、允许弹窗等测试行为。此前将这些 Linux 测试描述为“真实 Chromium 用户命名空间沙箱”过强，现予更正。旧结果仍证明所记录的真实 Electron 测试流程成功，不能单凭它们认定生产版沙箱或完全原生的存储、密钥库、弹窗行为已经验证。

0.1.2 改为显式 `chromiumSandbox: true`，在测试入口移除上述行为开关，并通过测试专用私有预加载脚本，直接检查实际主框架的沙箱与上下文隔离状态。测试需要的调试接口仍用于检查应用；该启动器和探针不进入生产包。下方保留历史测试与发布结果，并单独记录修正后的证据。

## 0.1.5 侧栏与焦点回归

本轮源码提交为 `bb2fcab0a04456a0187737fea2e2cf18d3ee0e82`。调整侧栏专用蓝色状态与环境操作的焦点处理，修复对话框关闭后重新渲染按钮的焦点恢复；原图、字号、布局和账号数据逻辑保持，依赖树仅应用版本号变化。

Git blob 核验确认：应用 ICO、PNG 与字标，以及主进程、环境清单、两份预加载、Cookie 保险库、浏览器标识和登录诊断文件均与 0.1.4 逐字节相同。`package-lock.json` 除两处应用根版本外，依赖树相同。

| 检查 | 本轮结果 |
| --- | --- |
| Linux 单元测试 | 39 项通过 |
| JavaScript 语法检查 | `npm run check` 通过 |
| Linux 真实窗口 UI 回归 | 180 项通过，9 个不同布局，无跳过；100% / 125% / 150% 实际 DPR 各 60 项 |
| 新增焦点交互回归 | 每档设备缩放新增 15 项，共 45 项，已纳入上述 180 项 |
| 截图人工检查 | 已查看 100% 启动工作空间及 900 × 480 鼠标 / 键盘截图，150% 的 900 × 480 鼠标 / 键盘截图；侧栏蓝块、实心新建按钮和键盘单焦点轮廓正确 |
| Linux 隔离与登录兼容性集成检查 | 本轮未重新运行；历史 23 / 16 项结果不计入本轮 Linux 成绩 |
| Windows 单元、语法与浏览器集成 | 39 项单元、23 项隔离、16 项登录兼容性及语法检查通过 |
| Windows 真实窗口 UI 回归 | 147 项通过，6 个实际布局，无跳过；100% / 125% / 150% 实际 DPR 分别为 60 / 49 / 38 项 |
| Windows DPAPI 与原生安装验收 | 原生加密恢复、NSIS 安装、PE 图标、快捷方式、已安装数据恢复及卸载均通过 |
| 0.1.5 发布及附件下载、校验 | 通过，发布页及三个附件最终 HTTP 200，实际读取的校验文件与 API 附件摘要一致 |

真实 Electron 已确认：鼠标点击环境操作后，单独按 Shift 会触发原生 `:focus-visible` 启发式的额外轮廓，无需滚轮；滚动与鼠标移动未改变当前环境。修复区分指针输入和实际导航键，Shift 等修饰键自身不切换键盘模式，只对鼠标来源的环境操作按钮抑制额外轮廓。对话框按逻辑 `data-focus-key` 找到重新渲染的按钮，恢复原编辑控件焦点。

永久回归模块 `tests/ui-focus.cjs` 已接入 `tests/ui-layout.cjs`，使用真实鼠标与键盘检查点击、Shift、双向滚轮和普通滚动、单一当前环境、Tab / Shift+Tab 焦点、Enter / Space 操作、Escape 与取消后的逻辑焦点恢复，以及表单 Ctrl+A 文本选择。回归通过不表示复现过卡片文字 Range 选择问题，也不表示新增环境多选功能。

[Windows 主分支检查（run 37746619577）](https://github.com/liu341567-sys/zhiwen/actions/runs/37746619577)已完整成功，对应提交 `bb2fcab0a04456a0187737fea2e2cf18d3ee0e82`。Windows 实际窗口回归包括每档新增 15 项焦点交互检查，共新增 45 项；工作区限制下合并重复布局后，共执行 147 项、6 个实际布局，无跳过。

| 设备缩放 / 实际 DPR | 实际内容视口 | UI 检查 |
| --- | --- | --- |
| 100% / 1 | 1008 × 681、1008 × 680、900 × 480 | 60 项通过 |
| 125% / 1.25 | 808 × 545、808 × 480 | 49 项通过 |
| 150% / 1.5 | 672 × 454 | 38 项通过 |

原生 DPAPI 和实际 NSIS 安装验收通过：PE 图标帧与源图标匹配，桌面与开始菜单快捷方式的目标、图标和 AppUserModelID 正确；已安装程序的字标、原生启动、`WM_CLOSE` 退出、账号测试数据重启恢复及卸载均通过。

[0.1.5 发布工作流（run 37746621542）](https://github.com/liu341567-sys/zhiwen/actions/runs/37746621542)已完整成功，构建与发布作业均通过，对应同一提交 `bb2fcab0a04456a0187737fea2e2cf18d3ee0e82`。发布流程完整执行上述 147 项实际窗口检查与安装验收，并成功构建 NSIS / ZIP 附件。[v0.1.5 Windows 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.5)已作为非草稿预发布版本公开。

匿名访问发布页及下列三个附件的直接链接，跟随 HEAD 重定向后最终均返回 HTTP 200。实际 GET 读取的 `SHA256SUMS.txt` 为 178 字节，自身 SHA256 与 GitHub API 附件摘要一致；其中安装包和 ZIP 的两行摘要也与 API 附件 SHA256 逐项一致。

| 附件 | 字节数 | SHA256 |
| --- | --- | --- |
| [Qiye-0.1.5-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.5/Qiye-0.1.5-x64.zip) | 153892318 | `5b7ab30cbeec27122d30ad00b813982d3a1157421841f2e70c96cef91e9d679e` |
| [Qiye-Setup-0.1.5-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.5/Qiye-Setup-0.1.5-x64.exe) | 112403442 | `49e9b93d98d61f7fe090d386fda8592e154ed4f32bcf3f23660aa5464efc5dbb` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.5/SHA256SUMS.txt) | 178 | `f977eb9f222a5f650df760b2b7d6689c8d6f348fad9102d40c77bc571ac7ff6a` |

设备缩放由 Electron 设置并核对实际 DPR，未切换 Windows 设置面板的物理显示器 DPI。真实知乎、抖音登录继续待实机复测。

## 0.1.4 配色与几何审计

本轮最终源码提交为 `6f7054bf7d76140a9cef141ee7d3d5a2e79aaf38`，修改限定于 CSS 绘制属性、原生窗口初始背景和版本号。Logo、字体、页面结构、几何布局及业务运行逻辑沿用 0.1.3。

| 检查 | 本轮结果 |
| --- | --- |
| Linux 原有真实窗口界面检查 | 135 项通过，9 个不同布局，无跳过；此轮检查完成于最后三项配色微调之前 |
| 最终配色后的同 DOM 几何对照 | 27 组通过：3 档设备缩放 × 3 种视口 × 工作空间 / 浏览页面 / 新建对话框 |
| 关键节点与字体几何 | 20 组选择器覆盖 38 个关键节点，DOM 矩形与 12 项字体 / 几何计算样式和 0.1.3 完全一致 |
| CSSOM 几何规则 | 198 个顶层几何规则保持一致，媒体查询、关键帧及边框简写的宽度 / 样式也已核对 |
| 品牌素材与固定尺寸 | 三份应用品牌素材 SHA256 一致；字标自然尺寸保持 1253 × 559，关闭按钮保持 30 × 30 |
| 实际关键文本状态对比度 | 1473 次采样均达到 4.5:1，最低为 5.0347:1；12 px 页脚说明使用 `#5e6a7b` 文字和 `#f4f5f7` 背景 |
| 快捷键辅助文字透明度合成 | `opacity: 0.9` 的采样最低为 9.0959:1，位于按下状态背景 |
| 最终截图 | 已人工检查空工作空间、三个环境卡片、新建与诊断对话框 |
| Linux 核心单元与集成检查 | 本轮未重新运行，0.1.3 的成绩保留为历史结果 |
| Windows 单元、语法与集成检查 | 39 项单元、23 项隔离、16 项登录兼容性检查及语法检查通过 |
| Windows 实际窗口界面检查 | 102 项通过，6 个实际布局，无跳过；100% / 125% / 150% 分别为 45 / 34 / 23 项 |
| Windows DPAPI 与实际安装验收 | 原生加密恢复、NSIS 当前用户安装、PE 图标、桌面 / 开始菜单快捷方式、已安装程序数据恢复及卸载均通过 |
| 0.1.4 发布、附件下载与校验 | 通过，发布页及三个附件最终 HTTP 200，校验文件与附件摘要一致 |

27 组对照使用同一 DOM 比较 0.1.3 与最终配色，验证颜色调整后的几何稳定性；它们与微调前的 135 项完整 UI 检查分别记录。CSSOM 的 198 个顶层规则与 renderer 静态非绘制投影的 268 个规则 / 998 条声明采用不同统计口径，不能将两者当成同一计数。静态投影的几何摘要保持为 `5d2df6face810538743686c6946170c508e2d20cab3f8d0a43528519a6f561e7`。

[Windows 验证（run 37723128157）](https://github.com/liu341567-sys/zhiwen/actions/runs/37723128157)与[发布工作流（run 37723460817）](https://github.com/liu341567-sys/zhiwen/actions/runs/37723460817)均已成功，对应提交 `6f7054bf7d76140a9cef141ee7d3d5a2e79aaf38`。Windows 最终配色完整执行 39 项单元、23 项隔离、16 项登录兼容性检查与语法检查，原生 DPAPI 可用性与加密恢复分支通过。实际窗口检查为 102 项、6 个布局、无跳过，三档设备缩放的检查分别为 45、34、23 项；较大窗口按工作区夹取并合并重复布局。缩放使用 Electron `--force-device-scale-factor` 并检查实际 DPR，不代表切换 Windows 设置面板的物理显示器 DPI。

实际 NSIS 安装验收通过：程序、安装器及卸载器的 PE 图标帧与源 ICO 逐尺寸匹配，桌面和开始菜单快捷方式及 AppUserModelID 正确。已安装程序的字标比例、原生启动、`WM_CLOSE` 退出和账号测试数据重启恢复均通过，卸载清理也通过。发布构建作业的检查注释确认了实际窗口及已安装程序验收结果；改名与备注检查使用应用接口。

[v0.1.4 Windows 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.4)已作为非草稿预发布版本发布，发布工作流的构建与发布作业均成功。匿名访问发布页及下列三个附件的直接链接，跟随重定向后最终均返回 HTTP 200。实际 GET 读取的 `SHA256SUMS.txt` 为 178 字节，自身 SHA256 与 GitHub API 附件摘要一致；其中安装包与 ZIP 的两行摘要也与 API 附件 SHA256 逐项完全相同。

| 附件 | 字节数 | SHA256 |
| --- | --- | --- |
| [Qiye-0.1.4-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.4/Qiye-0.1.4-x64.zip) | 153891871 | `a7f36b490d9acfd37b3cc3603e8b480e1250ac0f103a3d838650c65b645b5d8a` |
| [Qiye-Setup-0.1.4-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.4/Qiye-Setup-0.1.4-x64.exe) | 112403055 | `b02131e8b7fc2377b89621e97ece3bd71fccadb1fc741e51bf4536d88f25e0a5` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.4/SHA256SUMS.txt) | 178 | `ac7d851ded952cd2a656c95987661ea66067c670d46af781f908b3554c6ab476` |

上述审计和 Windows 自动检查使用本地测试环境，不是知乎或抖音真实登录成功的证据；真实平台登录仍待实机复测。

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
| Windows 原生单元与集成检查 | 39 项单元、23 项隔离、16 项登录兼容性检查及语法检查通过 |
| Windows 系统加密恢复 | 原生 DPAPI 强制断言与恢复分支全部通过 |
| Windows 实际窗口界面检查 | 102 项通过，6 个实际布局，无跳过，覆盖 100%、125%、150% 缩放 |
| Windows NSIS 构建与当前用户实际安装 | 通过 |
| Windows PE、安装后图标与快捷方式 | 严格检查通过，主程序、安装器和卸载器的首组九尺寸图标像素摘要与源图标一致 |
| Windows 已安装程序的数据与生命周期 | 本地测试网页的改名、备注、关闭重开、原生退出及重启恢复通过；卸载清理通过 |
| 0.1.3 发布及附件下载、校验 | 通过，发布页及三个附件最终 HTTP 200，校验文件与附件摘要一致 |

真实窗口检查覆盖长短名称、标签省略与横向滚动、悬停和选中状态下关闭按钮位置、工作区限制、900 × 480 小内容视口、对话框滚动及按钮可点击性；同时通过界面操作检查改名、关闭重开、独立数据和诊断功能。测试使用临时环境和本地测试网页，不包含真实平台账号。

当前 Linux 没有原生安全存储，会话 Cookie 与 sessionStorage 的加密跨程序退出恢复分支仍跳过；其他已列检查实际执行。Windows 本次检查强制确认原生安全存储可用，DPAPI 加密恢复分支实际执行并通过。

[Windows 原生验证（run 37719809463）](https://github.com/liu341567-sys/zhiwen/actions/runs/37719809463)对应提交 `bf08ab58638d77aef424cd54964fa79eb60350a5`，检查、NSIS 构建和安装验收全部成功。运行器的工作区会随缩放变小，因此测试按实际可用尺寸夹取窗口并合并重复布局；这属于实际运行的布局，不是跳过大窗口用例。

缩放检查使用 Electron 的 `--force-device-scale-factor`，并严格核对实际 `devicePixelRatio`、原生窗口和网页视图几何位置；没有通过 Windows 设置面板切换物理显示器的 DPI。

| 设备缩放 / 实际 DPR | 实际工作区 | 实际内容视口 | 界面检查 |
| --- | --- | --- | --- |
| 100% / 1 | 1024 × 720 | 1008 × 681、1008 × 680、900 × 480 | 45 项通过 |
| 125% / 1.25 | 820 × 576 | 808 × 545、808 × 480 | 34 项通过 |
| 150% / 1.5 | 683 × 480 | 672 × 454 | 23 项通过 |

安装验收实际执行 NSIS 当前用户安装。主程序、安装器和卸载器的 PE 图标按首组九种尺寸核对原始像素 SHA256；外置图标文件也核对摘要。桌面与开始菜单快捷方式通过原生 `IShellLinkW` / `IPersistFile.Load` 和 `IPropertyStore` 读取，成功结果均为 `S_OK`，目标、图标索引 `0` 与 `com.qiye.browser` AppUserModelID 均符合预期。此前 WSH 读取到空值的快捷方式属性，已由上述原生接口复核纠正。

实际启动已安装的程序，验证字标比例正确及 `navigator.webdriver: false`，使用本地网页验证弹窗继承所属环境 Cookie；通过应用接口改名、修改备注、关闭重开，并通过原生 `WM_CLOSE` 退出后重新启动，持久和会话 Cookie、localStorage 与 sessionStorage 均恢复成功。卸载后主程序及桌面、开始菜单快捷方式已移除。

[0.1.3 发布工作流（run 37720249026）](https://github.com/liu341567-sys/zhiwen/actions/runs/37720249026)已完成，构建与发布作业均成功。[v0.1.3 Windows 试用版](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.3)已作为非草稿预发布版本发布。实际访问发布页及下列三个附件的直接下载链接，跟随重定向后最终均返回 HTTP 200；读取的 `SHA256SUMS.txt` 两行与 ZIP、安装包的 GitHub API 附件 SHA256 摘要逐项完全一致。

| 附件 | 字节数 | SHA256 |
| --- | --- | --- |
| [Qiye-0.1.3-x64.zip](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.3/Qiye-0.1.3-x64.zip) | 153891768 | `945876e619575e2583ba5c12d79e4695ab34c6ff63b59ff4e2da840372e2b826` |
| [Qiye-Setup-0.1.3-x64.exe](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.3/Qiye-Setup-0.1.3-x64.exe) | 112402940 | `63d7a33f17391c6bbf3aa30f82d863f81deffec3bca04fb0ee4d899c238a4d64` |
| [SHA256SUMS.txt](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.3/SHA256SUMS.txt) | 178 | `8e0d53008897f5e6ebfc127239a3f5dc375a0d8118e3f59abae28075980fa074` |

抖音、知乎真实登录尚未验证，本次视觉改动不构成平台登录问题已解决的证据。

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

用户确认 0.1.1 中知乎扫码和手机验证码登录均出现 `10001：请求参数异常，请升级客户端后重试`。原因尚未确认。云网络无法访问知乎，没有可用的真实平台登录验证；上述本地及 Windows 原生测试结果不能当作知乎或抖音账号登录已成功的证据。0.1.2 附件已通过下载与校验检查，真实平台登录仍待实机复测。

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
