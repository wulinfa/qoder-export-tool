> **如果帮到了您，请给我点个star；**
> **如果导出失败，请在issues反馈。**

简体中文 | [English](https://github.com/wulinfa/qoder-export-tool/blob/main/README_en.md)

# Qoder 会话导出工具

从**正在运行的 Qoder IDE** 中读取 Agent 会话的完整内容，导出为 **JSON / Markdown / HTML** 三件套。

与"截图存档"或"复制粘贴"不同，本工具直接对接 Qoder 的本地 ACP 服务，能够还原 UI 上看不到或已折叠的信息：**完整的思考过程（Reasoning）、工具调用的原始输入输出、文件变更的增删行数、嵌套子任务的工具树，以及用户粘贴的图片与文件附件**。

- 纯 Node.js 实现，零第三方依赖
- 完全便携：整个文件夹复制到任何位置都能运行
- 不修改、不写入 Qoder 的任何数据，只读

---

## 目录

- [它能导出什么](#它能导出什么)
- [快速开始](#快速开始)
- [使用流程](#使用流程)
- [输出产物](#输出产物)
- [目录结构](#目录结构)
- [技术原理](#技术原理)
- [稳定性设计](#稳定性设计)
- [常见问题](#常见问题)
- [隐私与合规](#隐私与合规)
- [已知限制](#已知限制)

---

## 它能导出什么

每一轮对话（一次提问 + 一次回答）会被还原为：

| 内容 | 说明 |
|------|------|
| 用户提问 | 纯文本，以及粘贴的图片、拖入的文件（内容会被落盘为附件） |
| 思考过程 | Agent 的 Reasoning 全文，含思考耗时徽标 |
| 工具链 | 每一次工具调用的名称、入参、状态、原始输出，按**父子嵌套**成树 |
| 文件变更 | 被修改文件的增删行数、字节数、APPLIED / DELETED 状态 |
| 检索记录 | 代码检索的关键词、命中文件、行号区间 |
| 待办与计划 | Plan 条目的状态（待办 / 进行中 / 已完成） |
| Agent 回答 | Markdown 原文，含代码块、表格、列表 |

导出的三种格式各有分工：

- **JSON** — 结构化全量数据，供二次处理、检索、喂给其他工具
- **Markdown** — 纯文本可读版，适合贴进笔记、Wiki、Issue
- **HTML** — 高保真还原 Qoder 会话界面的视觉效果（折叠块、文件图标、色彩标记），单文件自包含，双击即开

---

## 快速开始

### 环境要求

- Windows（依赖命名管道与 `%APPDATA%`）
- Node.js 14 及以上 —— **没有也没关系**，首次运行时可选择自动下载免安装版

### 前置条件

**Qoder IDE 必须处于运行状态**，并且打开过包含目标会话的工作区。

工具本身不存储任何会话数据，它是从 Qoder 的本地服务实时读取的；Qoder 没启动就读不到。

### 运行

双击 **`Qoder会话导出.bat`**，按提示操作即可。

也可以在命令行里直接跑：

```bat
cd /d D:\path\to\qoder-export-tool
node main.js
```

首次运行若本机没有 Node.js，批处理会询问是否下载便携版（约 30 MB，仅一次），下载到程序目录下的 `node\` 文件夹，不会污染系统环境。

---

## 使用流程

```
[0/5] 检测 Qoder 数据目录
        先查常规位置，查不到再从运行中的 Qoder 进程定位
              ↓
[准备] 提示启动 Qoder IDE，输入 1 继续
              ↓
[连接] 通过命名管道连上 Qoder 本地 ACP 服务，完成 initialize 握手
              ↓
[1/5] 枚举工作区 → 拉取全部会话列表 → 统计每个会话的对话轮次
              ↓
      打印会话表格，输入序号选择要导出的会话
              ↓
[2/5] session/load 流式加载（思考过程 / 工具调用）
[3/5] parse.js       解析重建对话结构 → JSON
[4/5] gen_markdown.js 生成 Markdown（+ 附件落盘）
[5/5] gen_html.js     生成 HTML
              ↓
      回到会话列表，可继续导出其他会话，或输入 Q 退出
```

一次运行可以连续导出多个会话；已分析过的会话数据会缓存在 `tmp\`，重复导出无需重新拉取。

---

## 输出产物

全部输出到程序目录下的 **`export\`** 文件夹。

### 文件命名

```
序号-会话名称-创建时间-修改时间-对话轮次.{json,md,html}
```

例如：

```
12-示例项目需求调研-20260614223632-20260704203601-304.json
12-示例项目需求调研-20260614223632-20260704203601-304.md
12-示例项目需求调研-20260614223632-20260704203601-304.html
示例项目需求调研_附件\     ← 图片与文件附件
```

会话名称中的非法文件名字符会被替换为下划线，长度截断至 50 字符。

### JSON 结构

```jsonc
{
  "exportedAt": "2026-08-25T10:23:45.123Z",
  "sessionId": "...",
  "sessionTitle": "...",
  "projectName": "...",
  "gmtCreate": 1780000000000,
  "gmtModified": 1780001234000,
  "totalTurns": 304,
  "stats": {                      // 全局统计
    "turnsWithQuestion": 304,
    "turnsWithThinking": 298,
    "turnsWithReply": 301,
    "turnsWithTools": 287,
    "totalToolCalls": 4123,
    "totalFileChanges": 856,
    "totalNestedCalls": 1122,
    "totalFailedCalls": 14,
    "turnsWithAttachments": 12,
    "totalImages": 9,
    "totalResources": 7
  },
  "turns": [                      // 每一轮
    {
      "requestId": "...",         // 轮次标识，同一轮的所有事件共享
      "order": 0,
      "createdAt": 1780000000000,
      "finishStatus": 0,          // 0 = 完成
      "userMessage": "用户提问全文",
      "userAttachments": [        // 图片 / 文件
        { "type": "image", "fileName": "a.png", "localPath": "C:/.../a.png", "originalExists": true },
        { "type": "resource", "fileName": "b.txt", "content": "文件完整内容", "contentLength": 1024 }
      ],
      "thinkingProcess": "思考过程全文",
      "thinkingDurationMs": 25403,
      "assistantReply": "Agent 回答全文（Markdown）",
      "plans": [ { "planType": "", "entries": [ { "status": "completed", "priority": "high", "content": "..." } ] } ],
      "toolCalls": [              // 扁平列表，含 parentToolCallId
        {
          "toolCallId": "...",
          "title": "搜索代码",
          "toolName": "search_code",
          "kind": "search",
          "input": { "regex": "..." },
          "status": "completed",
          "output": [ /* 原始输出 */ ],
          "diffSummaries": [ { "path": "...", "mode": "MODIFIED", "add": 12, "delete": 3, "addChars": 480, "delChars": 90 } ],
          "fileRefs": [ { "fileName": "a.ts", "path": "...", "startLine": 10, "endLine": 42 } ],
          "terminalOutput": "...",
          "parentToolCallId": null,
          "subRequestId": null
        }
      ],
      "toolTree": [ /* 同一份调用，按父子关系挂成树 */ ],
      "timeline": [               // 思考 / 工具 / 回答 的原始交错时序
        { "type": "thought", "text": "..." },
        { "type": "tool", "data": { /* ... */ } },
        { "type": "message", "text": "..." }
      ],
      "isSubTaskTurn": false,     // 纯子任务执行轮
      "parentTurnRequestId": null
    }
  ]
}
```

`timeline` 字段保留了事件在原始通知流中的交错顺序，HTML 导出正是靠它还原"思考一段 → 调一次工具 → 再思考 → 再回答"的真实节奏；扁平的 `toolCalls` 与树形的 `toolTree` 并存，方便不同消费场景取用。

### 附件目录

Markdown 生成时会在 `export\` 下创建 `会话名_附件\` 目录：

- **resource 类型**（用户拖入的文件）：内容已在流数据中，直接写出为文件
- **image 类型**（粘贴的图片）：流里只有 URI，若原始临时文件仍存在则复制过来；已被系统清理则只在 Markdown 中记录路径

同名附件自动追加 `_2`、`_3` 后缀，跨轮次不会互相覆盖。

---

## 目录结构

```
qoder-export-tool/
├─ Qoder会话导出.bat         启动入口（自动定位自身目录，处理 Node.js 依赖）
├─ main.js                   交互式编排器：连接、枚举、选择、调度导出
├─ lib/
│  ├─ acp.js                 ACP 客户端：数据目录发现、JSON-RPC、命名管道通信
│  └─ download_node.ps1      首次运行时下载便携版 Node.js
├─ pipeline/
│  ├─ parse.js               阶段一：通知流 → 结构化对话 JSON
│  ├─ gen_markdown.js        阶段二：JSON → Markdown（+ 附件落盘）
│  └─ gen_html.js            阶段三：JSON → 高保真单文件 HTML
├─ assets/
│  ├─ style_detail.json      从 Qoder 会话界面提取的计算样式（CDP）
│  ├─ icon-theme.local.json  Seti 文件图标主题（已本地固化）
│  └─ aicoding-seti.woff     文件图标字体（内嵌进 HTML，无需联网）
├─ export/                   导出产物目录（运行时生成）
├─ tmp/                      中间缓存目录（运行时生成，可随时清空）
└─ node/                     便携版 Node.js（可选，首次运行按需下载）
```

三个 pipeline 脚本都是独立的命令行程序，可单独调用：

```bat
node pipeline\parse.js        <stream.json> <dump.json> <out.json>
node pipeline\gen_markdown.js <in.json>     <out.md>    [附件目录名]
node pipeline\gen_html.js     <in.json>     <out.html>   [工作区根路径]
```

---

## 技术原理

### 1. 数据从哪来：ACP over Named Pipe

Qoder IDE 运行时会在本地起一个 **ACP（Agent Client Protocol）服务**，并把连接信息写进数据目录的 `.info.json`：

```
%APPDATA%\QoderCN\SharedClientCache\.info.json
├─ ipcServerPath   ← Windows 命名管道路径，如 \\.\pipe\xxxx
└─ pid             ← Qoder 进程 ID
```

### 数据目录的三级定位

工具按三级策略找到这个目录，逐级降级，**全程不依赖任何硬编码的用户路径**：

| 级别 | 方式 | 耗时 |
|------|------|------|
| 1 | 常规位置：`%APPDATA%\Qoder*\SharedClientCache` | 瞬时 |
| 2 | 进程定位：从**正在运行的 Qoder 进程命令行**里读数据目录 | 约 1 秒 |
| 3 | 仍未找到 → 提示"请确认已启动 Qoder IDE" | — |

第二级是关键的兜底。实测 Qoder 的 ACP 服务是一个独立进程，命令行形如：

```
QoderCN.exe start --workDir C:\Users\<用户>\AppData\Roaming\QoderCN\SharedClientCache --startupId ...
```

`--workDir` 后面**就是数据目录本身**。此外 Electron 子进程（gpu / utility / renderer / crashpad）普遍带 `--user-data-dir="<用户数据目录>"`，补一级 `SharedClientCache` 即可。

所有候选都要通过**内容校验**才被采纳——目录下 `.info.json` 能解析且含 `ipcServerPath`。因此**不依赖数据文件夹叫什么名字，也不依赖进程叫什么名字**，`APPDATA` 环境变量缺失同样不影响。

定位到目录后建立连接：

1. 读取 `.info.json` 取出 `ipcServerPath`
2. `net.connect()` 连上命名管道
3. 发送 `initialize` 握手（`protocolVersion: 2`，失败则回退 `1`）

通信基于 **JSON-RPC 2.0**，采用 LSP 风格的 `Content-Length` 分帧：

```
Content-Length: 78\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"chat/listAllSessions","params":{...}}
```

`lib/acp.js` 里的 `Rpc` 类维护一个字节缓冲区，按 `\r\n\r\n` 切出头部、按 `Content-Length` 取出报文体，用 `id` 匹配请求与响应；没有 `id` 的消息判为**通知（notification）**，单独收集。

### 2. 会话枚举与轮次统计

工具调用了三个 ACP 方法：

| 方法 | 用途 | 超时 |
|------|------|------|
| `chat/listAllSessions` | 列出指定工作区下的所有会话（含标题、创建/修改时间、摘要） | 60s |
| `chat/getSessionById` | 拉取会话完整记录（`chatRecords` 全量） | 180s |
| `session/load` | 流式加载会话，推送思考过程与工具调用的通知流 | 空闲 300s / 总上限 30min |

**工作区路径的反解**是一个有意思的细节。Qoder 把工作区路径编码成目录名存在 `projects\` 下，规则是**路径分隔符与冒号统一替换为 `-`**：

```
C:\repo\my-app   →   c--repo-my-app
```

问题在于目录名里的 `-` 本身也可能是路径的一部分（`my-project`）。`decodeWorkspaceCandidates()` 因此枚举全部分段组合（2^(n-1) 种，封顶 64 个组合），再逐个用 `fs.statSync()` 验证磁盘上是否真实存在，把命中的路径收进结果集。

### 3. 流式加载：session/load

`session/load` 是整个过程的核心。它不仅返回结果，还会持续推送**通知流**，每一条通知携带一个 `sessionUpdate`，类型包括：

| sessionUpdate | 含义 |
|---------------|------|
| `user_message_chunk` | 用户消息分块（text / image / resource 三种 content） |
| `agent_thought_chunk` | Agent 思考过程分块 |
| `tool_call` | 一次工具调用开始 |
| `tool_call_update` | 工具调用的状态与原始输出 |
| `agent_message_chunk` | Agent 回答分块（token 级） |
| `plan` | 计划/待办条目 |

**分轮的依据**藏在 `_meta` 里：每条通知都带 `ai-coding/request-id`，同一个 requestId 的所有事件属于同一轮对话。`_meta` 还携带了 UI 上看不到的丰富元数据：

- `ai-coding/thinking-duration-millis` — 思考耗时
- `ai-coding/tool-name` / `ai-coding/tool-kind` — 工具名与类别
- `ai-coding/parent-tool-call-id` — 父调用 ID（嵌套子任务的关键）
- `ai-coding/sub-request-id` / `ai-coding/sub-session-id` — 子会话标识
- `ai-coding/message-created-at` — 消息时间戳
- `ai-coding/tool-call-internal-status` / `error-code` / `error-message` — 失败详情

一个 304 轮的大会话会产生约 100 MB 的流数据，因此工具把它先落盘到 `tmp\`，交给下一段流水线处理，解析完成后立即删除。

### 4. 三轮流水线

#### 4.1 parse.js — 结构重建

按 requestId 把通知流分组，重新组装成"轮"：

- **用户附件**：解析 `qodercn:///agent/file?path=xxx` 与 `qodercn:///agent/attachment?path=xxx` 形式的 URI，还原出本地路径；未知 content 类型保留原始结构，不丢数据
- **思考块拼接**：思考过程是按"思维块"推送的，块边界可能在句子结束处，也可能在句子中间被硬切断。`joinThoughtChunks()` 用正则 `/[.?!:;，。！？：；、]$/` 判断前一块的结尾——是句末就插入空行分段，否则用空格连接。回答的 chunk 是 token 级推送、换行已保留在块内，直接拼接即可
- **工具结果摘要**：从 `rawOutput` 数组中分别提取三类信息——带 `diffInfo/fileStatus/path` 的**文件变更**、带 `fileName/startLine/endLine/path` 的**检索结果**、带 `content` 的**终端输出**
- **时序 timeline**：把 thought / tool / message 按通知流的原始顺序交错记录，供 HTML 还原交织 UI

#### 4.2 跨轮工具树

子任务（task）工具在 ACP 流中拥有**独立的 requestId**，意味着父调用和子调用天然分属不同的"轮"。`parse.js` 的做法是：

1. 用全局 `toolCallId → node` 映射把所有调用收拢
2. 按 `parentToolCallId` 把节点挂到父节点下，形成一片森林
3. 为每轮生成只含本轮根调用及其子孙的 `toolTree`
4. 若某轮所有调用都有父、且父在别的轮，标记为 `isSubTaskTurn`，并记录 `parentTurnRequestId`

这样在 Markdown / HTML 里，子任务的调用会正确地折叠进发起它的那一轮，而不是散落成几十个孤立的"轮"。

#### 4.3 gen_markdown.js

逐轮渲染：`## 第 N 轮` → 用户提问 → 附件 → 思考过程 → 计划表格 → 工具链（树形缩进，含状态标记、diff 摘要、检索位置、错误信息）→ Agent 回答。

子任务轮不重复展开，而是标注"已合并至第 M 轮的工具树"，并用 `<details>` 折叠可展开查看。

#### 4.4 gen_html.js

目标是尽可能还原 Qoder 会话界面的视觉。样式不是手写的，而是**用 CDP（Chrome DevTools Protocol）从真实会话界面提取的计算样式**，固化在 `assets/style_detail.json` 里（字体、字号、面板、行高、60 条 CSS 规则等）。文件图标则来自 Seti 图标主题的本地缓存 `icon-theme.local.json`。

产出的 HTML 是**单文件自包含**的：

- 图标字体 `aicoding-seti.woff` 以 base64 内嵌为 `@font-face`，不依赖网络
- 折叠/展开由几行内联 JS（`tg()` 函数）实现，无外部脚本

渲染内容包括：折叠式思考块、工具调用卡片、代码检索结果列表、文件变更行（绿增红删 + 修改数）、汇总卡、待办清单（三种状态）、嵌套子任务缩进。

列表中的文件路径会尽量缩短为项目相对路径，工作区根按两级优先级确定：**先取命令行传入的第 3 个参数**（`main.js` 调用时会把真实工作区路径传进来），**没有则从导出数据中所有绝对路径的最长公共目录前缀自动推断**。两者都不依赖硬编码路径或环境变量；确实推断不出来时原样显示完整路径。

### 5. 便携化设计

所有路径都在运行时自识别，没有任何硬编码：

- `main.js` 用 `__dirname` 定位 `export/`、`tmp/`、`pipeline/`
- 批处理用 `%~dp0` 定位自身目录并 `cd /d` 过去
- Qoder 数据目录通过 `process.env.APPDATA` 拼接

因此整个文件夹复制到 U 盘、另一台机器的任意路径，都能直接运行。

---

## 稳定性设计

几个踩过的坑，都已在代码里处理：

**连接超时不能残留。** 连接命名管道时设了 10 秒超时，但如果不清除，这条超时会在整个会话期间持续生效——用户在会话列表前停留超过 10 秒，管道就被静默销毁，后续请求报 `ERR_STREAM_DESTROYED`。修复方式是在连接成功的回调里立刻 `socket.setTimeout(0)` 并移除监听。

**流式加载要用"空闲超时"而非"固定超时"。** 大会话的加载可能持续数分钟，固定超时必然误杀。`Rpc.send()` 因此支持 `idle` 模式：每收到一条消息就重置计时器，只要对端还在推数据就不超时；同时叠加一个 30 分钟的 `hardCapMs` 总上限，防止无限等待。

**管道意外断开要立刻失败。** 监听 socket 的 `close` 事件，一旦断开就把所有挂起请求以明确错误 reject 掉，而不是让它们各自等到超时。

**不发送 exit 请求。** ACP 服务属于用户正在运行的 Qoder IDE，工具只断开自己的连接，绝不尝试关闭对方。

**中间产物缓存。** `getSessionById` 的结果缓存在 `tmp\`，重复导出或中断后续跑都能复用；`session/load` 的巨大流缓存在解析完成后立即删除，避免占用上百 MB 磁盘。

**进程定位时的中文路径编码。** Windows 中文环境下 PowerShell 默认按 GBK 输出，而 Node 侧按 UTF-8 解码——中文用户名路径会直接变成乱码，且是静默失败。因此调用前会先执行 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`。

**PowerShell 脚本不能用分号切断管道。** `[Console]::OutputEncoding=...; Get-CimInstance ... | Where-Object {...}; | ForEach-Object {...}` 会被判为语法错误——分号只能分隔开头的赋值语句，管道本身必须连成一条语句。

---

## 常见问题

**提示"未找到 Qoder 数据目录"**
已尝试常规位置和正在运行的 Qoder 进程都没找到。通常是本机没装 Qoder，或装了但从没运行过——启动一次 Qoder IDE 再试。若 Qoder 确实在运行，可能是以管理员身份启动而本工具不是（跨权限读不到进程命令行）。

**连接失败**
Qoder 没在运行。启动后按回车重试即可，工具支持无限重试。

**列表里看不到某个会话**
与 Qoder 历史面板口径一致：空会话（无任何聊天记录）会被跳过。

**导出的图片附件缺失**
图片内容本身不在流数据里，只有一个指向本地临时目录的 URI。如果系统已清理临时文件，就无法复制，Markdown 中会保留原始路径记录。

**轮次数与我手动数的不一样**
口径是"chatRecords 每条记录即一轮"。极端情况下最后一轮可能只有提问没有回答，此时以记录数为准。

**能导出别人的会话吗**
只能读取本机当前用户 Qoder 数据目录下的会话，需要 Qoder 处于运行状态。

---

## 隐私与合规

- 工具**只读**，不修改、不删除、不写入 Qoder 的任何数据
- 所有处理都在本机完成，**不联网、不上传**（唯一的网络请求是首次运行时可选的 Node.js 运行时下载）
- 导出的文件包含会话的完整原文，其中可能有代码、路径、密钥等敏感内容——公开仓库请务必用 `.gitignore` 排除 `export\` 与 `tmp\`，不要提交导出产物
- `tmp\` 下缓存着会话的完整 dump，可随时清空，不影响工具运行

---

## 已知限制

- **仅支持 Windows**（依赖命名管道与 Windows 进程查询）
- 进程定位依赖 PowerShell（Windows 7 起系统自带）。若被组策略禁用，会静默退化为只查常规位置，不会报错
- **必须运行 Qoder IDE**，无法离线读取历史数据
- 工作区根由命令行参数或数据自动推断。若会话同时涉及多棵互不相关的目录树（例如既有项目文件又有系统目录），自动推断会保守地放弃缩短，全部显示为完整路径——仅影响显示，不影响数据
- ACP 属于 Qoder 的内部协议，Qoder 版本更新可能导致字段变化

---

## 许可

仓库代码尚未指定开源许可证。

请注意：`assets/` 下的图标字体（`.woff`）与图标主题（`.json`）提取自 Qoder IDE 内置的 `aicoding-file-icons` 扩展，其授权状态独立于本项目代码，公开发布前请自行评估。
