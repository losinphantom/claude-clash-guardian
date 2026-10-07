# Claude Clash Guardian

用于 Windows / Clash Verge 的独立保护插件：`jupiter-local.claude-clash-guardian`，版本 **0.2.0**。

保护插件不修改官方插件安装包，不给它指定版本，也不修改独立 Claude Code CLI 的配置。

## 使用

构建后，完全退出 VS Code，在 PowerShell 执行本仓库的 `install.ps1`，再重新打开 VS Code。安装器会把开始菜单的原 VS Code 快捷方式接入保护启动器；重开终端后，`code` 命令也会经过启动检查。启动器先锁定 Claude，保护插件装好网络保护、确认 Clash 状态后再解锁，防止 Claude 抢先激活。

状态栏显示 **Claude：允许** 或 **Claude：已锁定**；点击可查看状态，也可以在命令面板执行“Claude 保护：重新检查 Clash”。

| 系统代理 | TUN | Claude 插件 |
|---|---|---|
| 开 | 关 | 系统代理确实指向 Clash 后允许 |
| 关 | 开 | Mihomo 网卡确实启用后允许 |
| 开 | 开 | 允许 |
| 关 | 关 | 锁定，拒绝网络请求和后端启动 |
| 状态无法确认 | 状态无法确认 | 保持锁定 |

运行中关闭两个开关，会先阻断受保护的请求、停止后端，再通过官方 `extensions.allowed` 配置禁用 Claude，并**重载 VS Code 窗口**使禁用生效。重载会中断 Claude 会话，并短暂重启其他插件；隔离实机测试验证了未保存的测试文本能保留。重新开启任一有效开关后，保护插件会恢复允许。

Clash 开启时，官方插件可按正常的更新机制更新；关闭时它暂时被允许列表禁止。保护不再绑定官方插件某个版本的文件哈希。若未来插件改用不受支持的入口格式或取消后端包装接口，保护插件会保持锁定，需要适配保护插件。

## 实现与验证

- 独立插件在 Claude 加载前安装模块加载保护，针对官方插件目录里的 HTTP、HTTPS、TCP/TLS 调用进行拦截；它自己的 fetch 和 WebSocket 请求也受控。
- 开启时通过 Clash 本地 CONNECT 代理发送宿主请求，保留 TLS 证书和主机名验证；原请求的 `proxy: false` 不会绕过保护。
- 后端使用官方提供的 `claudeCode.claudeProcessWrapper` 设置，检查开关并用 Windows Job 管理 Claude 和子进程；不要求固定版本。
- 保护代码不记录请求令牌、Cookie 或正文，也不读取 Anthropic 登录凭据。
- 使用当前未修改的官方安装包里的 Axios/WebSocket 实现完成模拟令牌测试；关闭时无连接和令牌发出，开启时资料查询、令牌刷新、fetch、WebSocket 走本地代理，关闭后已有连接断开。
- 使用隔离 VS Code 配置、假 Claude 插件、假 Clash 状态和本地 HTTPS 服务，验证了首次解锁、运行中阻断、窗口重载、未保存文本保留以及重新解锁；也验证了 VS Code 默认 `http.proxySupport: override` 设置。

测试没有使用真实 Anthropic 登录令牌，也没有向 Anthropic 发测试请求。真实登录会话的界面验收尚需用户重开 VS Code 后观察。

## 范围

这是插件层保护，当前验证环境为本地 Windows、VS Code 1.140.0、官方 Claude Code 2.1.289。它不属于操作系统级网络隔离；约 100 毫秒的检测周期存在短暂切换延迟。未来 VS Code 或 Claude 更换扩展宿主／网络架构时，需要再次验证。

请通过受保护的快捷方式或 `code` 命令启动。直接运行原 `Code.exe`、自定义启动脚本等可能绕过启动前锁定。其他客户端、独立 CLI、外部浏览器不在保护范围。远程／WSL 工作区暂不支持，保护插件会保持 Claude 锁定。当前安装在默认本地 VS Code 配置中。

官方机制说明：[允许或禁用扩展](https://code.visualstudio.com/docs/enterprise/extensions)。

## 隐私模式（0.2.0）

默认开启，支持自动和手动模式。它减少部分本机元数据暴露，不保证匿名、不保证防封，也不改变账户身份或登录凭据。

- 自动模式：在 Clash 状态确认后，通过同一个本地 CONNECT 代理请求 `https://claude.ai/cdn-cgi/trace`，按响应的 `loc` 出口国家选用约定的默认时区和语言。请求不带登录令牌或 Cookie；不保存或记录返回的出口 IP。它仍是一次向真实网站发送的请求，网站能看到出口 IP。
- 自动失败、网站拒绝访问或国家不在映射表中时，使用手动兜底值，默认 UTC / en-US；状态命令显示来源及失败状态。关闭 Clash 时不探测。
- 手动模式：完全使用设置中的 IANA 时区和区域语言。例：`Asia/Tokyo` / `ja-JP`。不会强制改变你与 Claude 对话的语言。
- 国家不等于城市：美国默认纽约、加拿大多伦多、澳大利亚悉尼。可在 `extension/privacy-profile.cjs` 查看映射；需要其他城市时使用手动模式。
- 切换代理节点或修改分流规则后，执行“Claude 保护：重新识别出口区域并重载窗口”。自动识别也会在再次允许 Claude 时运行。这里识别的是 `claude.ai` 路由；`api.anthropic.com` 等其他域名可能被 Clash 分到不同出口。

VS Code 设置示例（修改后保护插件会锁定 Claude 并重载窗口）：

```json
{
  "claudeClashGuardian.privacy.enabled": true,
  "claudeClashGuardian.privacy.mode": "manual",
  "claudeClashGuardian.privacy.timeZone": "Asia/Tokyo",
  "claudeClashGuardian.privacy.locale": "ja-JP",
  "claudeClashGuardian.privacy.maskDeviceInfo": true
}
```

实现范围：Claude 扩展宿主和随附 Bun 后端的常用 `Date` / `Intl` API 使用选定时区、默认区域语言；JS `os.hostname()` 和 CPU 型号使用通用值；扩展宿主的 VS Code `machineId` 使用保存在保护插件本地状态中的稳定替代标识。UTC 时间戳保持原值，明确传入的区域语言和时区继续生效。其他扩展的对应 API 保持原样。

后端通过 Bun 的 `BUN_OPTIONS --preload` 加载保护插件自带脚本，先以无登录探针验证该入口生效再启动 Claude；不修改官方安装包。探针失败时拒绝启动。Bun 对带空格的预加载路径支持有限，帮助程序尝试 Windows 短路径；无法转换时保持阻止。

限制：真实操作系统和架构继续用于功能判断；CPU 数量、内存、文件路径、账户标识、原生命令/原生库、子进程和独立 Webview 环境没有全部匿名化。软件标识替换不等于隐藏硬件序列号。后端自身的持久化 `userID` / `machineID` 不会被本功能更改；检查的 2.1.289 后端在正常 API 请求的 `metadata.user_id` 中构造 `device_id`（来自 `userID`）、`account_uuid` 和 `session_id`，关闭遥测不会移除这组正常请求身份。语言和时区规范化不能移除已在会话、设置或文件中写入的信息；显式时区/语言选项优先。不要把本功能作为操作系统隔离或账户封禁规避保证。

插件和后端均关闭非必要流量、遥测和错误上报；正常模型请求仍然携带账户授权和任务上下文。测试使用假令牌及隔离配置；真实后端测试的预加载脚本在应用入口前退出，不运行登录会话。

## 撤销

完全退出 VS Code，再在 PowerShell 执行：

```powershell
& "$env:LOCALAPPDATA\ClaudeClashGuardian\uninstall.ps1"
```

脚本卸载保护插件，恢复它管理的 Claude 设置和允许列表条目、原快捷方式，并从用户 PATH 移除保护入口。随后重开 VS Code 和终端。官方 Claude 插件文件不需要再次修改。

## 开发与构建

需要 Windows、Python 3.10+、Node.js 24 和 .NET Framework C# 编译器。当前启动器适用于安装在 `%LOCALAPPDATA%\Programs\Microsoft VS Code` 的用户版 VS Code，默认本地配置；系统版、便携版和其他配置尚未适配。测试可用 `--code` 指定 VS Code 路径，编译器可通过 `CSC_EXE` 指定。

```powershell
python scripts/build.py
python scripts/test.py --suite basic
```

构建脚本只下载 `extension/dependency-integrity.json` 中指定的 ws / jsonc-parser 版本，并验证 SHA-512，再从源码编译两个帮助程序、生成根目录的 VSIX。构建不会安装插件或修改用户设置。依赖库许可证保留在构建输出中。没有将构建二进制、依赖目录或个人配置提交到 Git。

基础测试验证启停顺序、窗口重载请求、启动前锁定以及 JSONC 设置回滚。网络与实机测试需要临时 HTTPS 证书：

```powershell
python -m pip install -r requirements-test.txt
# 实际启动独立的 VS Code 测试窗口；不会使用默认用户配置。
python scripts/test.py --suite integration
# 可选：指定本机未修改的官方 2.1.289 入口文件，验证其中的 Axios / WebSocket。
$env:CLAUDE_EXTENSION_JS = '官方插件安装目录\extension.js'
python scripts/test.py --suite network
# 无登录测试真实 Bun 后端的预加载和元数据规范化。
$env:CLAUDE_NATIVE_EXE = '官方插件安装目录\\resources\\native-binary\\claude.exe'
python scripts/test.py --suite native
```

如果 `node` 不在 PATH 中，传入 `--node 'Node.exe 的绝对路径'`。可选的官方包测试引用当前 2.1.289 的内部导出符号，升级后需要更新测试适配；这不限制运行时保护的官方插件版本。

测试只使用假令牌、本地 CONNECT / HTTPS 服务和隔离用户数据。临时证书只对测试子进程信任，不修改系统证书库；证书、私钥和测试日志保存在被 Git 忽略的 `.test-work`。官方插件安装包及备份不包含在仓库里。

源码组织：`extension/` 为保护插件及后端帮助程序，根目录为安装、撤销及启动器，`scripts/` 为构建与测试入口，`tests/` 为隔离测试。Git 管理源码与测试；生成的安装包保留在本地。
