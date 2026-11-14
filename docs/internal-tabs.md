# 环境内部标签页（0.3.17）

网页请求新窗口时，使用Electron 44.6.0的 `setWindowOpenHandler → createWindow → WebContentsView` 接管。采用浏览器已经创建的guest WebContents，保留原生opener、命名窗口、POST、referrer、noopener/noreferrer、COOP及sessionStorage语义；不先创建独立BrowserWindow再隐藏，也不把所有请求改写到原页面。

## 使用与生命周期

- 环境主标签继续显示环境名称。网页新开的子标签显示网页标题，提示中包含所属环境，沿用原标签栏及固定右侧关闭按钮。
- 普通链接/路由和表单当前页跳转保持原样。新窗口请求注册为同环境内部页面，后台标签请求不抢选中状态；后台环境或发布过程中打开的页面也不会抢走当前账号。
- 点击子标签切换，地址栏、前进/后退、刷新、Ctrl+L及Ctrl+W针对当前页面。点击左侧账号保留该环境上次选中的页面。
- 子标签关闭只释放自己的视图；当前子标签关闭后返回其仍存在的opener，否则回到环境主标签。网页window.close同样注销对应内部页面。
- 关闭环境主标签或删除环境时，关闭该环境全部页面，保留关闭环境原有的数据保存规则。软件退出时子标签随浏览器关闭；不保存并重放授权页URL、POST或临时sessionStorage。主页面按原有lastUrl及加密检查点规则恢复。
- 切换导航模块或折叠侧栏不销毁页面。发布自动化继续绑定原环境主视图；人工接管、消息跳转和官方数据后台跳转明确选择原主页面。

## 隔离与权限

每个子页绑定environment ID和独立page ID，强制使用原`persist:account-ID` Session，无新profile、无新partition、无手工Cookie复制。原profiles.json结构、启动网址/平台锁定和主页面sessionStorage恢复逻辑不变；子页检查点不会覆盖主页面，更不会把原主页面nonce灌入noopener窗口。

网站仍没有Node、管理IPC或本地文件权限，contextIsolation/sandbox/webSecurity开启。HTTP、HTTPS和创建阶段about:blank延续原有允许范围，iframe原有策略保留；本地文件和未知外部协议仍不自动放行。

兼容性采用原生guest机制，覆盖标准授权消息和关闭流程；真实第三方平台、支付、外部应用跳转及平台策略仍可能需要针对性验证，不承诺所有服务都能无条件兼容。遇到具体站点问题可用原开发者工具录制主页面流程。开发者工具仍以原环境主视图为目标，本次不重构其他业务的页面选择方式。

## 验证

本地注册、关闭、Session约束和安全配置单元检查已通过。Windows真实窗口将在100%、125%、150%缩放下检查普通导航、window.open、blank、POST、跨来源postMessage、window.close、命名复用、deferred后台链接、noreferrer、COOP、连续请求、隔离、快捷键、关闭及重启。安装包和公开文件验证完成后补充结果；合成标准网页验证不等于所有第三方平台实测。
