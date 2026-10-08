# 栖页 · 多账号浏览器

栖页是面向 Windows 10 / 11（64 位）的桌面浏览器，用于同时管理抖音等网站的多个账号。每个环境拥有独立且持久化的 Chromium 会话；新建环境从空白登录状态开始，再次打开已有环境则使用原来的浏览器数据。

## Windows 下载

- [下载安装版（约 107 MB）](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.3/Qiye-Setup-0.1.3-x64.exe)：下载后运行安装程序。
- [下载 ZIP 版（约 147 MB）](https://github.com/liu341567-sys/zhiwen/releases/download/v0.1.3/Qiye-0.1.3-x64.zip)：完整解压后运行其中的 `栖页.exe`，保留同目录所有文件。

[v0.1.3 发布页](https://github.com/liu341567-sys/zhiwen/releases/tag/v0.1.3)提供发布说明和 SHA256 校验文件。这是未签名的试用版；使用已打包的版本无需安装 Node.js。该版采用用户提供的原始 Logo，统一蓝色配色及字体层级，固定标签关闭区域，并改善小窗口与对话框布局。账号环境、数据目录及登录流程沿用原有实现。更新前正常退出旧版并备份数据目录，已有环境继续保留。

[Windows 发布检查](https://github.com/liu341567-sys/zhiwen/actions/runs/37720249026)已通过，包括实际沙箱、系统加密恢复、三档设备缩放、安装包 / ZIP 构建以及安装后的图标、快捷方式与原生程序运行；三个附件的下载与校验文件已核实。知乎 `10001：请求参数异常，请升级客户端后重试` 的原因尚未确认，真实知乎和抖音登录仍需实机复测。[视觉规范](docs/visual-system.md)记录本次品牌与布局调整。

## 使用方式

1. 点击「新建环境」，设置名称、备注、标记颜色和起始网址。默认打开 `https://www.douyin.com/`。
2. 在新环境中登录对应账号。继续新建环境，可以独立登录另一个账号。
3. 从环境列表打开或切换账号。多个环境可以同时保持打开；网站打开的登录弹窗沿用所属环境。
4. 关闭标签页只关闭页面，保留环境。重新打开后继续使用原来的 Cookie 和存储；退出应用后再次启动，恢复上次仍打开的环境和最近网址。
5. 修改名称或备注不影响登录。删除环境会清除其 Cookie、网站存储和缓存，并移除环境记录，操作不可恢复。

快捷键：`Ctrl+T` 新建环境、`Ctrl+L` 聚焦地址栏、`Ctrl+W` 关闭当前环境标签页。地址栏支持 HTTP / HTTPS 网页，提供后退、前进和刷新。

“已打开”表示环境的页面正在运行，并不表示平台账号已登录。平台可能使登录过期、要求扫码或额外验证；栖页保留本地会话数据，无法替平台续期。各环境仍使用当前电脑和网络出口，不提供代理、设备指纹伪装或平台风控规避功能。

## 知乎登录诊断

1. 打开需要检查的账号环境，在其中访问知乎，点击「登录诊断」。
2. 点击「开始记录」，对话框自动关闭。回到网页，手动执行一次登录。
3. 再次打开「登录诊断」，查看结果并点击「保存报告」，选择本地 JSON 文件位置。保存操作会结束记录；也可以先点击「结束记录」。每次记录仅针对开始时选中的环境，最多持续 2 分钟。

报告包含应用与引擎版本、记录期间完成或失败的知乎请求数量、HTTP 状态、网络错误、是否观察到可见的 `10001` 提示，以及 User-Agent / Client Hints 一致性结果。记录开始前已发出、记录期间才完成或失败的请求也会计入。报告不保存网址、路径、查询参数、请求头或正文、Cookie、手机号、输入值、页面正文、原始 User-Agent、环境 ID 或名称。报告只保存在用户选择的本地文件，不自动上传，也不会自动重试登录。

## 本地运行

安装 [Node.js 24 LTS](https://nodejs.org/) 和 Git，在终端运行：

```powershell
git clone https://github.com/liu341567-sys/zhiwen.git
cd zhiwen
npm ci
npm run setup:electron
npm start
```

`npm ci` 使用提交的锁文件。Electron 44 的 npm 包与浏览器可执行文件分开安装，首次启动前需要执行 `npm run setup:electron`。依赖安装和打包需要访问 npm 注册表及 Electron 的官方发布下载源。开发环境建议使用 Node.js 24；Electron 安装工具要求 Node.js 22.12 或更新版本。

在 Linux 云环境验证时，需要可用的图形显示或 Xvfb，以及 Electron 所需系统库。以普通用户运行 Electron，保留 Chromium 沙箱；不要为运行应用关闭沙箱或 TLS 验证。

## 检查与 Windows 打包

```powershell
npm test
npm run check
npm run test:integration
npm run test:ui
npm run dist:win
```

- `npm test`：环境清单、网址校验和持久化等单元测试。
- `npm run check`：JavaScript 语法检查。
- `npm run test:integration`：实际启动 Electron，使用本地测试网页验证浏览器会话隔离、持久化、删除清理、浏览器标识与登录存储兼容性。测试显式启用 Chromium 沙箱，清理测试工具注入的行为开关，并直接断言主框架的实际沙箱与上下文隔离状态。测试使用临时目录，不需要真实平台账号。
- `npm run test:ui`：在真实 Electron 窗口中以 100%、125%、150% 的设备缩放检查品牌图片、标签关闭区域、长名称、弹窗、小工作区及原生网页视图位置。实际尺寸与检查数量按显示器工作区记录。
- `npm run dist:win`：生成当前源码版本的 Windows x64 NSIS 安装程序，默认输出到 `dist/Qiye-Setup-0.1.3-x64.exe`。

也可执行 `npm run dist:win:zip`，生成 `dist/Qiye-0.1.3-x64.zip`。将整个压缩包解压到一个目录，运行其中的 `栖页.exe`；必须保留同目录的运行库和资源文件，不能只复制 exe。应用数据仍单独保存到用户数据目录，更新程序时不会使用安装目录中的空白数据替换账号环境。Linux 交叉构建 NSIS 安装程序需要 Wine，ZIP 构建不需要。

仓库提供 [Windows 构建工作流](.github/workflows/windows.yml)，可在 GitHub Actions 中手动运行，下载上传的安装包。工作流执行上述检查和打包，在临时运行器实际安装、验证 PE 图标与快捷方式、启动及重启程序，完成后卸载；不自动发布 Release。当前打包配置没有代码签名证书，安装包未签名。

真实平台验收仍需在 Windows 实机使用两个测试账号确认抖音、知乎登录、扫码/弹窗、退出账号、重启与下载行为。自动测试验证本地浏览器行为，不能替代第三方平台登录兼容性检查。当前结果与历史测试条件的更正见 [验证记录](docs/validation.md)。

## 数据位置与备份

默认数据目录是 Windows 的 `%APPDATA%\栖页`，应用界面也会显示实际目录。开发时可用环境变量指定另一目录：

```powershell
$env:QIYE_DATA_DIR = "D:\QiyeData"
npm start
```

`profiles.json` 保存环境名称、备注、网址和打开状态；登录 Cookie 等浏览器数据由 Chromium 保存于对应的独立持久化分区。为支持没有过期日期的会话 Cookie，以及部分网页使用的临时会话存储（sessionStorage），应用还在 `session-cookies` 目录按环境保存使用系统安全存储加密的快照；Windows 使用 DPAPI。再次打开时，sessionStorage 会在网站脚本运行前恢复到原环境、原网站来源。应用不主动保存账号密码。不要在名称或备注中填写密码。

若系统安全存储不可用，应用提示会话 Cookie 和 sessionStorage 无法跨退出恢复，不会退回明文保存；同一次程序运行中关闭标签页再打开仍可恢复。此时有过期日期的持久化 Cookie 和其他持久化网站存储仍由 Chromium 管理。

备份前正常退出应用，再复制整个数据目录；只复制 `profiles.json` 无法保存登录环境。恢复前先备份现有目录，并保持应用关闭。部分 Cookie 会使用系统加密，迁移到其他电脑或 Windows 用户后可能需要重新登录；备份也不能延长平台登录有效期。请妥善保护包含登录会话的数据目录。

技术结构与隔离边界见 [架构说明](docs/architecture.md)。
