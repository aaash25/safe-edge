# safe-edge

复用 Windows 上已登录的 Microsoft Edge 会话，为 MCP 客户端提供标签页、页面读取、点击、键盘和文件传输工具。另附适用于 AIC JupyterLab 的实验提交、状态查询和结果下载工具。

本项目包含桥接代码与测试。运行时使用本机已安装的 Codex 桌面应用和浏览器组件；这些组件不随仓库分发。本项目为个人维护的适配工具，使用了 Codex 的内部浏览器接口，升级 Codex 后可能需要适配。

## 功能

- 标签页：`list_tabs`、`new_tab`、`navigate`、`close_tab`。
- 页面读取：`snapshot`、`snapshot_match`、`visible_dom`。
- 交互：`click`、`dom_click`、`click_at`、`fill`、`press`、`keypress`、`type_text`。
- 文件传输：`upload_files`、`upload_files_dom`、`download_file`、`download_file_dom`。
- 实验流程：`jupyter_experiment_plan`、`jupyter_experiment_start`、`jupyter_experiment_status`、`jupyter_experiment_download`。

浏览器导航限 HTTP(S)，上传限配置的工作目录或系统临时目录。桥接程序读取现有浏览器权限配置，权限请求需在 Codex 中处理。关闭标签页工具应仅在用户明确要求清理时调用。

## 运行条件

- Windows、PowerShell 7、Microsoft Edge。
- 已登录的 Codex 桌面应用，以及能在 Codex 中正常使用的 Edge 浏览器连接。
- Codex 安装目录中存在 `codex.exe`、`runtimes/cua_node` 和 Playwright MCP SDK。
- Codex 插件缓存中存在 `openai-bundled/browser/*/scripts/browser-client.mjs` 及同目录的 `browser-service.mjs`。
- Python 3，用于 ZIP 检查及测试；远程控制器也使用 Python 3。

启动脚本自动查找本机 Codex 随附的 Node 运行时；无需安装 npm 依赖。测试可使用支持当前 Codex 运行时模块的本机 Node。

## 安装

```powershell
git clone https://github.com/aaash25/safe-edge.git
cd safe-edge
```

将 [config.example.toml](config.example.toml) 中的 MCP 配置合并到自己的 Codex 配置，把示例路径改为实际克隆路径。根据需要设置工作目录，随后重新加载 MCP 连接。

```toml
[mcp_servers.safe_edge_bridge]
command = 'C:\Program Files\PowerShell\7\pwsh.exe'
args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:\path\safe-edge\start_safe_edge_bridge.ps1']
enabled = true
startup_timeout_sec = 120
tool_timeout_sec = 120

[mcp_servers.safe_edge_bridge.env]
SAFE_EDGE_WORKSPACE_ROOT = 'C:\path\workspace'
```

手动运行入口：

```powershell
& .\start_safe_edge_bridge.ps1
```

此入口通过标准输入和标准输出提供 MCP 服务，等待客户端连接属于正常行为。

## 配置

| 环境变量 | 默认值或作用 |
| --- | --- |
| `CODEX_HOME` | 当前用户的 `.codex` 目录 |
| `SAFE_EDGE_CODEX_APP_ROOT` | `%LOCALAPPDATA%\OpenAI\Codex` |
| `SAFE_EDGE_WORKSPACE_ROOT` | 本仓库目录；允许上传的工作目录 |
| `SAFE_EDGE_DOWNLOAD_ROOT` | 当前用户的 `Downloads` 目录 |
| `PYTHON` | `python`；可指定 Python 可执行文件 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 沿用启动环境；启动脚本不指定代理端口 |
| `NO_PROXY` | 启动脚本在现有设置后添加 `localhost,127.0.0.1` |

独立 MCP 模式从本机 `CODEX_HOME/auth.json` 读取登录状态，为运行时发往 `https://chatgpt.com` 的身份请求附加认证头。仓库不包含登录文件、令牌或浏览器会话数据。

也可以由已经持有运行时的 JavaScript 宿主注入 `new SafeEdgeBackend({ hostRuntime: { agent, edge } })`。此模式复用宿主身份、权限和生命周期；宿主需在导入前提供可用的本机运行时文件。

## Jupyter 实验工具

这部分保留原有 AIC 平台约束：URL 必须为 `aic.bnu.edu.cn/jupyter-forward/<instance>`，不是通用 Jupyter 客户端。服务器端需要 Linux、Bash、Python、`unzip` 和 GPU 查询命令。使用前设置下列路径：

| 环境变量 | 默认示例 |
| --- | --- |
| `SAFE_EDGE_SERVER_ALLOWED_ROOT` | `/srv/research` |
| `SAFE_EDGE_SERVER_REPO` | `<allowed-root>/project` |
| `SAFE_EDGE_SERVER_PYTHON` | `<server-repo>/.venv/bin/python` |
| `SAFE_EDGE_JUPYTER_REPO_PATH` | `project`，相对于 Jupyter 文件浏览器根目录 |

默认服务器路径仅作示例，需改为实际授权目录。源码 ZIP 必须只含一个 `route/hypotheses/<experiment>/launch_*.py` 及该实验目录内的文件。流程会记录提交意图、读取结构化状态，并核验结果 ZIP。

保留两种结果协议：通常使用 `audited_pass_v1`；历史 `v527_h219_smolvlm_mlpq_precision_pope300_hr800/launch_h219.py` 使用 `h219_precision_v1`。后者的固定任务计数与启动参数属于原有专用协议，不能直接用作其他实验的成功标准。

`experiment_cli.mjs` 提供离线计划、准备和状态恢复入口：

```powershell
node experiment_cli.mjs plan experiment.example.json
```

`plan` 只检查本地输入；`prepare` 还写入本地任务记录与 Notebook。`command` 会输出可执行的远程启动命令并记录提交状态，应在实际准备提交时使用。

## 测试

在仓库根目录运行：

```powershell
node scripts/test.mjs
```

测试会生成合成 ZIP，运行 Python 控制器测试和 JavaScript 桥接测试。浏览器使用模拟对象，控制器使用本地短进程，不连接服务器、不运行 GPU 实验。测试仍需要上述 Codex 运行时目录可被定位；控制器测试可单独运行：

```powershell
python -m unittest test_experiment_controller test_h219_controller
```

`fixtures/h204_status_snapshot.txt` 为脱敏的解析样例，ZIP 由 `fixtures/generate.py` 合成，均不代表科研结果。

## 排错

- 提示找不到运行时文件：检查 Codex 安装位置和浏览器插件缓存；非默认安装使用 `SAFE_EDGE_CODEX_APP_ROOT`、`CODEX_HOME`。
- 提示权限需要确认：在 Codex 中处理相应站点权限后重试。
- 提示标签页被 debugger 占用：关闭该标签的 DevTools，或停用占用调试连接的其他扩展后重试。
- 身份初始化网络失败：检查登录状态及启动环境中的代理设置。

## 许可证

[MIT](LICENSE)。许可证覆盖本仓库中的桥接代码、文档和测试；本机 Codex、Edge 及其运行时依各自条款使用。
