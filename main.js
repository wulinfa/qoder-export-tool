#!/usr/bin/env node
/**
 * main.js — Qoder 会话导出工具（交互式编排器）
 *
 * 流程：提示运行 Qoder IDE → 连接 ACP → 分析（枚举工作区/会话/轮次）
 *      → 会话列表（按创建时间排序）→ 用户选择 → 导出 JSON/MD/HTML 三件套
 *
 * 便携化：所有路径基于 __dirname 相对定位，程序文件夹整体剪切到任何位置均可运行。
 * 导出目录：程序文件夹同级 export/
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const acp = require('./lib/acp.js');

const ROOT = __dirname;                       // 程序文件夹自身位置（自识别）
const EXPORT_DIR = path.join(ROOT, 'export'); // 导出输出目录
const TMP_DIR = path.join(ROOT, 'tmp');       // 中间产物缓存目录
const PIPELINE = path.join(ROOT, 'pipeline');

// ---------------------------------------------------------------- 小工具
const p2 = (n) => String(n).padStart(2, '0');
function fmtCompact(ms) { // 20260825181055
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function fmtReadable(ms) { // 2026-08-25 18:10:55
  if (!ms) return '-';
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function safeName(s, max = 50) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, max) || '未命名会话';
}
// 按显示宽度填充（中文字符占 2 列）
function dispLen(s) { let n = 0; for (const ch of String(s)) n += ch.codePointAt(0) > 0xFF ? 2 : 1; return n; }
function pad(s, w) { const d = w - dispLen(s); return String(s) + ' '.repeat(Math.max(0, d)); }
function truncate(s, w) { let n = 0, out = ''; for (const ch of String(s)) { const c = ch.codePointAt(0) > 0xFF ? 2 : 1; if (n + c > w - 1) return out + '…'; out += ch; n += c; } return out; }
function sizeMB(p) { try { return (fs.statSync(p).size / 1024 / 1024).toFixed(2); } catch { return '?'; } }
function stepLine(text) { console.log(`  ${text}`); }

// ---------------------------------------------------------------- 行缓冲输入
// 说明：readline 的 question() 在非交互（管道）输入下会丢失已缓冲的行并可能在
// stdin 关闭后抛错。这里改为常驻 'line' 监听 + 行缓冲队列，交互与管道均稳定。
function createAsker(rl) {
  const buffered = [];
  const waiters = [];
  rl.on('line', (l) => {
    if (waiters.length) waiters.shift()(l);
    else buffered.push(l);
  });
  rl.on('close', () => { while (waiters.length) waiters.shift()(null); });
  return () => new Promise((resolve) => {
    if (buffered.length) return resolve(buffered.shift());
    if (rl.closed) return resolve(null);
    waiters.push(resolve);
  });
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const ask = createAsker(rl);
  const prompt = async (text) => {
    process.stdout.write(text);
    const a = await ask();
    return (a ?? '').trim();
  };

  console.log('============================================================');
  console.log('            Qoder 会话导出工具 (v1.0)');
  console.log('   导出 Qoder IDE 的 agent 会话为 JSON / MD / HTML');
  console.log('============================================================');
  console.log();
  console.log(`程序位置：${ROOT}`);
  console.log();

  // ---- 0. 数据目录检测 ----
  const dataDir = acp.findDataDir();
  if (!dataDir) {
    console.log('未找到 Qoder 数据目录（已尝试常规位置与正在运行的 Qoder 进程）。');
    console.log('请确认本机已安装并至少运行过一次 Qoder IDE。');
    rl.close();
    return;
  }

  // ---- 1. 提示运行 Qoder IDE ----
  console.log('使用本工具前，请先启动 Qoder IDE 并打开包含目标会话的工作区。');
  console.log('（工具通过 Qoder 的本地服务读取会话数据，需要 Qoder 正在运行）');
  console.log();
  while (true) {
    const ans = await prompt('确认 Qoder IDE 已启动后，输入 1 并回车继续（输入 Q 退出）：');
    if (/^q$/i.test(ans)) { console.log('已退出。'); rl.close(); return; }
    if (ans === '1') break;
  }
  console.log();

  // ---- 2. 连接 ACP 服务器（失败可重试） ----
  let rpc = null, info = null;
  while (!rpc) {
    process.stdout.write('  正在连接 Qoder 本地服务...');
    try {
      const conn = await acp.connect(dataDir);
      rpc = conn.rpc; info = conn.info;
      process.stdout.write('\r  已连接 Qoder 本地服务（进程 ' + info.pid + '）        \n');
    } catch (e) {
      process.stdout.write('\r  连接失败：' + e.message.slice(0, 80) + '        \n');
      const ans = await prompt('  请启动 Qoder IDE 后按回车重试（输入 Q 退出）：');
      if (/^q$/i.test(ans)) { console.log('已退出。'); rl.close(); return; }
    }
  }
  console.log();

  // ---- 3. 分析用户数据 ----
  console.log('开始分析会话数据：');
  stepLine(`数据目录：${dataDir}`);

  // 3a. 枚举工作区
  stepLine('扫描本机工作区（projects 索引）...');
  const workspaces = acp.listWorkspaces(dataDir);
  if (!workspaces.length) {
    stepLine('未发现任何工作区记录。请在 Qoder IDE 中打开工作区后再试。');
    rpc.destroy(); rl.close(); return;
  }
  stepLine(`发现 ${workspaces.length} 个工作区：`);
  for (const w of workspaces) console.log(`       - ${w}`);

  // 3b. 逐工作区获取会话列表
  const sessions = [];
  const seen = new Set();
  for (const ws of workspaces) {
    process.stdout.write(`\r  获取会话列表：${truncate(ws, 46)}`);
    try {
      const list = await acp.listSessions(rpc, ws);
      let added = 0;
      for (const s of list) {
        if (!s || !s.sessionId || seen.has(s.sessionId)) continue;
        if (!s.chatRecords || !s.chatRecords.length) continue; // 与 Qoder 历史面板一致：跳过空会话
        seen.add(s.sessionId);
        sessions.push({
          sessionId: s.sessionId,
          title: s.sessionTitle || '',
          gmtCreate: s.gmtCreate,
          gmtModified: s.gmtModified,
          projectUri: s.projectUri || ws,
          projectName: s.projectName || '',
          workspace: ws,
        });
        added++;
      }
      process.stdout.write('\r  获取会话列表：' + truncate(ws, 40).padEnd(42) + ` ${list.length} 个（新增 ${added}）\n`);
    } catch (e) {
      process.stdout.write('\r  获取会话列表失败：' + truncate(ws, 40).padEnd(42) + ' ' + e.message.slice(0, 50) + '\n');
    }
  }
  if (!sessions.length) {
    stepLine('所有工作区均无会话记录。');
    rpc.destroy(); rl.close(); return;
  }

  // 3c. 按创建时间排序（首轮对话发起时间，从早到晚）
  sessions.sort((a, b) => (a.gmtCreate || 0) - (b.gmtCreate || 0));
  sessions.forEach((s, i) => { s.index = i + 1; });

  // 3d. 统计每个会话的轮次（拉取完整 chatRecords；dump 缓存到 tmp/ 备导出复用）
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  stepLine(`统计 ${sessions.length} 个会话的对话轮次（读取完整记录）...`);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const label = `  (${i + 1}/${sessions.length}) ${truncate(s.title || s.sessionId, 34)}`;
    process.stdout.write('\r' + label.padEnd(48));
    const dumpFile = path.join(TMP_DIR, s.sessionId + '.dump.json');
    let sessionData = null;
    if (fs.existsSync(dumpFile)) {
      try { sessionData = JSON.parse(fs.readFileSync(dumpFile, 'utf8')).session; } catch { sessionData = null; }
    }
    if (!sessionData) {
      try {
        const dump = await acp.getSession(rpc, s.sessionId);
        fs.writeFileSync(dumpFile, JSON.stringify({ sessionId: s.sessionId, session: dump }));
        sessionData = dump;
      } catch (e) {
        s.turns = 0; s.turnsError = e.message.slice(0, 60);
        continue;
      }
    }
    // 轮次口径：chatRecords 每条记录即一轮（提问+思考+回答的槽位）。
    // 极端情况下提问数与回答数不一致（如最后一轮只有提问没有回答），
    // 记录数天然等于"更多一方"的次数（每条记录独立占一轮，已导出会话实测 304 条 = 304 轮）。
    const recs = sessionData?.chatRecords || [];
    const qCount = recs.filter((r) => (r.question || '').trim()).length;
    const aCount = recs.filter((r) => (r.answer || '').trim()).length;
    s.turns = Math.max(recs.length, qCount, aCount);
    // 会话名兜底：无标题时取首轮提问前缀
    if (!s.title) {
      const q = recs.map((r) => r.question || '').find(Boolean) || '';
      s.title = q.replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名会话';
    }
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  stepLine(`会话分析完成：共 ${sessions.length} 个会话`);
  console.log();

  // ---- 4. 会话列表循环（可选择多次导出） ----
  let running = true;
  while (running) {
    printTable(sessions);
    console.log();
    console.log('输入序号选择要导出的会话（输入 Q 退出）：');
    let pick = null;
    while (!pick) {
      const ans = await prompt('> ');
      if (/^q$/i.test(ans)) { pick = null; running = false; break; }
      const n = parseInt(ans, 10);
      if (Number.isInteger(n) && n >= 1 && n <= sessions.length) { pick = sessions[n - 1]; break; }
      console.log(`无效输入，请输入 1-${sessions.length} 之间的序号（或 Q 退出）。`);
    }
    if (!pick) break;

    // ---- 5. 导出 ----
    try {
      await exportSession(rl, rpc, pick);
    } catch (e) {
      console.log();
      stepLine('导出失败：' + e.message);
      console.log(e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : '');
    }

    console.log();
    const again = await prompt('按回车返回会话列表继续导出其他会话（输入 Q 退出）：');
    if (/^q$/i.test(again)) running = false;
  }

  // ---- 6. 收尾 ----
  // 注意：不发送 exit 请求——ACP 服务器属于用户正在运行的 Qoder IDE，不能关闭。
  // 仅断开自己的管道连接。
  rpc.destroy();
  console.log();
  console.log('导出文件位于：' + EXPORT_DIR);
  console.log('感谢使用，再见！');
  rl.close();
  process.exit(0);
}

// ---------------------------------------------------------------- 表格
function printTable(sessions) {
  console.log('┌────┬────────────────────────────────────┬─────────────────────┬─────────────────────┬──────┐');
  console.log('│序号│' + pad('会话名称', 36) + '│' + pad('创建时间', 21) + '│' + pad('修改时间', 21) + '│' + pad('轮次', 6) + '│');
  console.log('├────┼────────────────────────────────────┼─────────────────────┼─────────────────────┼──────┤');
  for (const s of sessions) {
    const title = pad(truncate(s.title, 34), 36);
    const c = pad(fmtReadable(s.gmtCreate), 21);
    const m = pad(fmtReadable(s.gmtModified), 21);
    const t = pad(s.turnsError ? '!' : String(s.turns), 6);
    console.log(`│${pad(String(s.index), 4)}│${title}│${c}│${m}│${t}│`);
  }
  console.log('└────┴────────────────────────────────────┴─────────────────────┴─────────────────────┴──────┘');
}

// ---------------------------------------------------------------- 导出单个会话
async function exportSession(rl, rpc, s) {
  console.log();
  console.log(`开始导出：${s.title}`);
  console.log(`  会话 ID：${s.sessionId}`);
  console.log(`  工作区：${s.workspace}`);
  console.log();

  // 输出文件名：序号-会话名称-创建时间-修改时间-对话轮次
  const base = `${s.index}-${safeName(s.title)}-${fmtCompact(s.gmtCreate)}-${fmtCompact(s.gmtModified)}-${s.turns}`;
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const jsonOut = path.join(EXPORT_DIR, base + '.json');
  const mdOut = path.join(EXPORT_DIR, base + '.md');
  const htmlOut = path.join(EXPORT_DIR, base + '.html');
  const attDirName = safeName(s.title, 24) + '_附件';
  const dumpFile = path.join(TMP_DIR, s.sessionId + '.dump.json');
  const streamFile = path.join(TMP_DIR, s.sessionId + '.stream.json');

  // [1/5] 会话记录
  process.stdout.write('  [1/5] 获取会话完整记录（chat/getSessionById）...');
  if (!fs.existsSync(dumpFile)) {
    const dump = await acp.getSession(rpc, s.sessionId);
    fs.writeFileSync(dumpFile, JSON.stringify({ sessionId: s.sessionId, session: dump }));
    process.stdout.write('完成\n');
  } else {
    process.stdout.write('完成（使用缓存）\n');
  }

  // [2/5] 流式加载
  process.stdout.write('  [2/5] 流式加载会话数据（含思考过程/工具调用）...\n');
  const t0 = Date.now();
  // loadSessionStream 开始时会重置 rpc.notificationCount，此处直接读即为本次加载的真实计数
  let lastCount = -1;
  const timer = setInterval(() => {
    const n = rpc.notificationCount;
    if (n !== lastCount) {
      lastCount = n;
      const secs = Math.floor((Date.now() - t0) / 1000);
      process.stdout.write(`\r  [2/5] 流式加载中：已接收 ${n} 条通知，耗时 ${secs}s `);
    }
  }, 500);
  let result;
  try {
    result = (await acp.loadSessionStream(rpc, s.sessionId, s.projectUri || s.workspace)).result;
  } finally {
    clearInterval(timer);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const notifications = rpc.notifications;
  process.stdout.write(`\r  [2/5] 流式加载完成：接收 ${notifications.length} 条通知（${secs}s）          \n`);
  fs.writeFileSync(streamFile, JSON.stringify({ sessionId: s.sessionId, result, notifications }));
  const streamMB = sizeMB(streamFile);

  // [3/5] 解析重建
  stepLine(`[3/5] 解析重建对话结构（流数据 ${streamMB} MB）...`);
  const r3 = runPipeline('parse.js', [streamFile, dumpFile, jsonOut]);
  if (r3 !== 0) throw new Error('解析阶段失败（parse.js 退出码 ' + r3 + '）');
  // 解析完成即可删除超大的流缓存
  try { fs.unlinkSync(streamFile); } catch { /* ignore */ }
  stepLine(`生成 JSON：${base}.json（${sizeMB(jsonOut)} MB）`);

  // [4/5] Markdown
  stepLine('[4/5] 生成 Markdown 导出...');
  const r4 = runPipeline('gen_markdown.js', [jsonOut, mdOut, attDirName]);
  if (r4 !== 0) throw new Error('Markdown 阶段失败（gen_markdown.js 退出码 ' + r4 + '）');
  stepLine(`生成 Markdown：${base}.md（${sizeMB(mdOut)} MB）`);

  // [5/5] HTML
  stepLine('[5/5] 生成 HTML 导出...');
  // 第三个参数传入工作区根，供 HTML 把绝对路径缩短成项目相对路径显示
  const r5 = runPipeline('gen_html.js', [jsonOut, htmlOut, s.workspace || '']);
  if (r5 !== 0) throw new Error('HTML 阶段失败（gen_html.js 退出码 ' + r5 + '）');
  stepLine(`生成 HTML：${base}.html（${sizeMB(htmlOut)} MB）`);

  // 汇总
  console.log();
  stepLine(`导出完成！共 3 个文件（+附件目录）：`);
  for (const f of [jsonOut, mdOut, htmlOut]) console.log(`       ${f}`);
  const attDir = path.join(EXPORT_DIR, attDirName);
  if (fs.existsSync(attDir)) console.log(`       ${attDir}${path.sep}`);
}

function runPipeline(script, args) {
  const r = spawnSync(process.execPath, [path.join(PIPELINE, script), ...args], { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

// ---------------------------------------------------------------- 入口
main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
