# 架构与环境生命周期

## 环境与会话

桌面壳使用 Electron，管理界面使用本地 HTML / CSS / JavaScript。主进程负责环境清单、网页视图与会话；管理界面只能通过预加载脚本中限定的 IPC 方法调用这些操作。

每个环境创建随机 UUID，使用 `session.fromPartition("persist:account-" + id)`。UUID 是会话身份，名称、备注和颜色仅是展示信息。每个网页视图明确绑定自己的 Session，网站弹窗也继承同一 Session。

这些分区隔离 Cookie、HTTP 缓存、localStorage、IndexedDB、Cache Storage 和 Service Worker 等浏览器数据。sessionStorage 同时遵循网站来源与窗口的 Chromium 原生隔离规则；主标签页的检查点用于关闭重开后的恢复。标签页切换只改变显示中的视图，其他已打开环境继续运行。一个环境内的网站页面和登录弹窗使用同一 Session，共享该环境的 Cookie 等会话数据，但不把各窗口的 sessionStorage 合并成一份。

会话隔离不等于独立设备：环境使用同一 Chromium 版本、电脑和网络出口。网站账号状态由网站决定，应用不根据 Cookie 或页面标题推断是否登录。

## 生命周期

| 操作 | 环境身份 | 浏览器数据 | 打开状态 |
| --- | --- | --- | --- |
| 新建 | 生成新的 UUID | 新的空白分区 | 打开新视图 |
| 修改名称、备注、颜色 | 保持原 UUID | 保留 | 保持 |
| 切换标签页 | 保持原 UUID | 保留 | 其他视图继续运行 |
| 关闭标签页 | 保持原 UUID | 写入磁盘并保留 | 关闭视图，从打开列表移除 |
| 再次打开环境 | 使用原 UUID | 读取原分区 | 打开最近访问网址 |
| 退出应用 | 保持原 UUID | 刷新磁盘写入 | 保存仍打开的列表 |
| 再次启动应用 | 使用原 UUID | 读取原分区 | 恢复上次打开列表 |
| 删除环境 | 移除 UUID 记录 | 清除存储、HTTP 缓存与认证缓存 | 关闭页面及所属弹窗 |

清单位于 `app.getPath('userData')/profiles.json`，由 `ProfileStore` 校验并通过临时文件替换写入。清单损坏时应用显示错误并退出，避免覆盖已有数据。Chromium 自行管理 `userData` 下各持久化分区的实际目录和数据库，不依赖手工复制单个 Cookie 文件。

Chromium 的会话 Cookie 没有到期日期，单靠持久化分区不能保证应用重启后恢复。主进程按环境将这些 Cookie 保存在 `session-cookies/{id}.bin`，使用 Electron `safeStorage` 的系统加密能力，打开原环境时再恢复到它自己的 Session。Windows 使用 DPAPI，密钥与当前系统用户关联。删除环境也移除其快照；快照不用于新建环境。若安全存储不可用或 Linux 只有明文后端，应用拒绝保存明文快照并显示持久化提示。

sessionStorage 随同快照加密保存。主进程在关闭主标签页、退出前读取该页各网站来源的会话存储，页面离开时也提交检查点；专用沙箱预加载脚本在文档启动时通过私有 IPC 请求恢复数据。每次重新打开主标签页，按网站来源生成一份待恢复清单；一个来源仅可消费一次，且只在当前 sessionStorage 为空时填入。消费后，后续刷新或导航不会把网站已主动清除的临时值再次补回。关闭后再次打开仍按继续使用已有环境的约定恢复最近检查点。

弹窗不消费主标签页的待恢复清单，也不能写入它的检查点。弹窗的 sessionStorage 由 Chromium 管理：保留 opener 的窗口按原生规则获得初始副本，`noopener` 窗口保持自己的独立存储。主进程用实际发送方 WebContents、Session 和框架 URL 验证环境及网站来源，网页没有可调用的 IPC 对象。

卡住或消失的页面使用最近检查点，避免阻塞退出。无原生安全存储时只保留内存检查点用于同次运行中的关闭重开。快照属于尽力保存的页面状态；不能保证捕获网站所有 `pagehide` 清理逻辑执行后的最终状态。

启动恢复与新建、打开、关闭、导航等管理操作使用同一串行队列。恢复中的视图先完成会话准备并发起初始加载，之后才执行用户已提交的导航，避免异步启动恢复覆盖用户选择的网址。

`QIYE_DATA_DIR` 可覆盖整个用户数据目录，方便本地开发及集成测试；默认 Windows 路径是 `%APPDATA%\栖页`。账号密码没有专门的清单字段。网站自身保存的数据和用户填写的备注仍可能包含敏感信息，应保护整个目录。

## 网页权限

远程网页没有 Node.js、管理界面预加载脚本或环境管理 IPC 权限。用于恢复 sessionStorage 的独立预加载脚本不暴露对象给网站。所有网页保持 `contextIsolation`、`sandbox` 和 `webSecurity`，主页面导航仅允许 HTTP / HTTPS，保留 Chromium 默认证书校验。

网站申请摄像头/麦克风、通知或读取剪贴板时，显示当前环境和网站来源，交由用户决定；下载通过保存文件对话框选择位置。管理界面的 IPC 校验发送窗口和主框架，防止网站调用管理能力。

## 浏览器标识

Electron 默认会把应用名写入 User-Agent 产品字段。0.1.1 在创建 Session 和网页视图之前，将其中的中文应用产品名替换为 ASCII `Qiye/实际应用版本`；界面名称和用户数据目录仍为「栖页」。系统描述、Chromium 与 Electron 版本来自当前运行时，Client Hints 仍由 Chromium 原生生成，不硬编码其他浏览器或系统的版本，也不隐藏 Electron 标识。

这一修改修复了非 ASCII User-Agent 引发的网站编码兼容问题。它不能证明平台接受 Electron 客户端，也不能据此认定抖音「操作频繁」已经解决。

## 验证范围

`tests/store.test.js` 验证清单操作及磁盘持久化。`tests/isolation.cjs` 使用 Playwright 启动真实 Electron，在环回地址提供测试页，操作两个独立环境并检查 Cookie、localStorage、IndexedDB、Cache Storage、Service Worker 与 HTTP 缓存。它还检查改名、关闭重开、应用重启、同环境弹窗及删除后的行为。

`tests/login-compatibility.cjs` 验证主页面、异源 iframe、Service Worker 和弹窗的浏览器标识，使用一次性本地登录挑战验证弹窗不会重放主页面旧值，并检查网站清空临时存储后的导航和主页面关闭重开行为。

这些测试不登录抖音，也不模拟平台的扫码、验证码或登录有效期。Windows 工作流负责原生环境下执行测试并生成安装包；发布前仍需人工检查真实平台及安装程序。修复验证与历史发布检查分别记录在 [验证记录](validation.md)。
