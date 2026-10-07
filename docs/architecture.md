# 架构与环境生命周期

## 环境与会话

桌面壳使用 Electron，管理界面使用本地 HTML / CSS / JavaScript。主进程负责环境清单、网页视图与会话；管理界面只能通过预加载脚本中限定的 IPC 方法调用这些操作。

每个环境创建随机 UUID，使用 `session.fromPartition("persist:account-" + id)`。UUID 是会话身份，名称、备注和颜色仅是展示信息。每个网页视图明确绑定自己的 Session，网站弹窗也继承同一 Session。

这些分区隔离 Cookie、HTTP 缓存、localStorage、IndexedDB、Cache Storage 和 Service Worker 等浏览器数据。sessionStorage 也按环境与网站来源隔离，并在关闭重开时恢复。标签页切换只改变显示中的视图，其他已打开环境继续运行。一个环境内的网站页面和登录弹窗使用同一环境的会话，以维持正常登录流程。

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

sessionStorage 随同快照加密保存。主进程在关页、退出前读取各网站来源的会话存储，页面离开时也提交检查点；专用沙箱预加载脚本在文档启动时通过私有 IPC 请求恢复数据。主进程用实际发送方 Session 和框架 URL 验证环境及网站来源，网站只能取得自己的数据，网页没有可调用的 IPC 对象。卡住或消失的页面使用最近检查点，避免阻塞退出。无原生安全存储时只保留内存检查点用于同次运行中的关闭重开。

`QIYE_DATA_DIR` 可覆盖整个用户数据目录，方便本地开发及集成测试；默认 Windows 路径是 `%APPDATA%\栖页`。账号密码没有专门的清单字段。网站自身保存的数据和用户填写的备注仍可能包含敏感信息，应保护整个目录。

## 网页权限

远程网页没有 Node.js、管理界面预加载脚本或环境管理 IPC 权限。用于恢复 sessionStorage 的独立预加载脚本不暴露对象给网站。所有网页保持 `contextIsolation`、`sandbox` 和 `webSecurity`，主页面导航仅允许 HTTP / HTTPS，保留 Chromium 默认证书校验。

网站申请摄像头/麦克风、通知或读取剪贴板时，显示当前环境和网站来源，交由用户决定；下载通过保存文件对话框选择位置。管理界面的 IPC 校验发送窗口和主框架，防止网站调用管理能力。

## 验证范围

`tests/store.test.js` 验证清单操作及磁盘持久化。`tests/isolation.cjs` 使用 Playwright 启动真实 Electron，在环回地址提供测试页，操作两个独立环境并检查 Cookie、localStorage、IndexedDB、Cache Storage、Service Worker 与 HTTP 缓存。它还检查改名、关闭重开、应用重启、同环境弹窗及删除后的行为。

这些测试不登录抖音，也不模拟平台的扫码、验证码或登录有效期。Windows 工作流负责原生环境下执行测试并生成安装包；发布前仍需人工检查真实平台及安装程序。
