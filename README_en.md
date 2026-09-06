> **If helped you, pls give me a star;**
> **If not work, pls feedback issues.**

English | [简体中文](https://github.com/wulinfa/qoder-export-tool)

# Qoder Session Export Tool

Export agent conversations from a **running Qoder IDE** into **JSON / Markdown / HTML**.

Unlike screenshotting or copy-pasting, this tool talks directly to Qoder's local ACP service and recovers information that the UI hides or collapses: **complete reasoning traces, raw tool-call inputs and outputs, added/deleted line counts for file changes, nested subtask trees, and pasted images or dropped files**.

- Pure Node.js, zero third-party dependencies
- Fully portable — copy the folder anywhere and run it
- Strictly read-only: never modifies or writes Qoder's data

---

## Table of Contents

- [What It Exports](#what-it-exports)
- [Quick Start](#quick-start)
- [Usage Flow](#usage-flow)
- [Output](#output)
- [Project Layout](#project-layout)
- [How It Works](#how-it-works)
- [Reliability Notes](#reliability-notes)
- [FAQ](#faq)
- [Privacy](#privacy)
- [Known Limitations](#known-limitations)

---

## What It Exports

Every conversation turn (one question plus one answer) is reconstructed as:

| Content | Description |
|---------|-------------|
| User prompt | Plain text, plus pasted images and dropped files (saved as attachments) |
| Reasoning | Full agent thinking trace with duration badge |
| Tool chain | Every tool call's name, arguments, status and raw output, nested into a parent/child tree |
| File changes | Added/deleted line and character counts, `APPLIED` / `DELETED` status |
| Search records | Code search keywords, matching files, line ranges |
| Todos & plans | Plan entry status (pending / in progress / completed) |
| Agent reply | Raw Markdown including code blocks, tables and lists |

The three output formats serve different purposes:

- **JSON** — structured full dataset, for post-processing, search, or feeding other tools
- **Markdown** — plain-text readable version, ready for notes, wikis, or issues
- **HTML** — high-fidelity reproduction of the Qoder conversation UI (collapsible blocks, file icons, color coding), self-contained in a single file

---

## Quick Start

### Requirements

- Windows (relies on named pipes and `%APPDATA%`)
- Node.js 14+ — **optional**; the tool can download a portable build on first run

### Prerequisites

**Qoder IDE must be running**, with the workspace containing your target session opened.

The tool stores no conversation data itself. It reads live from Qoder's local service, so if Qoder isn't running, there is nothing to read.

### Run

Double-click **`Qoder会话导出.bat`** and follow the prompts.

Or run it from the command line:

```bat
cd /d D:\path\to\qoder-export-tool
node main.js
```

On first run, if Node.js is not installed, the batch file offers to download a portable build (~30 MB, once) into the tool's `node\` folder. Nothing is installed system-wide.

---

## Usage Flow

```
[0/5] Locate Qoder data directory
        try the usual location, else find it from the running Qoder process
              |
[setup] Prompt to start Qoder IDE, type 1 to continue
              |
[conn]  Connect to Qoder's local ACP service over a named pipe, initialize handshake
              |
[1/5] Enumerate workspaces -> fetch all sessions -> count turns per session
              |
        Print the session table, type a number to select one
              |
[2/5] session/load streams the session (reasoning + tool calls)
[3/5] parse.js         rebuilds the conversation structure -> JSON
[4/5] gen_markdown.js  generates Markdown (+ writes attachments)
[5/5] gen_html.js      generates HTML
              |
        Return to the session list, export another one, or type Q to quit
```

A single run can export several sessions. Analyzed data is cached in `tmp\`, so re-exporting doesn't refetch anything.

---

## Output

Everything lands in the **`export\`** folder next to the tool.

### File Naming

```
index-session-title-created-modified-turns.{json,md,html}
```

For example:

```
12-ExampleProjectRequirementsResearch-20260614223632-20260704203601-304.json
12-ExampleProjectRequirementsResearch-20260614223632-20260704203601-304.md
12-ExampleProjectRequirementsResearch-20260614223632-20260704203601-304.html
ExampleProjectRequirementsResearch_attachments\     <- images and file attachments
```

Characters illegal in filenames are replaced with underscores; titles are truncated to 50 characters.

### JSON Structure

```jsonc
{
  "exportedAt": "2026-08-25T10:23:45.123Z",
  "sessionId": "...",
  "sessionTitle": "...",
  "projectName": "...",
  "gmtCreate": 1780000000000,
  "gmtModified": 1780001234000,
  "totalTurns": 304,
  "stats": {                      // global counters
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
  "turns": [                      // one entry per turn
    {
      "requestId": "...",         // turn id; all events of a turn share it
      "order": 0,
      "createdAt": 1780000000000,
      "finishStatus": 0,          // 0 = completed
      "userMessage": "full user prompt",
      "userAttachments": [        // images / files
        { "type": "image", "fileName": "a.png", "localPath": "C:/.../a.png", "originalExists": true },
        { "type": "resource", "fileName": "b.txt", "content": "entire file content", "contentLength": 1024 }
      ],
      "thinkingProcess": "full reasoning trace",
      "thinkingDurationMs": 25403,
      "assistantReply": "full agent reply (Markdown)",
      "plans": [ { "planType": "", "entries": [ { "status": "completed", "priority": "high", "content": "..." } ] } ],
      "toolCalls": [              // flat list, carries parentToolCallId
        {
          "toolCallId": "...",
          "title": "Search code",
          "toolName": "search_code",
          "kind": "search",
          "input": { "regex": "..." },
          "status": "completed",
          "output": [ /* raw output */ ],
          "diffSummaries": [ { "path": "...", "mode": "MODIFIED", "add": 12, "delete": 3, "addChars": 480, "delChars": 90 } ],
          "fileRefs": [ { "fileName": "a.ts", "path": "...", "startLine": 10, "endLine": 42 } ],
          "terminalOutput": "...",
          "parentToolCallId": null,
          "subRequestId": null
        }
      ],
      "toolTree": [ /* same calls, nested parent -> children */ ],
      "timeline": [               // original interleaved order of thought / tool / message
        { "type": "thought", "text": "..." },
        { "type": "tool", "data": { /* ... */ } },
        { "type": "message", "text": "..." }
      ],
      "isSubTaskTurn": false,     // pure subtask execution turn
      "parentTurnRequestId": null
    }
  ]
}
```

`timeline` preserves the interleaved order of events as they arrived, which is what lets the HTML export reproduce the real rhythm of "think a bit, call a tool, think again, then answer". The flat `toolCalls` and the nested `toolTree` coexist so consumers can pick whichever shape they need.

### Attachments

Markdown generation creates a `session-title_attachments\` directory under `export\`:

- **resource** (files dropped by the user) — content is present in the stream, written out directly
- **image** (pasted images) — the stream only carries a URI; if the original temp file still exists it is copied, otherwise the path is merely recorded in the Markdown

Duplicate filenames get `_2`, `_3` suffixes, so attachments from different turns never overwrite each other.

---

## Project Layout

```
qoder-export-tool/
├─ Qoder会话导出.bat         Entry point (self-locating; handles the Node.js dependency)
├─ main.js                   Interactive orchestrator: connect, enumerate, select, dispatch
├─ lib/
│  ├─ acp.js                 ACP client: data-dir discovery, JSON-RPC, named-pipe transport
│  └─ download_node.ps1      Downloads a portable Node.js on first run
├─ pipeline/
│  ├─ parse.js               Stage 1: notification stream -> structured JSON
│  ├─ gen_markdown.js        Stage 2: JSON -> Markdown (+ attachments)
│  └─ gen_html.js            Stage 3: JSON -> high-fidelity single-file HTML
├─ assets/
│  ├─ style_detail.json      Computed styles extracted from the Qoder UI (via CDP)
│  ├─ icon-theme.local.json  Seti file-icon theme (vendored locally)
│  └─ aicoding-seti.woff     File-icon font (embedded into the HTML, no network needed)
├─ export/                   Export output (created at runtime)
├─ tmp/                      Intermediate cache (created at runtime; safe to clear)
└─ node/                     Portable Node.js (optional, downloaded on demand)
```

The three pipeline scripts are standalone CLI programs:

```bat
node pipeline\parse.js        <stream.json> <dump.json> <out.json>
node pipeline\gen_markdown.js <in.json>     <out.md>    [attachment-dir-name]
node pipeline\gen_html.js     <in.json>     <out.html>   [workspace-root]
```

---

## How It Works

### 1. Where The Data Comes From: ACP over Named Pipe

A running Qoder IDE hosts a local **ACP (Agent Client Protocol)** service and writes its connection info to `.info.json` in the data directory:

```
%APPDATA%\QoderCN\SharedClientCache\.info.json
├─ ipcServerPath   <- Windows named pipe path, e.g. \\.\pipe\xxxx
└─ pid             <- Qoder process id
```

### Locating The Data Directory In Three Tiers

The directory is found through a three-tier strategy that falls back gracefully and **never depends on a hardcoded user path**:

| Tier | Method | Cost |
|------|--------|------|
| 1 | Usual location: `%APPDATA%\Qoder*\SharedClientCache` | instant |
| 2 | Process lookup: read the data directory from the **command line of a running Qoder process** | ~1 second |
| 3 | Still nothing -> prompt "please make sure Qoder IDE is running" | — |

Tier 2 is the important safety net. Qoder's ACP service runs as a separate process whose command line looks like:

```
QoderCN.exe start --workDir C:\Users\<user>\AppData\Roaming\QoderCN\SharedClientCache --startupId ...
```

Everything after `--workDir` **is the data directory itself**. In addition, Electron child processes (gpu / utility / renderer / crashpad) commonly carry `--user-data-dir="<user data dir>"`, which just needs `SharedClientCache` appended.

Every candidate must pass a **content check** before it is accepted: the `.info.json` underneath must parse and contain `ipcServerPath`. So the lookup **does not depend on what the data folder is named, nor on what the process is named**, and it keeps working even if the `APPDATA` environment variable is missing.

Once the directory is located, the connection is established:

1. Read `.info.json` and pull out `ipcServerPath`
2. `net.connect()` to the named pipe
3. Send an `initialize` handshake (`protocolVersion: 2`, falling back to `1` on failure)

Transport is **JSON-RPC 2.0** with LSP-style `Content-Length` framing:

```
Content-Length: 78\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"chat/listAllSessions","params":{...}}
```

The `Rpc` class in `lib/acp.js` keeps a byte buffer, splits headers on `\r\n\r\n`, slices out bodies by `Content-Length`, and matches responses to requests by `id`. Messages without an `id` are treated as **notifications** and collected separately.

### 2. Enumerating Sessions And Counting Turns

Three ACP methods are used:

| Method | Purpose | Timeout |
|--------|---------|---------|
| `chat/listAllSessions` | List all sessions in a workspace (title, created/modified, summary) | 60s |
| `chat/getSessionById` | Fetch the full session record (all `chatRecords`) | 180s |
| `session/load` | Stream the session, pushing reasoning and tool-call notifications | 300s idle / 30min cap |

**Decoding workspace paths** is a fun detail. Qoder encodes a workspace path into a directory name under `projects\`, replacing both separators and the colon with `-`:

```
C:\repo\my-app   ->   c--repo-my-app
```

The catch is that `-` can legitimately appear inside a directory name (`my-project`). So `decodeWorkspaceCandidates()` enumerates every possible segmentation (2^(n-1) combinations, capped at 64), then verifies each candidate against the filesystem with `fs.statSync()`, keeping only paths that actually exist.

### 3. Streaming: session/load

`session/load` is the heart of the process. Besides returning a result, it pushes a continuous **notification stream**, where each notification carries a `sessionUpdate`:

| sessionUpdate | Meaning |
|---------------|---------|
| `user_message_chunk` | User message chunk (content of type text / image / resource) |
| `agent_thought_chunk` | Agent reasoning chunk |
| `tool_call` | A tool call starts |
| `tool_call_update` | Tool call status and raw output |
| `agent_message_chunk` | Agent reply chunk (token level) |
| `plan` | Plan / todo entries |

**Turn grouping** hinges on `_meta`: every notification carries `ai-coding/request-id`, and all events sharing a requestId belong to the same turn. `_meta` also carries plenty of metadata the UI never shows:

- `ai-coding/thinking-duration-millis` — reasoning duration
- `ai-coding/tool-name` / `ai-coding/tool-kind` — tool identity
- `ai-coding/parent-tool-call-id` — parent call id (the key to nesting subtasks)
- `ai-coding/sub-request-id` / `ai-coding/sub-session-id` — sub-session identifiers
- `ai-coding/message-created-at` — message timestamp
- `ai-coding/tool-call-internal-status` / `error-code` / `error-message` — failure details

A large 304-turn session produces roughly 100 MB of stream data, so it is written to `tmp\` first, handed to the next pipeline stage, and deleted as soon as parsing finishes.

### 4. The Three-Stage Pipeline

#### 4.1 parse.js — Structural Rebuild

Notifications are grouped by requestId and reassembled into turns:

- **Attachments**: parses URIs of the form `qodercn:///agent/file?path=xxx` and `qodercn:///agent/attachment?path=xxx` back into local paths; unknown content types keep their raw structure so nothing is lost
- **Joining reasoning chunks**: the stream delivers reasoning in "thought blocks" whose boundaries may fall at a sentence end or mid-sentence. `joinThoughtChunks()` tests the previous block's tail against `/[.?!:;，。！？：；、]$/` — sentence end means insert a blank line to start a new paragraph, otherwise join with a space. Reply chunks arrive token by token with newlines already embedded, so they are simply concatenated
- **Tool result summaries**: three kinds of information are extracted from the `rawOutput` array — **file changes** (entries with `diffInfo`/`fileStatus`/`path`), **search hits** (entries with `fileName`/`startLine`/`endLine`/`path`), and **terminal output** (entries with `content`)
- **Timeline**: thought / tool / message events are recorded in their original interleaved order, letting the HTML reproduce the woven UI

#### 4.2 Cross-Turn Tool Tree

Subtask (`task`) tool calls carry their **own requestId** in the ACP stream, which means a parent call and its children naturally land in different turns. `parse.js` handles this by:

1. Collecting every call into a global `toolCallId -> node` map
2. Attaching nodes to their parent via `parentToolCallId`, forming a forest
3. Building a per-turn `toolTree` containing only that turn's root calls and their descendants
4. Marking a turn as `isSubTaskTurn` when all its calls have a parent living in another turn, and recording `parentTurnRequestId`

The result: in Markdown and HTML, subtask calls fold neatly into the turn that spawned them instead of scattering into dozens of orphan turns.

#### 4.3 gen_markdown.js

Renders turn by turn: `## Turn N` -> user prompt -> attachments -> reasoning -> plan table -> tool chain (tree-indented, with status markers, diff summaries, search locations, error messages) -> agent reply.

Subtask turns are not expanded again; they note "merged into the tool tree of turn M" and offer a `<details>` block for optional inspection.

#### 4.4 gen_html.js

The goal is to reproduce the Qoder conversation UI as closely as possible. The styles are not hand-written — they are **computed styles extracted from the real conversation UI over CDP (Chrome DevTools Protocol)** and vendored into `assets/style_detail.json` (fonts, sizes, panels, line heights, 60 CSS rules). File icons come from a local cache of the Seti icon theme, `icon-theme.local.json`.

The generated HTML is **self-contained in a single file**:

- The `aicoding-seti.woff` icon font is embedded as base64 in an `@font-face` rule — no network needed
- Collapse/expand is driven by a few lines of inline JS (the `tg()` function) — no external scripts

Rendered elements include collapsible reasoning blocks, tool-call cards, code search result lists, file change rows (green additions / red deletions plus modification counts), summary cards, todo lists (three states), and indented nested subtasks.

File paths in those lists are shortened to project-relative form whenever possible. The workspace root is resolved in two steps: **first the optional third CLI argument** (which `main.js` passes as the real workspace path), **otherwise the longest common directory prefix of every absolute path in the export**. Neither depends on hardcoded paths or environment variables; when inference genuinely can't decide, full paths are shown.

### 5. Portability

Every path is resolved at runtime; nothing is hardcoded:

- `main.js` uses `__dirname` to locate `export/`, `tmp/` and `pipeline/`
- The batch file uses `%~dp0` to find its own directory and `cd /d` into it
- The Qoder data directory is built from `process.env.APPDATA`

So the whole folder can be copied to a USB drive or any path on another machine and just run.

---

## Reliability Notes

A few traps, all handled in the code:

**Never leave the connect timeout armed.** A 10-second timeout guards the named-pipe connection, but if it isn't cleared it keeps applying for the entire session — pause for more than 10 seconds at the session list and the pipe is silently destroyed, producing `ERR_STREAM_DESTROYED` on the next request. The fix is to call `socket.setTimeout(0)` and remove the listeners inside the connect callback.

**Streaming needs an idle timeout, not a fixed one.** Loading a large session can take minutes, so any fixed timeout kills it prematurely. `Rpc.send()` therefore supports an `idle` mode: every inbound message resets the timer, so as long as the peer keeps pushing data it never expires. A 30-minute `hardCapMs` ceiling is layered on top to prevent infinite waiting.

**Fail fast on an unexpected disconnect.** Listening for the socket's `close` event rejects all pending requests with a clear error instead of letting each one hit its own timeout.

**Never send an exit request.** The ACP service belongs to the user's running Qoder IDE; the tool only drops its own connection and never tries to shut the peer down.

**Cache intermediate artifacts.** `getSessionById` results are cached in `tmp\`, so re-exports and interrupted runs can pick up where they left off. The huge `session/load` cache is deleted right after parsing so it doesn't hold hundreds of megabytes on disk.

**Non-ASCII paths when reading process command lines.** On a Chinese Windows, PowerShell emits GBK while Node decodes as UTF-8 — a username containing Chinese characters silently turns into garbage. The lookup therefore runs `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8` first.

**Never split a PowerShell pipeline with semicolons.** `[Console]::OutputEncoding=...; Get-CimInstance ... | Where-Object {...}; | ForEach-Object {...}` is a syntax error. The semicolon may only separate the leading assignment; the pipeline itself must stay one statement.

---

## FAQ

**"Qoder data directory not found"**
Neither the usual location nor any running Qoder process yielded one. Usually Qoder isn't installed, or was installed but never launched — start Qoder IDE once and try again. If Qoder definitely is running, it may have been launched as administrator while this tool was not (command lines are not readable across privilege levels).

**Connection failed**
Qoder isn't running. Start it and press Enter to retry — the tool retries indefinitely.

**A session is missing from the list**
Matching Qoder's own history panel, empty sessions (no chat records) are skipped.

**Some image attachments are missing**
Image bytes aren't in the stream; only a URI pointing at a local temp file is. If the OS has already cleaned up temp files, the copy can't be made — the original path is still recorded in the Markdown.

**The turn count differs from my manual count**
The rule is "one `chatRecords` entry equals one turn". In edge cases the last turn may have a question but no answer; the record count wins.

**Can I export someone else's sessions?**
No. Only sessions under the current user's Qoder data directory can be read, and only while Qoder is running.

---

## Privacy

- The tool is **read-only**: it never modifies, deletes, or writes Qoder's data
- Everything happens locally — **no network, no uploads** (the only outbound request is the optional Node.js download on first run)
- Exported files contain the full conversation text, which may include code, paths, or credentials — always exclude `export\` and `tmp\` via `.gitignore` in a public repository, and never commit exported output
- `tmp\` holds full session dumps; clear it any time without affecting the tool

---

## Known Limitations

- **Windows only** (depends on named pipes and Windows process queries)
- The process lookup relies on PowerShell (built into Windows since 7). If group policy disables it, the tool silently degrades to checking the usual location only — no error is raised
- **Qoder IDE must be running**; offline history access is not possible
- The workspace root is either passed as a CLI argument or inferred from the data. When a session touches several unrelated directory trees (project files alongside system paths, say), inference conservatively gives up and shows full paths — display only, no data impact
- ACP is an internal Qoder protocol, so field layouts may change between Qoder versions

---

## License

No open-source license has been chosen for this repository yet.

Note that the icon font (`.woff`) and icon theme (`.json`) under `assets/` were extracted from the `aicoding-file-icons` extension bundled with Qoder IDE. Their licensing is separate from this project's code — evaluate it yourself before publishing.
