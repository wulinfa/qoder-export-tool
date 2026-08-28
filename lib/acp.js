/**
 * lib/acp.js — Qoder ACP 客户端模块（便携化，无硬编码路径）
 *
 * 能力：
 *  - 自动发现 Qoder 数据目录（%APPDATA%/QoderCN/SharedClientCache 等）
 *  - 连接正在运行的 ACP 服务器（命名管道 + JSON-RPC/Content-Length 帧）
 *  - 枚举本机全部工作区（解码 projects/ 目录名）
 *  - chat/listAllSessions 会话列表
 *  - chat/getSessionById 会话完整记录（用于轮次统计与导出 dump）
 *  - session/load 流式加载（含思考过程/工具调用的通知流）
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------- 数据目录发现
// 三级策略，逐级降级，全程不依赖硬编码的用户路径：
//   1. 常规位置  %APPDATA%\Qoder*\SharedClientCache        （瞬时，覆盖绝大多数情况）
//   2. 进程定位  从正在运行的 Qoder 进程命令行里读 --workDir / --user-data-dir
//                （文件夹改名、数据目录被迁移到别处、APPDATA 变量缺失时依然有效）
//   3. 不存在   返回 null，由调用方给出"请启动 Qoder"的提示
function candidateDataDirs() {
  const dirs = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    dirs.push(path.join(appdata, 'QoderCN', 'SharedClientCache'));
    dirs.push(path.join(appdata, 'Qoder', 'SharedClientCache'));
  }
  return dirs;
}

function readInfo(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, '.info.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 目录下存在可解析的 .info.json 且含 ipcServerPath，才算有效数据目录 */
function isValidDataDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
  } catch {
    return false;
  }
  const info = readInfo(dir);
  return !!(info && info.ipcServerPath);
}

/**
 * 调用 PowerShell 取出符合条件的进程命令行（每行一条）。
 * 必须显式把控制台输出编码设为 UTF-8：Windows 中文环境下 PowerShell 默认按
 * GBK 输出，Node 侧按 UTF-8 解码会把中文用户名路径变成乱码。
 * @param {string} filterExpr 作用于 $_ 的 PowerShell 过滤表达式
 * @returns {string[]} 命令行数组，失败时返回空数组
 */
function psCommandLines(filterExpr) {
  // 管道必须连成一条语句：分号只能用于分隔开头的编码设置，
  // 若在 "|" 前也加分号会被 PowerShell 判为语法错误。
  const pipeline = [
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
    `| Where-Object { ${filterExpr} }`,
    "| ForEach-Object { ($_.CommandLine -replace '[\\r\\n]+',' ') }",
  ].join(' ');
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + pipeline;
  let r;
  try {
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return []; // PowerShell 不可用/被策略禁用：静默降级，不影响主流程
  }
  if (r.error || !r.stdout) return [];
  return String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 从命令行里提取 --flag 形式的值。
 * 难点：这类路径参数常常不带引号且本身可能含空格（实测 Qoder 就是如此），
 * 因此未加引号时取到下一个 " --xxx" 参数之前为止，而不是简单地按空格切分。
 */
function extractFlagValues(cmd, flag) {
  const out = [];
  if (!cmd) return out;
  const re = new RegExp('--' + flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:=|\\s+)', 'gi');
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const rest = cmd.slice(m.index + m[0].length);
    let val;
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end === -1) continue;
      val = rest.slice(1, end);
    } else {
      const stop = rest.search(/\s--/);
      val = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    }
    val = val.replace(/[/\s]+$/, '');
    if (val) out.push(val);
  }
  return out;
}

/** 多个候选同时有效时（开了多个 Qoder 实例），取 .info.json 最新的那个 */
function pickNewest(dirs) {
  const mtime = (d) => {
    try { return fs.statSync(path.join(d, '.info.json')).mtimeMs; } catch { return 0; }
  };
  return dirs.slice().sort((a, b) => mtime(b) - mtime(a))[0] || null;
}

/**
 * 第二级发现：从正在运行的 Qoder 进程命令行定位数据目录。
 * 实测 Qoder 的 ACP 服务是独立进程，命令行形如：
 *   QoderCN.exe start --workDir <数据目录> --startupId ...
 * Electron 子进程（gpu / utility / renderer / crashpad）则普遍带：
 *   --user-data-dir="<用户数据目录>"      （需再拼一级 SharedClientCache）
 * 候选一律经 isValidDataDir 校验，因此不依赖任何文件夹或进程的具体命名。
 * @returns {string|null}
 */
function findDataDirViaProcess() {
  // 先只看 Qoder 自己的进程，噪音小、速度快（约 1 秒）；
  // 一无所获再放宽到所有带 --workDir 的进程，兜底应对可执行文件改名等极端情况。
  const passes = [
    () => psCommandLines("$_.Name -match 'qoder'"),
    () => psCommandLines("$_.CommandLine -match '--workDir'"),
  ];
  const candidates = new Set();
  for (const collect of passes) {
    for (const cmd of collect()) {
      for (const p of extractFlagValues(cmd, 'workDir')) candidates.add(p);
      for (const p of extractFlagValues(cmd, 'user-data-dir')) {
        candidates.add(path.join(p, 'SharedClientCache'));
        candidates.add(p);
      }
    }
    const hits = [...candidates].filter(isValidDataDir);
    if (hits.length) return pickNewest(hits);
  }
  return null;
}

function findDataDir() {
  let stale = null; // 目录存在但 Qoder 没在运行，留着给 connect() 报更明确的错
  for (const d of candidateDataDirs()) {
    if (!fs.existsSync(d)) continue;
    if (isValidDataDir(d)) return d;
    if (!stale) stale = d;
  }
  const viaProc = findDataDirViaProcess();
  if (viaProc) return viaProc;
  return stale;
}

// ---------------------------------------------------------------- JSON-RPC 客户端
class Rpc {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.notificationCount = 0;
    // 可选：外部注入的通知回调（用于进度显示）
    this.onNotification = null;
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => { this.lastError = e; });
    // 管道意外断开（Qoder 退出/服务重启）：立刻失败所有挂起请求，
    // 给出明确提示而不是各自等到超时。
    socket.on('close', () => {
      this.closed = true;
      const err = new Error('与 Qoder 本地服务的连接已断开（Qoder 可能已退出或重启），请重新运行本工具');
      for (const p of this.pending.values()) {
        try { p.reject(err); } catch { /* ignore */ }
      }
      this.pending.clear();
    });
  }
  _onData(d) {
    this.buffer = Buffer.concat([this.buffer, d]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) return;
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + len);
      this._onMessage(body);
      // 收到任意消息即续期所有"空闲超时"型请求（流式加载期间通知持续到达，不应误判超时）
      for (const p of this.pending.values()) if (p.refresh) p.refresh();
    }
  }
  _onMessage(body) {
    let msg;
    try { msg = JSON.parse(body); } catch { return; }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } else {
      this.notifications.push(msg);
      this.notificationCount++;
      if (this.onNotification) {
        try { this.onNotification(msg); } catch { /* 回调异常不影响收流 */ }
      }
    }
  }
  /**
   * 发送 JSON-RPC 请求。
   * @param {number} timeoutMs 超时（毫秒）。默认为固定超时；
   *   opts.idle=true 时改为"空闲超时"——每收到一条消息就续期，
   *   只要对端仍在持续发数据（如流式加载的通知流）就不会超时。
   * @param {object} [opts] { idle?: boolean, hardCapMs?: number }
   *   hardCapMs：总时长上限（毫秒），与空闲续期并存，防止无限等待。
   */
  send(method, params, timeoutMs = 120000, opts = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    const body = JSON.stringify(msg);
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const entry = { resolve, reject, refresh: null };
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        fn(arg);
      };
      const armIdle = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          finish(reject, new Error(`timeout waiting for ${method}（${Math.round(timeoutMs / 1000)}s 无数据）`));
        }, timeoutMs);
      };
      if (opts.idle) {
        entry.refresh = armIdle;
        armIdle();
        if (opts.hardCapMs) {
          setTimeout(() => {
            finish(reject, new Error(`timeout waiting for ${method}（超过总时长上限 ${Math.round(opts.hardCapMs / 60000)} 分钟）`));
          }, opts.hardCapMs);
        }
      } else {
        timer = setTimeout(() => {
          finish(reject, new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      if (this.closed || this.socket.destroyed) {
        finish(reject, new Error('与 Qoder 本地服务的连接已断开（Qoder 可能已退出或重启），请重新运行本工具'));
        return;
      }
      this.socket.write(framed, 'utf8', (err) => { if (err) finish(reject, err); });
    });
  }
  destroy() { try { this.socket.destroy(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- 连接与握手
async function connectPipe(pipePath) {
  return new Promise((resolve, reject) => {
    const onTimeout = () => { socket.destroy(); reject(new Error('pipe connect timeout')); };
    const socket = net.connect(pipePath, () => {
      // 连接成功：必须清除连接阶段的空闲超时！
      // 否则这条 10s 超时会在整个会话期间持续生效——用户在交互界面
      // 停留超过 10 秒（阅读列表/思考选哪个），管道就被静默 destroy，
      // 后续请求报 ERR_STREAM_DESTROYED。
      socket.setTimeout(0);
      socket.removeListener('error', reject);
      socket.removeListener('timeout', onTimeout);
      resolve(socket);
    });
    socket.on('error', reject);
    socket.setTimeout(10000); // 仅用于连接阶段
    socket.on('timeout', onTimeout);
  });
}

/**
 * 连接 ACP 服务器并完成 initialize 握手。
 * @param {string} dataDir 数据目录（含 .info.json）
 * @returns {Promise<{rpc: Rpc, info: object}>}
 */
async function connect(dataDir) {
  const info = readInfo(dataDir);
  if (!info || !info.ipcServerPath) {
    throw new Error('ACP 服务信息缺失（.info.json 无 ipcServerPath），Qoder 可能未运行');
  }
  const socket = await connectPipe(info.ipcServerPath);
  const rpc = new Rpc(socket);
  // initialize 握手（v2 失败则回退 v1）
  try {
    await rpc.send('initialize', {
      protocolVersion: 2, clientCapabilities: {}, ideWindowType: 'editor', timestamp: Date.now(),
    }, 30000);
  } catch {
    await rpc.send('initialize', {
      protocolVersion: 1, clientCapabilities: {}, ideWindowType: 'editor', timestamp: Date.now(),
    }, 30000);
  }
  return { rpc, info };
}

// ---------------------------------------------------------------- 工作区枚举
/**
 * 解码 projects/ 下的目录名为工作区路径候选。
 * 编码规则（实测）：路径分隔符与冒号均替换为 '-'，
 * 如 d:\Data\Dev\Qoder → d--Data-Dev-Qoder。
 * 因文件夹名本身可含 '-'，需生成全部分段组合并逐一验证存在性。
 */
function decodeWorkspaceCandidates(dirName) {
  const m = /^([a-zA-Z])--(.+)$/.exec(dirName);
  if (!m) return [];
  const drive = m[1].toUpperCase();
  const segments = m[2].split('-').filter((s) => s.length > 0);
  if (!segments.length) return [];
  // 生成全部分段组合（2^(n-1)，封顶 64 组合防爆炸）
  const combos = [];
  const max = Math.min(64, Math.pow(2, Math.min(segments.length - 1, 6)));
  for (let mask = 0; mask < max; mask++) {
    const parts = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      if (mask & (1 << (i - 1))) parts[parts.length - 1] += '-' + segments[i];
      else parts.push(segments[i]);
    }
    const p = drive + ':\\' + parts.join('\\');
    if (!combos.includes(p)) combos.push(p);
    if (combos.length >= 20) break;
  }
  return combos;
}

/**
 * 枚举本机全部有效工作区路径。
 * @param {string} dataDir
 * @returns {string[]} 已在磁盘上验证存在的工作区路径
 */
function listWorkspaces(dataDir) {
  const projDir = path.join(dataDir, 'projects');
  let names = [];
  try { names = fs.readdirSync(projDir); } catch { return []; }
  const found = new Set();
  for (const name of names) {
    for (const cand of decodeWorkspaceCandidates(name)) {
      try {
        if (fs.statSync(cand).isDirectory()) found.add(cand);
      } catch { /* 不存在则跳过 */ }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- ACP 业务调用
/** 列出指定工作区的全部会话（含 sessionTitle/gmtCreate/gmtModified/摘要 chatRecords） */
async function listSessions(rpc, workspacePath) {
  const r = await rpc.send('chat/listAllSessions', { workspacePath }, 60000);
  return Array.isArray(r) ? r : [];
}

/** 获取会话完整记录（chatRecords 全量，用于轮次统计与导出 dump） */
async function getSession(rpc, sessionId) {
  return await rpc.send('chat/getSessionById', { sessionId }, 180000);
}

/**
 * 流式加载会话（含思考过程/工具调用通知流），onNotif 为进度回调。
 * 超时策略：空闲 300s 无任何数据才超时（通知流持续到达会自动续期），
 * 总时长上限 30 分钟（防极端挂起）。
 */
async function loadSessionStream(rpc, sessionId, cwd, onNotif) {
  rpc.onNotification = onNotif || null;
  // 重置通知累计（从连接建立起累计会混入其他阶段的杂散通知）
  rpc.notifications = [];
  rpc.notificationCount = 0;
  try {
    const result = await rpc.send('session/load', {
      sessionId,
      cwd: String(cwd || '').replace(/\\/g, '/'),
      mcpServers: [],
      timestamp: Date.now(),
      _meta: {},
    }, 300000, { idle: true, hardCapMs: 1800000 });
    return { result, notifications: rpc.notifications };
  } finally {
    rpc.onNotification = null;
  }
}

module.exports = {
  findDataDir, findDataDirViaProcess, isValidDataDir, readInfo, connect,
  listWorkspaces, listSessions, getSession, loadSessionStream,
  // 下面几个导出是为便于单元测试
  psCommandLines, extractFlagValues, pickNewest, candidateDataDirs,
};
