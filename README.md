# Pi Desk

**你的 Pi，新的工作界面。**

Pi Desk 是一个 macOS 桌面客户端，通过官方 RPC 使用本机安装的 Pi。采用 Electron、React、TypeScript；不会附带另一份 Pi 内核，也不会复制模型认证信息。

当前是 **0.2.13 开发预览**，目标是先打通真实本地工作流。代码经过类型检查与构建；依用户要求未进行界面/功能验收；历史会话命名已按用户授权调用指定模型执行。扩展与运行时行为仍需实际使用反馈。

## 已实现的首版范围

- 自动发现常见 Homebrew/npm、NVM、Volta、fnm、mise 安装路径；可手动指定 Pi、Node.js、配置和会话目录。
- 项目侧栏每组默认显示 5 个会话，“显示更多”每次增加 5 个；点击项目名称展开或收起，右侧新建会话按钮在该项目中打开输入框。搜索与归档也采用渐进展开；浏览历史不会启动 Pi。
- 每条 `edit` 工具记录可点击“查看差异”，在右侧面板查看 Pi 保存的本次修改，支持行内/并排、行号和红绿增删标记，可对照聊天逐次切换。历史记录也可查看；没有保存差异或编辑失败时按钮不可用。预览上限为 1,500 行、150,000 字符，完整记录留在 Pi 会话中；此入口不依赖项目当前 Git 状态。
- 无重复头像的紧凑消息布局，工具默认一行摘要；最终答复完成后折叠前序过程，可展开查看，显示基于消息时间记录估算的用时。
- 独立可配置的自动命名模型；新会话首轮结束后生成标题，历史批量命名支持取消和再次补齐。
- 新建和恢复真实 Pi 会话。每个活动会话独立进程，切换界面时后台继续工作。
- 最近一条已保存用户消息支持“编辑并重发”，任意已保存用户消息支持“从这里分支”。保留原图片，编辑对话不撤销项目文件；操作中扩展要求确认时在编辑框内回答。
- 新版 RPC 的增量正文、思考、工具参数和输出展示；以 `agent_settled` 判断任务结束。
- 模型列表来自当前 Pi 运行时，包含扩展动态注册的网关模型；发送前即可加载并选择模型及思考档位，按完整模型 ID A–Z 排序（友好名称作说明，搜索忽略分隔符），列表加载失败可重试。
- 思考设置明确区分原生档位、网关上游默认和数值预算；沿用 Pi 已加载的自动发现和手动覆盖映射，不虚构模型未声明的档位。每次打开设置重新读取运行时；“重新读取 Pi”不强制联网刷新目录，“查看发现详情”打开本机网关的元数据说明。
- 上下文圆环显示当前窗口占用，点击查看 tokens、容量和百分比；随每轮回复更新。压缩后用量未知时显示待更新。
- 标准扩展 select/confirm/input/editor 问答、通知、状态、文本 widget，以及填入编辑器。
- 本机注册了 `/fast` 时显示 Fast 操作；有 `/gateway-thinking` 时保留网关推理设置入口。
- 图片附件；运行中的追加输入按 steer 处理；停止会清空队列、取消问答并等待 abort。
- 会话重命名、手动压缩、命令/Skill 搜索和输入框 `/` 菜单。
- 项目文件树、文本只读预览、Git 差异。未暂存改动支持按文件、代码块或全部撤销；已暂存改动支持取消暂存（保留文件内容）。操作前确认并核对差异，发生变化或冲突时停止；未跟踪文件、链接和子模块不自动撤销。
- 中文 Markdown 强调兼容：在解析阶段支持粗体/斜体紧邻中文及标点，兼容 GFM 删除线；不改写消息内容，复制保留原文。
- 浅色、深色和系统主题；中文界面、输入法组合输入保护、本地草稿。

## 使用

1. 在 Mac 上安装并配置 Pi。首版要求可识别的 npm 安装 **Pi 0.85.1 或更新版本**，以及该 Pi 所需的 Node.js。
2. 打开 Pi Desk。它读取本机默认 `~/.pi/agent`，也支持通过设置选择其他目录。
3. 选择项目后会后台准备 Pi；需要加载项目配置时先由你选择。准备期间可以继续输入，首次发送复用该连接。未选项目时也可先点击输入框下方的“选择模型”或“思考强度”加载本机 Pi，选好后在发送时选择项目；也可直接发送，使用 Pi 当前默认设置。新会话的模型菜单先显示缓存或最近使用的模型，完整列表由本机 Pi 在后台更新；发送前校验选择。未选项目的设置连接只读取全局配置，不保存会话，不加入项目列表。首次没有缓存和历史时，仍需等待 Pi 首次加载。加载配置会等待网关和扩展，不会自行发送对话给模型。
4. 历史会话先只读打开，选择继续或发送消息后直接续写原会话，不再重复确认。历史预览栏保留不打断操作的说明：请勿同时在终端使用同一会话。应用内复用已有连接；目前不检测外部终端是否正在使用该会话。

如果项目包含未被 Pi 信任的配置，Pi Desk 会询问本次连接是否加载它。选择不会改写全局 Pi 信任设置。

本机 Pi 没有安装时，可在终端运行：

```sh
npm install -g @earendil-works/pi-coding-agent
```

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新会话 | ⌘ N |
| 搜索会话 | ⌘ K |
| 显示/隐藏侧栏 | ⌘ B |
| 设置 | ⌘ , |
| 发送消息 | Enter |
| 换行 | Shift Enter |

### 退出和后台任务

任务执行时关闭窗口会隐藏窗口并继续工作；点击 Dock 图标可返回。使用菜单“退出 Pi Desk”时，如果存在活动任务，会询问是否结束它们。不会自动重发已接受或状态不明的请求。

## 应用内更新

首次安装请下载 [最新 macOS 安装包](https://github.com/ustc21xyx/pi-desk/releases/latest)。

安装 0.2.11 或更新版本后，在 **设置 → 应用更新** 点击“检查更新”，下载完成后点击“重启并安装”。无需 Git、Node.js 或 GitHub 登录。仍在执行的任务、消息编辑、命名任务或配置加载会阻止重启；完成后再次点击即可。打开设置只读取本机版本，不自动联网或下载。

更新只读取固定公开仓库的 GitHub Releases，按 Mac 架构选择稳定版本，核对 GitHub 提供的 SHA-256、文件大小、应用身份、架构与代码签名后安装。当前使用 ad-hoc 签名，更新来源的信任依赖固定 GitHub 仓库及 HTTPS，不提供 Developer ID 身份认证或公证。不要把校验和当作独立的发布者签名。

应用必须位于 `/Applications/Pi Desk.app` 或 `~/Applications/Pi Desk.app`，且该目录可写。更新助手等待应用正常退出后替换，替换或系统启动命令失败时恢复旧版；旧版备份留在同一目录的隐藏 `.Pi Desk-update-…-previous.app`。不修改 Pi 配置或会话。安装日志在 Pi Desk 私有数据目录的 `updates/download-*/install.log`；网络或权限失败可重试，旧版本不受下载失败影响。

首次从 0.2.10 及以前升级需安装一次新版 DMG，之后使用应用内更新。安装失败的恢复针对文件替换和系统启动命令，不涵盖新版运行后发生的功能错误。

## 从 Git 更新（开发用）

仓库：<https://github.com/ustc21xyx/pi-desk>。

先从 Pi Desk 菜单退出应用，再双击仓库中的 **更新 Pi Desk.command**。也可以在仓库目录运行：

```sh
npm run update
```

脚本通过 `git pull --ff-only` 拉取当前分支的更新，安装锁定依赖、构建本机架构的应用，验证签名后安装到 `/Applications/Pi Desk.app` 并打开。旧版备份在 `release/installed-backup/`；Pi 的配置、认证和会话不变。存在未提交改动、分支分叉或应用尚未退出时会停止，不强制合并或结束任务。需要本机 Git、Node.js 和 npm。

另一台 Mac 首次使用：

```sh
git clone https://github.com/ustc21xyx/pi-desk.git
cd pi-desk
npm run update
```

Mac 上仍需单独安装并配置 Pi。Git 更新不会同步各台 Mac 的 Pi 配置或会话。

## 开发与构建

开发者推送前需安装 [Gitleaks](https://github.com/gitleaks/gitleaks)，并在克隆仓库后运行 `git config core.hooksPath .githooks`，启用完整 Git 历史的凭据扫描；缺少扫描器或发现疑似凭据时会阻止推送。普通拉取更新无需安装扫描器。不要将本机 Pi 配置、认证、会话或包含敏感内容的日志添加到仓库；扫描只是一层检查，提交前仍需审查文件内容。

```sh
npm install
npm run dev
```

构建和打包：

```sh
npm run build           # TypeScript + Electron/Vite production build
npm run pack:mac        # Current architecture .app
npm run dist:mac        # Current architecture DMG
npm run dist:mac:intel  # Intel Mac DMG
```

如果 npm 的脚本策略阻止 Electron 运行文件下载，安装包会存在但 `dist` 不存在。仅下载构建必需的 Electron 运行文件可用：

```sh
node node_modules/electron/install.js
```

产物在 `release/`。开发预览使用 ad-hoc 签名，不具备 Apple Developer ID 和公证；公开分发需要另行配置签名身份与公证。不同 Mac 的 CPU 架构需要对应的安装包，运行时最低系统要求以 Electron 为准。

### 发布新版

维护者更新版本号与 CHANGELOG、提交并推送 `main` 后，在 macOS 运行 `npm run release:mac`。需要已登录且有仓库发布权限的 GitHub CLI，以及 Gitleaks。脚本构建 Apple Silicon 和 Intel 安装包，核对签名、架构、打包文件范围及源码一致性，先上传草稿，再核对 GitHub 资产摘要后发布为最新版本。已发布版本不可覆盖，失败草稿由维护者检查后处理。

构建使用本机已按锁文件安装的依赖；干净构建环境先运行 `npm ci`。发布命令不将本机 Pi、配置、认证、会话、日志或应用备份上传，只上传两个 DMG 与校验和。

## 数据边界

| 数据 | 归属 |
| --- | --- |
| 模型、认证、MCP、Skill、扩展与 Pi 设置 | 本机 Pi |
| 会话 JSONL | Pi 自己持久化 |
| 项目收藏、主题、安装路径、置顶/归档、命名模型 | Electron `userData` 下 `preferences.json` |
| 自动/手动会话标题 | `userData/session-titles.json`，不改写 Pi JSONL |
| 未发送草稿 | Pi Desk renderer 的本地存储 |
| 图片附件 | 当前窗口内存；发送后由 Pi 处理 |

命名由独立本地 Node 辅助进程读取 Pi 的 models.json、gateway-models.json 与 auth.json，复用已有服务商地址、API Key 与网关代理，不复制凭据。主对话仍由 Pi RPC 处理。命名只支持 OpenAI Chat Completions 兼容服务商；不运行项目扩展或工具，不执行配置中的 `!` 凭据命令，不支持 OAuth-only 服务商。

设置中的命名默认关闭，需用户配置服务商与完整模型 ID；本机已按用户要求开启。命名最多发送 4,000 字的用户消息片段，不发送工具输出、图片或完整会话；自动标题不覆盖已有明确名称，手动名称优先。批量命名最多并发 2 个，连续 3 次失败暂停，已保存标题会保留，重新点击即可补齐。超大或空会话可能跳过或失败。

Pi Desk 不向 renderer 暴露模型 headers/baseUrl 或凭据，不自动加载远程图片、脚本或 HTML。终端日志可能包含扩展打印的敏感 URL，首版不把原始 stderr 转发到界面。模型返回的正文和工具输出则作为会话内容显示。

应用窗口使用隔离的 renderer 和有限的 preload API；IPC 校验来源及输入，文件预览限制在当前选择的项目，目录符号链接不展开。以上不等于 Pi 的执行沙箱；Pi 仍按自身权限和扩展规则运行。

## 扩展兼容

`resources/desk-bridge.mjs` 仅通过 Pi Desk 的启动参数加载，不安装到用户的全局扩展目录。

它目前只修复一个确定的兼容情形：`question` 工具在 RPC 下返回“非交互模式下无法提问”时，通过标准 select/input 收集用户答案，在 `tool_result` 钩子中替换结果，然后才交给 Pi 持久化和后续模型上下文。其他 question 实现不受此特例影响。

仍存在以下边界：

- `ui.custom()` 的任意终端组件不能直接显示；终端主题、美化 overlay、`/service-tier` 专用设置面板需要额外适配。
- Pi CLI 内置交互命令并非全部都是 RPC prompt 命令；会话操作使用界面的对应按钮。命令面板只列运行时实际提供的扩展/Skill/模板。
- 网关“上游默认”和 budget 通过 `/gateway-thinking` 保留原有语义，不冒充普通 off/high 档位。
- Fast 按钮是扩展命令入口；不虚构统一的 Fast 状态，结果由扩展通知说明。
- 一台 Mac 可以运行多个不同会话，但不支持 GUI 和终端安全地同时续写同一个会话，也不能接管已运行的任意终端进程。
- 运行中的 Pi 升级、独立二进制/未知版本识别、远程 Pi、Windows/WSL 尚未覆盖。
- Finder 启动应用不会自动执行用户的 shell 配置；仅在 shell 初始化脚本设置的自定义环境变量需通过正确的应用启动环境提供。常见程序路径会额外补全。
- 历史名称扫描完整 JSONL 的 session_info，正文预览仍限制大小。旧会话用时按消息时间估算；中断、错误或未完成回复不会自动收起。
- 历史文件预览上限 64 MB，显示当前分支最近 500 条消息；完整会话仍由 Pi 保留。工具显示会截断超长文本，RPC 单条记录设有大小上限。
- 普通文本预览上限 1 MB；Git diff 上限 2 MB，只显示已跟踪文件，不包含未跟踪文件内容。尚无交互终端、文件编辑、worktree 或提交/推送操作。
- 未测量大型会话、多 MCP 进程、长时间后台任务的资源开销。首版整体扩展兼容性尚未实机验收。

## 目录

```text
src/main/       Pi 安装发现、RPC 进程、会话索引、文件服务和 Electron 生命周期
src/preload/    窗口可调用的有限业务 API
src/shared/     主进程与界面的类型契约
src/renderer/   工作区、对话、设置、模型选择和文件面板
resources/     仅供 Pi Desk 使用的 Pi 扩展兼容层
build/         原创 SVG 图标及生成的 macOS 图标
scripts/       图标构建脚本
```

背景与设计取舍见 [开发前调查](../docs/pi-gui-research.md)。本项目独立实现，没有复制第三方桌面客户端代码。

一手接口参考：[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[Pi Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

中文强调解析采用 [remark-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) 及其 GFM 删除线配套扩展（固定版本 2.3.1，仅引入 parseOnly 入口）。仍使用 React Markdown 的正常渲染路径与原有 HTML 限制；没有 DOM 扫描补丁或向正文插入隐形字符。缺失闭合符号、显式转义或代码中的星号不做强制补配。
