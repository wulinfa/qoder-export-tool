/**
 * 从 完整对话 json 生成可读 Markdown 导出文件
 * 参数: node gen_markdown.js <in.json> <out.md> [附件目录名]
 */
const fs = require('fs');
const path = require('path');

const IN_JSON = process.argv[2] || path.join(__dirname, '导出_完整对话.json');
const OUT_MD = process.argv[3] || path.join(__dirname, '导出_完整对话.md');
const ATT_NAME = process.argv[4] || '附件';
const DIR = path.dirname(OUT_MD); // 附件等附属产物与输出 MD 同目录
const data = JSON.parse(fs.readFileSync(IN_JSON, 'utf8'));

function fmtTs(ms) {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  } catch { return String(ms); }
}

function fmtDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
}

// "深度思考·2s" 风格短耗时（UI 徽标样式，与 Qoder 一致用向上取整：25403ms → 26s）
function fmtThinkingBadge(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + (s % 60) + 's';
}

function basename(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).pop();
}

// —— 用户附件落地与渲染 ——
// 附件目录：导出目录下 附件/ （资源内容写出为文件，图片若原文件仍在则复制）
const ATTACH_DIR = path.join(DIR, ATT_NAME);
let attachInit = false;
function ensureAttachDir() {
  if (attachInit) return;
  if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });
  attachInit = true;
}
// 文件名去重：同名文件追加 _2/_3（跨轮次同名附件互不覆盖）
const attachNameUsed = new Map();
function uniqueAttachName(name) {
  const safe = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '附件';
  const n = attachNameUsed.get(safe) || 0;
  attachNameUsed.set(safe, n + 1);
  // 同名时在扩展名前插入序号：xxx.html -> xxx_2.html
  return n === 0 ? safe : safe.replace(/(\.[^.]+)$/, `_${n + 1}$1`);
}
// 将资源内容落地为附件文件，返回相对路径；失败返回 null
function saveResourceFile(att, idx) {
  ensureAttachDir();
  const name = uniqueAttachName(att.fileName || ('附件' + (idx + 1)));
  const rel = ATT_NAME + '/' + name;
  const abs = path.join(DIR, rel);
  try {
    fs.writeFileSync(abs, att.content || '', 'utf8');
    return rel;
  } catch (e) {
    return null;
  }
}
// 将图片从原路径复制到附件目录，返回相对路径；失败返回 null
function copyImageFile(att, idx) {
  if (!att.localPath || !fs.existsSync(att.localPath)) return null;
  ensureAttachDir();
  const name = uniqueAttachName(att.fileName || ('图片' + (idx + 1)));
  const rel = ATT_NAME + '/' + name;
  const abs = path.join(DIR, rel);
  try {
    fs.copyFileSync(att.localPath, abs);
    return rel;
  } catch (e) {
    return null;
  }
}
// 渲染用户附件列表
function renderUserAttachments(atts, lines) {
  const imgs = atts.filter((a) => a.type === 'image');
  const res = atts.filter((a) => a.type === 'resource');
  if (imgs.length + res.length === 0) return;
  lines.push('**📎 附件（' + (imgs.length + res.length) + '）**');
  lines.push('');
  // 图片
  for (let i = 0; i < imgs.length; i++) {
    const a = imgs[i];
    const copied = copyImageFile(a, i);
    if (copied) {
      lines.push(`![${escMd(a.fileName)}](${copied})`);
      lines.push('');
      lines.push(`> 🖼️ 图片 ${i + 1}：${escMd(a.fileName)}（${a.mimeType}）`);
    } else {
      lines.push(`> 🖼️ 图片 ${i + 1}：${escMd(a.fileName)}（${a.mimeType}）`);
      if (a.localPath) {
        lines.push(`> ⚠️ 原图位于 ${escMd(a.localPath)}，导出时已不在临时目录，无法嵌入`);
      }
    }
    lines.push('');
  }
  // 文件（资源）
  for (let i = 0; i < res.length; i++) {
    const a = res[i];
    const rel = saveResourceFile(a, i);
    const sizeKb = Math.round((a.contentLength || 0) / 1024);
    const ext = (a.fileName || '').split('.').pop().toUpperCase() || '文件';
    lines.push(`> 📄 文件 ${i + 1}：**${escMd(a.fileName)}**（${ext} · ${sizeKb} KB）${rel ? ` → [下载/查看](${rel})` : ''}`);
    if (a.localPath) {
      lines.push(`>    原路径：${escMd(a.localPath)}`);
    }
    // 内容预览（前 500 字符），折叠
    const preview = String(a.content || '').replace(/\r\n/g, '\n').slice(0, 500);
    if (preview) {
      lines.push('<details>');
      lines.push('<summary>内容预览（前 500 字符）</summary>');
      lines.push('');
      lines.push('```');
      lines.push(preview);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }
}

// 工具语义状态标签（对应 Qoder UI 的"已探索 / 已检索代码 / 已应用"等）
function toolStatusLabel(c) {
  if (c.status === 'failed') return '❌ 失败';
  const t = c.title || '';
  if (/grep|search_file|search_codebase|探索|检索|find/.test(t)) return '🔍 已检索代码';
  if (t === 'read_file' || t === 'list_dir') return '📖 已读取';
  if (/search_replace|edit_file/.test(t)) return '✏️ 已应用';
  if (t === 'create_file') return '🆕 已创建';
  if (t === 'delete_file') return '🗑️ 已删除';
  if (/run_in_terminal|get_terminal_output/.test(t)) return '💻 已执行';
  if (t === 'task') return '📋 子任务';
  if (/browser/.test(t)) return '🌐 已浏览';
  return '✅ 已完成';
}

// 变更文件摘要行："文件名 +1 -1 M 已应用"
function fmtDiff(d) {
  const name = '`' + (basename(d.path) || d.path) + '`';
  const stats = [];
  if (d.add > 0) stats.push('+' + d.add);
  if (d.delete > 0) stats.push('-' + d.delete);
  if (d.modCounts > 0) stats.push(d.modCounts + ' M');
  const st = d.fileStatus === 'APPLIED' ? '已应用'
    : d.fileStatus === 'DELETED' ? '已删除'
    : d.fileStatus;
  return '📄 ' + name + (stats.length ? ' ' + stats.join(' ') : '') + ' ' + st;
}

// 检索/读取位置行："文件名称 行-行 相对路径"
function fmtFileRef(f) {
  let range = '';
  if (f.startLine != null) {
    range = f.endLine != null && f.endLine !== f.startLine
      ? `${f.startLine}-${f.endLine}`
      : String(f.startLine);
  }
  return '🔍 `' + (f.fileName || '') + '`' + (range ? ' 行' + range : '') + ' `' + (f.path || '') + '`';
}

function escMd(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/`/g, '\\`');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 思考过程渲染：用 pre-wrap 保留所有换行与分段（Markdown 单换行不换行，会丢失分段）
function renderThinking(text) {
  return '<details>\n<summary>查看完整思考过程</summary>\n\n' +
    '<div style="white-space: pre-wrap; word-break: break-word; line-height: 1.7; color: inherit;">\n\n' +
    escapeHtml(text) +
    '\n\n</div>\n\n</details>';
}

function fmtToolInput(input) {
  if (input == null) return '_(无参数)_';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    return '```json\n' + s.slice(0, 4000) + (s.length > 4000 ? '\n...(截断)' : '') + '\n```';
  } catch { return String(input).slice(0, 4000); }
}

function fmtToolOutput(output) {
  if (output == null) return '_(无输出)_';
  let s;
  try { s = typeof output === 'string' ? output : JSON.stringify(output, null, 2); }
  catch { s = String(output); }
  if (s.length > 8000) s = s.slice(0, 8000) + '\n...(输出过长已截断)';
  return '```json\n' + s + '\n```';
}

// 树形渲染单个工具节点
function renderToolNode(c, num, lines) {
  const label = toolStatusLabel(c);
  const dur = c.thinkingMs ? ` · 思考 ${fmtDuration(c.thinkingMs)}` : '';
  lines.push(`**${num}. ${escMd(c.title || '未知工具')}** — ${label}${dur}`);
  const metaBits = [];
  if (c.subSessionId) metaBits.push(`子会话 \`${c.subSessionId.slice(0, 8)}\``);
  if (c.subRequestId) metaBits.push(`子请求 \`${c.subRequestId.slice(0, 8)}\``);
  if (c.error) metaBits.push(`错误码 ${c.errorCode || ''}`);
  if (metaBits.length) lines.push('   - ' + metaBits.join(' · '));
  // 变更文件摘要（diff）
  if (c.diffSummaries && c.diffSummaries.length) {
    for (const d of c.diffSummaries) lines.push('   - ' + fmtDiff(d));
  }
  // 检索/读取位置
  if (c.fileRefs && c.fileRefs.length) {
    for (const f of c.fileRefs.slice(0, 10)) lines.push('   - ' + fmtFileRef(f));
    if (c.fileRefs.length > 10) lines.push(`   - … 共 ${c.fileRefs.length} 处`);
  }
  // 错误详情
  if (c.error) {
    lines.push('   - ❌ ' + escMd(c.error));
  }
  // 子节点
  if (c.children && c.children.length) {
    c.children.forEach((child, i) => {
      renderToolNode(child, num + '.' + (i + 1), lines);
    });
  }
  lines.push('<details>');
  lines.push('<summary>参数 / 结果</summary>');
  lines.push('');
  lines.push('**参数**：');
  lines.push('');
  lines.push(fmtToolInput(c.input));
  lines.push('');
  lines.push('**结果**：');
  lines.push('');
  if (c.terminalOutput) {
    lines.push('```text');
    lines.push(c.terminalOutput.slice(0, 8000) + (c.terminalOutput.length > 8000 ? '\n...(输出过长已截断)' : ''));
    lines.push('```');
  } else {
    lines.push(fmtToolOutput(c.output));
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

// 渲染工具树（递归）
function renderToolNodes(nodes, numPrefix, lines) {
  nodes.forEach((node, i) => {
    const num = numPrefix ? numPrefix + '.' + (i + 1) : String(i + 1);
    renderToolNode(node, num, lines);
  });
}

const lines = [];
lines.push(`# 会话完整导出：${data.sessionTitle}`);
lines.push('');
lines.push('> 导出时间：' + new Date(data.exportedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }));
lines.push(`> 会话 ID：\`${data.sessionId}\``);
lines.push(`> 项目：${data.projectName || '-'}`);
lines.push(`> 会话创建：${fmtTs(data.gmtCreate)}`);
lines.push(`> 最后修改：${fmtTs(data.gmtModified)}`);
lines.push('');
lines.push('## 统计概览');
lines.push('');
lines.push('| 指标 | 数值 |');
lines.push('|---|---|');
lines.push(`| 总轮次 | ${data.totalTurns} |`);
lines.push(`| 含用户提问 | ${data.stats.turnsWithQuestion} |`);
lines.push(`| 含思考过程 | ${data.stats.turnsWithThinking} |`);
lines.push(`| 含 Agent 回答 | ${data.stats.turnsWithReply} |`);
lines.push(`| 含工具调用 | ${data.stats.turnsWithTools} |`);
lines.push(`| 工具调用总数 | ${data.stats.totalToolCalls} |`);
if (data.stats.totalFileChanges) lines.push(`| 变更文件操作 | ${data.stats.totalFileChanges} |`);
if (data.stats.totalNestedCalls) lines.push(`| 嵌套子调用 | ${data.stats.totalNestedCalls} |`);
if (data.stats.totalFailedCalls) lines.push(`| 失败调用 | ${data.stats.totalFailedCalls} |`);
if (data.stats.turnsWithAttachments) lines.push(`| 含附件提问 | ${data.stats.turnsWithAttachments}（图片 ${data.stats.totalImages} · 文件 ${data.stats.totalResources}） |`);
lines.push('');
lines.push('---');
lines.push('');

// 树节点统计与 requestId → 轮次号 索引
function countTree(nodes) {
  return nodes.reduce((a, n) => a + 1 + countTree(n.children || []), 0);
}
const reqToNo = new Map();
data.turns.forEach((t, i) => reqToNo.set(t.requestId, i + 1));

let turnNo = 0;
for (const t of data.turns) {
  turnNo++;
  const isInternal = t.requestId && !data.turns.some((x, i) => i !== turnNo - 1 && x.requestId === t.requestId) && false; // placeholder
  lines.push(`## 第 ${turnNo} 轮`);
  lines.push('');
  lines.push(`- **时间**：${fmtTs(t.createdAt || t.gmtCreate)}`);
  lines.push(`- **requestId**：\`${t.requestId}\``);
  lines.push(`- **状态**：${t.finishStatus == null ? '-' : t.finishStatus === 0 ? '完成' : '进行中/中断'}`);
  lines.push('');

  // 用户问题
  if (t.userMessage) {
    lines.push('### 👤 用户提问');
    lines.push('');
    lines.push('> ' + t.userMessage.split('\n').join('\n> '));
    lines.push('');
  } else if (t.userAttachments && t.userAttachments.length > 0) {
    // 理论上不会出现：本轮无文本但有附件（ACP 流中每轮都有 text 块）
    lines.push('### 👤 用户提问（纯附件消息）');
    lines.push('');
  }

  // 用户附件（图片/文件）
  if (t.userAttachments && t.userAttachments.length > 0) {
    renderUserAttachments(t.userAttachments, lines);
  }

  // 思考过程
  if (t.thinkingProcess) {
    lines.push('### 🧠 思考过程（Reasoning）');
    lines.push('');
    if (t.thinkingDurationMs) {
      lines.push(`> **深度思考·${fmtThinkingBadge(t.thinkingDurationMs)}** · 思考耗时 ${fmtDuration(t.thinkingDurationMs)}`);
    } else {
      lines.push('> 思考过程（未记录耗时）');
    }
    lines.push('');
    lines.push(renderThinking(t.thinkingProcess));
    lines.push('');
  }

  // 计划
  if (t.plans && t.plans.length > 0) {
    for (const p of t.plans) {
      if (!p.entries || p.entries.length === 0) continue;
      lines.push('### 📋 计划' + (p.planType ? `（${p.planType}）` : ''));
      lines.push('');
      lines.push('| # | 状态 | 优先级 | 内容 |');
      lines.push('|---|------|--------|------|');
      p.entries.forEach((e, i) => {
        lines.push(`| ${i + 1} | ${e.status || ''} | ${e.priority || ''} | ${escMd(e.content || '')} |`);
      });
      lines.push('');
    }
  }

  // 工具调用（树形层级渲染，父子跨轮挂载）
  if (t.toolCalls && t.toolCalls.length > 0) {
    if (t.isSubTaskTurn) {
      // 纯子任务执行轮：调用已挂到父轮工具树
      const parentNo = t.parentTurnRequestId ? reqToNo.get(t.parentTurnRequestId) : null;
      lines.push('### 🔧 工具链（子任务执行轮）');
      lines.push('');
      lines.push(`> 此轮为 **子任务执行轮**，共 ${t.toolCalls.length} 次调用` +
        (parentNo ? `，已合并至**第 ${parentNo} 轮**的工具树中` : '') + '。');
      lines.push('');
      const subCount = t.toolCalls.filter((c) => c.title === 'task').length;
      if (subCount === 0) {
        lines.push('<details>');
        lines.push(`<summary>查看该子任务内的 ${t.toolCalls.length} 次调用</summary>`);
        lines.push('');
        t.toolCalls.forEach((c, i) => {
          lines.push(`- ${toolStatusLabel(c)} **${escMd(c.title || '未知工具')}**`);
          if (c.diffSummaries && c.diffSummaries.length) {
            for (const dd of c.diffSummaries) lines.push(`  - ${fmtDiff(dd)}`);
          }
          if (c.fileRefs && c.fileRefs.length) {
            for (const f of c.fileRefs.slice(0, 5)) lines.push(`  - ${fmtFileRef(f)}`);
          }
          if (c.error) lines.push(`  - ❌ ${escMd(c.error)}`);
        });
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    } else {
      const treeTotal = countTree(t.toolTree || []);
      const nested = (t.toolTree || []).reduce((a, n) => a + countTree(n.children), 0);
      const rootCount = (t.toolTree || []).length;
      lines.push(`### 🔧 工具链（${treeTotal} 次调用${nested ? `：${rootCount} 个根调用 + ${nested} 次嵌套子调用` : ''}）`);
      lines.push('');
      renderToolNodes(t.toolTree || [], '', lines);
      lines.push('');
    }
  }

  // Agent 回答
  if (t.assistantReply) {
    lines.push('### 🤖 Agent 回答');
    lines.push('');
    lines.push(escMd(t.assistantReply));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
}

const mdPath = OUT_MD;
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
console.log('[md] saved', mdPath, (fs.statSync(mdPath).size / 1024 / 1024).toFixed(2), 'MB');
console.log('[md] lines:', lines.length);
