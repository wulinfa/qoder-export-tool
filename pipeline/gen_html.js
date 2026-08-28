// gen_html.js — 基于 CDP 提取的 Qoder 会话预览真实 DOM/样式生成 HTML 导出
// 数据源：完整对话 json（timeline 含 thought/tool/message 交错时序）
// 样式源：assets/style_detail.json（CDP 计算样式）、assets/aicoding-seti 图标主题
// 参数: node gen_html.js <in.json> <out.html> [工作区根路径]
//       第 3 个参数可选，传入后 HTML 中的绝对路径会相对它显示；不传则自动推断
const fs = require('fs');
const path = require('path');

const DATA = require(path.resolve(process.argv[2] || path.join(__dirname, '导出_完整对话.json')));
const OUT_HTML = process.argv[3] || path.join(__dirname, '导出_完整对话.html');
// 主题映射：读本地固化缓存（icon-theme.local.json），无外部路径依赖
// 缓存来源：Qoder aicoding-file-icons 扩展的 aicoding-seti-icon-theme.json（已精简固化）
const THEME = require(path.join(__dirname, '..', 'assets', 'icon-theme.local.json'));
const STYLE = require(path.join(__dirname, '..', 'assets', 'style_detail.json'));

// ---------------------------------------------------------------- 工具函数
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function normPath(p) { return String(p ?? '').replace(/\\/g, '/'); }

// 收集导出数据里出现过的全部绝对路径（仅用于推断工作区根）
function collectAbsPaths() {
  const set = new Set();
  const visit = (c) => {
    for (const d of (c.diffSummaries || [])) if (d.path) set.add(normPath(d.path));
    for (const f of (c.fileRefs || [])) if (f.path) set.add(normPath(f.path));
    for (const ch of (c.children || [])) visit(ch);
  };
  for (const t of (DATA.turns || [])) {
    for (const c of (t.toolTree || t.toolCalls || [])) visit(c);
  }
  return [...set].filter((p) => /^[a-zA-Z]:\//.test(p));
}

// 取所有绝对路径的最长公共目录前缀（按 / 分段对齐，不切断目录名）。
// 少于 2 个路径时不推断：单个文件的"公共前缀"就是它自己所在目录，
// 缩短后只剩文件名，反而丢了上下文。
function inferCommonRoot(paths) {
  if (paths.length < 2) return '';
  const segsList = paths.map((p) => p.split('/').filter(Boolean));
  const first = segsList[0];
  const prefix = [];
  // -1：末尾永远是文件名，不参与前缀，保证至少留下文件名
  for (let i = 0; i < first.length - 1; i++) {
    const seg = first[i];
    if (segsList.every((s) => s[i] != null && s[i].toLowerCase() === seg.toLowerCase())) prefix.push(seg);
    else break;
  }
  // 只剩盘符（如 D:）没有缩短意义，至少要盘符 + 一级目录
  return prefix.length >= 2 ? prefix.join('/') : '';
}

// 工作区根：优先取命令行第 3 个参数（main.js 传入的真实工作区路径），
// 否则从导出数据自动推断。两条路都不依赖硬编码路径或环境变量。
const WS_ROOT = (() => {
  const cli = normPath(process.argv[4] || '').replace(/\/+$/, '');
  if (cli) return cli;
  return inferCommonRoot(collectAbsPaths());
})();

// 把绝对路径缩短为相对工作区根的路径；无法缩短时原样返回（统一正斜杠）
function relPath(p) {
  if (!p) return '';
  const s = normPath(p);
  if (WS_ROOT && s.toLowerCase().startsWith(WS_ROOT.toLowerCase() + '/')) {
    return s.slice(WS_ROOT.length + 1);
  }
  return s;
}
const baseName = (p) => { const s = String(p ?? '').replace(/\\/g, '/'); return s.split('/').pop() || s; };
const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

// ---------------------------------------------------------------- Seti 文件图标
const lightDefs = {};
for (const [k, v] of Object.entries(THEME.iconDefinitions || {})) {
  if (k.endsWith('_light')) lightDefs[k.slice(0, -6)] = v;
}
const defFor = (id) => lightDefs[id] || (THEME.iconDefinitions || {})[id] || null;
function resolveDef(id) {
  if (!id) return null;
  const d = defFor(id);
  if (d && d.fontCharacter) return { char: d.fontCharacter, color: d.fontColor || '#636261' };
  return null;
}
const L = THEME.light || {};
const fileNamesMap = Object.assign({}, THEME.fileNames || {}, L.fileNames || {});
const fileExtsMap = Object.assign({}, THEME.fileExtensions || {}, L.fileExtensions || {});
const langIdsMap = Object.assign({}, THEME.languageIds || {}, L.languageIds || {});
// 常见扩展名 → languageId
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', tsx: 'typescriptreact', json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', py: 'python', rb: 'ruby',
  java: 'java', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  bat: 'bat', cmd: 'bat', ps1: 'powershell', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', sql: 'sql', vue: 'vue', txt: 'plaintext', toml: 'toml', ini: 'ini',
};
const DEFAULT_ICON = resolveDef(L.file || THEME.file || '_default') || { char: '\\E061', color: '#636261' };
function fileIcon(p) {
  const bn = baseName(p).toLowerCase();
  // fileNames 精确 / 忽略大小写匹配
  if (fileNamesMap[bn]) { const r = resolveDef(fileNamesMap[bn]); if (r) return r; }
  const ext = extOf(p);
  if (ext && fileExtsMap[ext]) { const r = resolveDef(fileExtsMap[ext]); if (r) return r; }
  const lang = EXT_LANG[ext];
  if (lang && langIdsMap[lang]) { const r = resolveDef(langIdsMap[lang]); if (r) return r; }
  return DEFAULT_ICON;
}
// Seti fontCharacter 是形如 "\E054" 的字面字符串，需转为 Unicode 私有区字符
function glyphChar(ch) {
  if (typeof ch !== 'string' || !ch) return '\uE061';
  if (ch.startsWith('\\')) {
    const cp = parseInt(ch.slice(1), 16);
    if (!isNaN(cp)) return String.fromCodePoint(cp);
  }
  return ch;
}
function iconCharHtml(p, extraCls) {
  const ic = fileIcon(p);
  return `<i class="fi${extraCls ? ' ' + extraCls : ''}" style="color:${ic.color}">${glyphChar(ic.char)}</i>`;
}
// 文件变更/汇总卡用 info 图标（蓝色 ⓘ），而非文件类型图标
function infoIconHtml(extraCls) {
  const ic = resolveDef('_info');
  const color = ic?.fontColor || '#5A90EE';
  const ch = ic?.fontCharacter || '\uE04D';
  return `<i class="fi${extraCls ? ' ' + extraCls : ''}" style="color:${color}">${glyphChar(ch)}</i>`;
}
// 检索结果用扩展名/languageId 解析（跳过 fileNames 优先，避免 readme.md 匹配到 info）
function searchIconHtml(p, extraCls) {
  const ext = extOf(p);
  if (ext && fileExtsMap[ext]) { const r = resolveDef(fileExtsMap[ext]); if (r) return `<i class="fi${extraCls ? ' ' + extraCls : ''}" style="color:${r.color}">${glyphChar(r.char)}</i>`; }
  const lang = EXT_LANG[ext];
  if (lang && langIdsMap[lang]) { const r = resolveDef(langIdsMap[lang]); if (r) return `<i class="fi${extraCls ? ' ' + extraCls : ''}" style="color:${r.color}">${glyphChar(r.char)}</i>`; }
  const ic = fileIcon(p); // fallback
  return `<i class="fi${extraCls ? ' ' + extraCls : ''}" style="color:${ic.color}">${glyphChar(ic.char)}</i>`;
}

// ---------------------------------------------------------------- SVG 符号（来自 CDP 提取的真实图标）
function extractInner(svgHtml) {
  // 取 <svg ...> 与 </svg> 之间内容，去掉外层属性
  const m = svgHtml.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  let inner = m ? m[1] : svgHtml;
  // 移除 class/style 属性，保留几何
  inner = inner.replace(/\s(?:class|style)="[^"]*"/g, '');
  return inner;
}
const SYM_MAG = extractInner(STYLE.icons.magnifier);
const SYM_THINK = extractInner(STYLE.icons.think);
const SYM_CHEV = extractInner(STYLE.icons.chevron);
const SYM_SUM = extractInner(STYLE.icons.summaryCard);

const chevSvg = (cls) => `<svg class="chev${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="currentColor"><use href="#i-chev"/></svg>`;

// ---------------------------------------------------------------- Markdown 渲染
function mdInline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/(https?:\/\/[^\s<)&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return t;
}
function mdBlock(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); out.push(`<h${h[1].length + 2}>${mdInline(h[2])}</h${h[1].length + 2}>`); i++; continue; }
    if (/^(\s*)([-*+])\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^(\s*)([-*+])\s+/.test(lines[i])) {
        items.push(`<li>${mdInline(lines[i].replace(/^(\s*)([-*+])\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${mdInline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara();
      const head = line.split('|').map(s => s.trim()).filter((s, idx, a) => !(idx === 0 && s === '') && !(idx === a.length - 1 && s === ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').map(s => s.trim()).filter((s, idx, a) => !(idx === 0 && s === '') && !(idx === a.length - 1 && s === '')));
        i++;
      }
      out.push(`<table><thead><tr>${head.map(h2 => `<th>${mdInline(h2)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

// ---------------------------------------------------------------- 组件渲染
const SEARCH_TOOLS = new Set(['grep_code', 'search_code', 'search_file', 'search_codebase', 'codebase_search', 'ripgrep']);
const READ_TOOLS = new Set(['read_file', 'list_dir', 'view_file', 'find_file']);
const EDIT_TOOLS = new Set(['search_replace', 'create_file', 'edit_file', 'delete_file', 'insert_content', 'replace_file_content', 'apply_patch', 'write_file', 'str_replace_editor']);
const CMD_TOOLS = new Set(['run_in_terminal', 'get_terminal_output', 'run_command', 'execute_command', 'run']);

function thinkSeconds(ms) {
  if (!ms) return null;
  // 真实 UI 为向上取整（验证：25403ms → 26s）
  return Math.max(1, Math.ceil(ms / 1000));
}

// 深度思考块
function renderThink(text, thinkingMs, inGroup) {
  const sec = thinkSeconds(thinkingMs);
  const title = sec ? `深度思考 · ${sec}s` : '深度思考';
  // 真实 UI：独立思考块图标 #8e8c8b，组内图标 rgba(20,20,20,.45)
  const icStyle = inGroup ? '' : ' style="color:#8e8c8b"';
  return `<div class="blk think open">
  <div class="blk-h th-h" onclick="tg(this)">
    <svg class="ic"${icStyle} viewBox="0 0 24 24" fill="currentColor"><use href="#i-think"/></svg>
    <span class="t-45">${esc(title)}</span>
    ${chevSvg()}
  </div>
  <div class="blk-c"><div class="blk-ci"><div class="th-md">${mdBlock(text)}</div></div></div>
</div>`;
}

// 已检索代码卡片
function renderSearchCard(tool) {
  const input = tool.input || {};
  const query = input.regex || input.query || input.pattern || input.search || input.keyword || '';
  let results = [];
  if (Array.isArray(tool.output)) {
    results = tool.output.filter(o => o && (o.fileName || o.path));
  } else if (Array.isArray(tool.fileRefs) && tool.fileRefs.length) {
    results = tool.fileRefs;
  }
  const count = results.length;
  const items = results.map(r => {
    const fp = r.path || r.fileName || '';
    const lines = (r.startLine || r.endLine) ? `${r.startLine ?? ''}-${r.endLine ?? ''}` : '';
    return `<div class="st-item">
  <div class="st-l">${searchIconHtml(fp)}<span class="st-fn">${esc(r.fileName || baseName(fp))}</span><span class="st-ln">${esc(lines)}</span></div>
  <div class="st-r">${esc(relPath(fp))}</div>
</div>`;
  }).join('');
  return `<div class="blk st open">
  <div class="blk-h st-h" onclick="tg(this)">
    <span class="st-n">已检索代码</span>
    <span class="st-e">${esc(query)}</span>
    <span class="st-c">${count} 个结果</span>
    ${chevSvg()}
  </div>
  <div class="blk-c"><div class="blk-ci"><div class="st-list">${items}</div></div></div>
</div>`;
}

// 已查看文件行
function renderReadLine(tool) {
  const input = tool.input || {};
  const fp = input.file_path || input.path || '';
  let ref = tool.output && tool.output[0];
  if (!ref || !ref.startLine) ref = (tool.fileRefs || [])[0] || {};
  // 与检索卡统一：input 路径优先取其 baseName；缺失时回落到 ref.fileName，
  // 但 ref.fileName 偶尔是完整路径，必须再过一遍 relPath 缩短，避免暴露长路径
  const name = baseName(fp) || relPath(ref.fileName) || '';
  const s = input.start_line ?? ref.startLine;
  const e = input.end_line ?? ref.endLine;
  const range = (s || e) ? `(${s ?? ''} - ${e ?? ''})` : '';
  return `<div class="rfline"><span class="rf-s">已查看</span><span class="rf-f">${esc(name)}</span><span class="rf-r">${esc(range)}</span></div>`;
}

// 其它工具行（命令/网络/通用）
const TOOL_LABELS = {
  run_in_terminal: '已运行命令', get_terminal_output: '已获取终端输出', run_command: '已运行命令',
  execute_command: '已运行命令', fetch_content: '已获取内容', search_web: '已搜索网络',
  search_memory: '已检索记忆', list_dir: '已查看目录', get_problems: '已检查问题',
  update_memory: '已更新记忆', search_codebase: '已检索代码', ask_user_question: '已向用户提问',
  switch_mode: '已切换模式', create_plan: '已创建计划', todo_write: '已更新待办',
  add_tasks: '已添加任务', update_tasks: '已更新任务',
};
function renderGenericToolLine(tool) {
  const label = TOOL_LABELS[tool.toolName] || `已调用 ${tool.toolName || tool.title || '工具'}`;
  let detail = '';
  const input = tool.input || {};
  const cand = input.command || input.cmd || input.url || input.query || input.question || input.prompt || input.directory || input.path || '';
  if (typeof cand === 'string') detail = cand.slice(0, 120);
  if (tool.error) detail += (detail ? ' ' : '') + `[失败: ${tool.error}]`;
  return `<div class="rfline"><span class="rf-s">${esc(label)}</span>${detail ? `<span class="rf-f">${esc(detail)}</span>` : ''}</div>`;
}

// 文件变更行（顶层）
function modeLabel(mode) {
  if (mode === 'CREATED' || mode === 'ADDED' || mode === 'A') return 'A';
  if (mode === 'DELETED' || mode === 'D') return 'D';
  return 'M';
}
function appliedLabel(st) {
  if (st === 'APPLIED' || st === 'applied') return '已应用';
  return st || '';
}
function renderFileChange(tool) {
  const ds = tool.diffSummaries || [];
  if (!ds.length) return '';
  return ds.map(d => {
    const fp = d.path || '';
    const name = baseName(fp);
    // 顶层变更行显示本次编辑增量（lastDiffInfo），非累计值
    const a = d.lastAdd ?? d.add ?? 0;
    const del = d.lastDelete ?? d.delete ?? 0;
    const isReadme = /^readme(?:\.md|\.txt)?$/i.test(baseName(fp));
    return `<div class="fcitem">
  <div class="fc-l">${isReadme ? infoIconHtml('fi-lg') : iconCharHtml(fp, 'fi-lg')}<span class="fc-n">${esc(name)}</span></div>
  <div class="fc-r"><span class="fc-a">+${a}</span><span class="fc-d">-${del}</span><span class="fc-m">${modeLabel(d.mode)}</span><span class="fc-ap">${appliedLabel(d.fileStatus)}</span></div>
</div>`;
  }).join('');
}

// 待办块
function renderPlan(plans) {
  const entries = [];
  for (const p of plans) for (const e of (p.entries || [])) entries.push(e);
  if (!entries.length) return '';
  const items = entries.map(e => {
    const st = e.status || 'pending';
    const mark = st === 'completed' ? '<span class="todo-mark todo-done">✓</span>' : st === 'in_progress' ? '<span class="todo-mark todo-doing">◐</span>' : '<span class="todo-mark todo-pending">○</span>';
    const cls = st === 'completed' ? ' todo-item-done' : '';
    return `<div class="todo-item${cls}">${mark}<span>${mdInline(e.content || '')}</span></div>`;
  }).join('');
  return `<div class="blk ag open">
  <div class="blk-h ag-h" onclick="tg(this)">
    <span class="ag-t">待办</span>
    <span class="ag-sum">${entries.length}项</span>
    ${chevSvg()}
  </div>
  <div class="blk-c"><div class="blk-ci"><div class="todo-list">${items}</div></div></div>
</div>`;
}

// 汇总卡（N 个文件已变更）
function renderSummaryCard(fileAgg) {
  const files = Object.values(fileAgg);
  if (!files.length) return '';
  const totalAdd = files.reduce((a, f) => a + f.add, 0);
  const totalDel = files.reduce((a, f) => a + f.delete, 0);
  const items = files.map(f => {
    const isReadme = /^readme(?:\.md|\.txt)?$/i.test(baseName(f.path));
    return `<div class="sum-item">
  ${isReadme ? infoIconHtml('fi-sum') : iconCharHtml(f.path, 'fi-sum')}
  <span class="sum-n">${esc(baseName(f.path))}</span>
  <span class="sum-s"><span class="sum-a">+${f.add}</span> <span class="sum-dd">-${f.delete}</span></span>
  <span class="sum-m">${modeLabel(f.mode)}</span>
</div>`;
  }).join('');
  return `<div class="blk sum open">
  <div class="blk-h sum-h" onclick="tg(this)">
    <svg class="ic" viewBox="0 0 24 24" fill="currentColor"><use href="#i-sum"/></svg>
    <span class="sum-t">${files.length} 个文件已变更</span>
    <span class="sum-add">+${totalAdd}</span>
    <span class="sum-del">-${totalDel}</span>
  </div>
  <div class="blk-c"><div class="blk-ci"><div class="sum-list">${items}</div></div></div>
</div>`;
}

// 子任务（嵌套）
function renderSubTask(tool, subTurn) {
  const input = tool.input || {};
  const prompt = (input.prompt || input.description || input.task || subTurn?.userMessage || '子任务').toString().slice(0, 80);
  let inner = '';
  if (subTurn) inner = renderTurnBody(subTurn, true);
  else inner = `<div class="rfline"><span class="rf-s">子任务</span><span class="rf-f">${esc(prompt)}</span></div>`;
  return `<div class="blk ag open subtask">
  <div class="blk-h ag-h" onclick="tg(this)">
    <span class="ag-t">子任务</span>
    <span class="ag-sum">${esc(prompt)}</span>
    ${chevSvg()}
  </div>
  <div class="blk-c"><div class="blk-ci">${inner}</div></div>
</div>`;
}

// ---------------------------------------------------------------- 轮次主体
const turnByRequestId = new Map();
for (const t of DATA.turns) turnByRequestId.set(t.requestId, t);

function isGroupTool(tool) {
  if (EDIT_TOOLS.has(tool.toolName)) return false;
  if (tool.toolName === 'task') return false;
  return true; // 其余（检索/读取/命令/通用）都归入已探索组
}

function renderTurnBody(turn, isSub) {
  const tl = turn.timeline || [];
  const out = [];
  let buf = []; // {kind:'think'|'tool', ev}

  const flushGroup = () => {
    if (!buf.length) return;
    const tools = buf.filter(b => b.kind === 'tool');
    if (!tools.length) {
      // 纯思考 → 独立深度思考块
      for (const b of buf) out.push(renderThink(b.ev.text, b.ev.thinkingMs, false));
    } else {
      const nSearch = tools.filter(b => SEARCH_TOOLS.has(b.ev.data.toolName)).length;
      const nRead = tools.filter(b => READ_TOOLS.has(b.ev.data.toolName)).length;
      const badges = [];
      if (nRead) badges.push(`${nRead}文件`);
      if (nSearch) badges.push(`${nSearch}检索`);
      const badgeHtml = badges.length ? `<span class="ag-sum">${esc(badges.join(' '))}</span>` : '';
      const inner = buf.map(b => {
        if (b.kind === 'think') return renderThink(b.ev.text, b.ev.thinkingMs, true);
        const tool = b.ev.data;
        if (SEARCH_TOOLS.has(tool.toolName)) return renderSearchCard(tool);
        if (READ_TOOLS.has(tool.toolName)) return renderReadLine(tool);
        if (tool.subRequestId && turnByRequestId.has(tool.subRequestId)) return renderSubTask(tool, turnByRequestId.get(tool.subRequestId));
        return renderGenericToolLine(tool);
      }).join('');
      out.push(`<div class="blk ag open">
  <div class="blk-h ag-h" onclick="tg(this)">
    <svg class="ic" viewBox="0 0 24 24" fill="currentColor"><use href="#i-mag"/></svg>
    <span class="ag-t">已探索</span>
    ${badgeHtml}
    ${chevSvg()}
  </div>
  <div class="blk-c"><div class="blk-ci">${inner}</div></div>
</div>`);
    }
    buf = [];
  };

  let msgBuf = [];
  const flushMsg = () => {
    if (!msgBuf.length) return;
    const text = msgBuf.map(m => m.text).join('');
    out.push(`<div class="asst"><div class="prose">${mdBlock(text)}</div></div>`);
    msgBuf = [];
  };

  for (const ev of tl) {
    if (ev.type === 'thought') { flushMsg(); buf.push({ kind: 'think', ev }); }
    else if (ev.type === 'message') { flushGroup(); msgBuf.push(ev); }
    else if (ev.type === 'tool') {
      const tool = ev.data;
      if (tool.toolName === 'task') {
        flushGroup(); flushMsg();
        out.push(renderSubTask(tool, tool.subRequestId ? turnByRequestId.get(tool.subRequestId) : null));
      } else if (EDIT_TOOLS.has(tool.toolName)) {
        flushGroup(); flushMsg();
        const html = renderFileChange(tool);
        if (html) out.push(html);
        else out.push(renderGenericToolLine(tool)); // 无 diff 摘要的编辑（如删除失败）
      } else if (isGroupTool(tool)) {
        flushMsg(); buf.push({ kind: 'tool', ev });
      } else {
        flushGroup(); flushMsg();
        out.push(renderGenericToolLine(tool));
      }
    }
  }
  flushGroup();
  flushMsg();

  // 待办（计划）渲染在最前
  if (turn.plans && turn.plans.length) out.unshift(renderPlan(turn.plans));

  // 汇总卡（聚合所有 diff：取每文件最后一次 diffInfo 累计值，与真实 UI 一致）
  const agg = {};
  for (const ev of tl) {
    if (ev.type !== 'tool') continue;
    for (const d of (ev.data.diffSummaries || [])) {
      const key = (d.path || '').toLowerCase();
      // 后出现的 diffInfo 覆盖先前的（流中为累计值，最后一次即最终值）
      agg[key] = { path: d.path || '', add: d.add ?? 0, delete: d.delete ?? 0, mode: d.mode || 'MODIFIED' };
    }
  }
  if (!isSub) {
    const sumHtml = renderSummaryCard(agg);
    if (sumHtml) out.push(sumHtml);
  }
  return out.join('\n');
}

function renderUserBubble(turn) {
  const text = turn.userMessage || '';
  let pillHtml = '';
  const atts = turn.userAttachments || [];
  if (atts.length) {
    // 真实 UI：chat-input-pill 内联于消息文本，图标为 Seti 字体按扩展名解析（html→<> md→M↓ readme→info png→图片）
    pillHtml = atts.map(a => {
      const name = a.fileName || (a.type === 'image' ? '图片' : '附件');
      const note = a.type === 'image' ? '（图片本体已丢失）' : (a.type === 'resource' && a.contentLength ? `（${a.contentLength} 字符）` : '');
      return `<span class="pill">${iconCharHtml(name, 'fi-lg')}<span class="pill-n">${esc(name)}</span></span>${note ? `<span class="pill-note">${esc(note)}</span>` : ''}`;
    }).join(' ');
  }
  if (!text && !pillHtml) return '';
  return `<div class="urow"><div class="ububble">${pillHtml ? `<div class="u-atts">${pillHtml}</div>` : ''}${text ? `<div class="u-text">${esc(text)}</div>` : ''}</div></div>`;
}

// ---------------------------------------------------------------- 组装页面
const mainTurns = DATA.turns.filter(t => !t.isSubTaskTurn);
const tocEntries = [];
const sections = [];

mainTurns.forEach((turn, idx) => {
  const n = idx + 1;
  const q = (turn.userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 50) || (turn.userAttachments && turn.userAttachments.length ? '[图片/文件附件]' : `（内部轮次 ${turn.requestId.slice(0, 8)}）`);
  tocEntries.push(`<a href="#t${n}" class="toc-item" data-target="t${n}"><span class="toc-num">${n}</span><span class="toc-q">${esc(q)}</span></a>`);
  const body = renderTurnBody(turn, false);
  const bubble = renderUserBubble(turn);
  sections.push(`<section class="turn" id="t${n}">${bubble}${body ? `<div class="tbody">${body}</div>` : ''}</section>`);
});

const fontBase64 = fs.readFileSync(path.join(__dirname, '..', 'assets', 'aicoding-seti.woff')).toString('base64');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(DATA.session?.title || DATA.sessionTitle || '会话导出')} · Qoder 会话导出</title>
<style>
@font-face {
  font-family: 'aicoding-seti';
  src: url(data:font/woff;base64,${fontBase64}) format('woff');
  font-weight: normal; font-style: normal; font-display: block;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: #ffffff;
  font-family: "Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.4; color: #141414;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 16px 80px; }

/* ===== 文档头 ===== */
.doc-head { padding: 24px 0 8px; border-bottom: 1px solid #e6e6e6; margin-bottom: 8px; }
.doc-head h1 { font-size: 18px; font-weight: 600; color: #141414; }
.doc-meta { margin-top: 6px; font-size: 12px; color: #636261; display: flex; gap: 16px; flex-wrap: wrap; }

/* ===== 轮次 ===== */
.turn { }
.urow { padding-top: 20px; display: flex; justify-content: flex-end; }
.ububble {
  max-width: 75%; background: #f9f9f9; border: 0.667px solid #e6e6e6;
  border-radius: 8px; padding: 6px 8px; cursor: default;
}
.u-text { font-size: 13px; color: #141414; white-space: pre-wrap; word-break: break-word; }
/* 附件 pill（真实 UI chat-input-pill：inline-flex 无底色，图标 Seti 18px，文件名 12px #141414） */
.u-atts { margin-bottom: 2px; display: flex; flex-wrap: wrap; row-gap: 2px; align-items: center; }
.pill { display: inline-flex; align-items: center; margin: 0 2px; cursor: pointer; max-width: 100%; }
.pill .fi { font-size: 18px; width: 22px; height: 22px; }
.pill-n { color: #141414; font-size: 12px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.pill-note { font-size: 12px; color: rgba(99,98,97,.45); }
.tbody > * { margin-top: 12px; }
.tbody > *:first-child { margin-top: 12px; }

/* ===== 通用折叠块 ===== */
.blk-c { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .2s ease-out; }
.blk-c > .blk-ci { overflow: hidden; min-height: 0; }
.blk.closed > .blk-c { grid-template-rows: 0fr; }
.blk-h { display: flex; flex-direction: row; align-items: center; gap: 4px; height: 16px; font-size: 12px; line-height: 16px; cursor: pointer; user-select: none; max-width: 100%; white-space: nowrap; }
.chev { width: 13px; height: 13px; flex: 0 0 auto; color: rgba(20,20,20,.45); transform: rotate(90deg); transition: transform .2s ease-in-out; }
.blk.closed .chev { transform: rotate(0deg); }
.ic { width: 13px; height: 13px; flex: 0 0 auto; color: rgba(20,20,20,.45); }
.t-45 { color: rgba(20,20,20,.45); }

/* ===== 已探索活动组 ===== */
.ag { display: flex; flex-direction: column; gap: 4px; padding: 2px 0; }
.ag-h { gap: 4px; color: rgba(20,20,20,.45); }
.ag-t { color: rgba(20,20,20,.45); font-size: 12px; }
.ag-sum { color: rgba(99,98,97,.45); font-size: 12px; margin-left: 8px; }
.ag > .blk-c { margin-top: 8px; }
.ag > .blk-c > .blk-ci { display: flex; flex-direction: column; gap: 4px; padding: 0 2px 0 19px; }
.ag > .blk-c > .blk-ci > * { flex: 0 0 auto; }

/* ===== 深度思考 ===== */
.think { display: flex; flex-direction: column; }
.th-h { gap: 4px; }
.th-h .t-45 { font-size: 12px; }
.think > .blk-c { margin-top: 4px; }
.th-md { margin-top: 4px; font-size: 12px; color: #8e8c8b; line-height: 1.52; }
.th-md p { margin: 0 0 8px; }
.th-md p:last-child { margin-bottom: 0; }
.th-md ul, .th-md ol { padding-left: 24px; margin: 0 0 8px; }
.th-md code { font-family: Consolas, "Courier New", monospace; font-size: 12px; border-radius: 3px; background: rgba(0,0,0,.05); padding: 0 3px; }

/* ===== 已检索代码 ===== */
.st { display: flex; flex-direction: column; }
.st-h { gap: 6px; font-size: 12px; }
.st-n { color: rgba(20,20,20,.45); }
.st-e { color: rgba(99,98,97,.45); margin-left: 8px; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
.st-c { color: rgba(99,98,97,.45); margin-left: 4px; }
.st-h .chev { width: 14px; height: 14px; }
.st > .blk-c { margin-top: 4px; }
.st-list { }
.st-item { display: flex; flex-direction: row; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; height: 28px; }
.st-item:hover { background: rgba(0,0,0,.04); }
.st-l { display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; }
.st-fn { color: #636261; font-size: 12px; }
.st-ln { color: #636261; font-size: 12px; margin-left: 8px; }
.st-r { color: #8e8c8b; font-size: 12px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; direction: rtl; text-align: right; }

/* ===== 已查看 / 通用工具行 ===== */
.rfline { display: flex; flex-direction: row; align-items: center; gap: 4px; padding: 1px 0; font-size: 12px; line-height: 18.2px; min-height: 20px; }
.rf-s { color: #636261; }
.rf-f { color: #636261; }
.rf-r { color: #636261; }

/* ===== 文件图标（尺寸来自 CDP 计算样式） ===== */
/* 检索结果行：14px 字号、14×20 盒子 */
.fi { font-family: 'aicoding-seti'; font-style: normal; font-size: 14px; line-height: 1; width: 14px; height: 20px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
/* 顶层文件变更行：19.5px 字号、22×22 盒子 */
.fi-lg { font-size: 19.5px; width: 22px; height: 22px; }
/* 汇总卡行：18px 字号、22×22 盒子 */
.fi-sum { font-size: 18px; width: 22px; height: 22px; }

/* ===== 文件变更行 ===== */
.fcitem {
  display: flex; flex-direction: row; align-items: center; padding: 0 8px;
  height: 32px; background: #f9f9f9; border: 0.667px solid #e6e6e6;
  border-radius: 4px; overflow: hidden;
}
.fc-l { display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; }
.fc-n { font-size: 13px; color: #141414; }
.fc-r { margin-left: auto; display: flex; align-items: center; }
.fc-r span { font-size: 12px; }
.fc-a { color: #2f7d4f; margin-right: 4px; }
.fc-d { color: #ad0707; margin-right: 8px; }
.fc-m { color: #faad14; margin-right: 8px; }
.fc-ap { color: #636261; }

/* ===== 助手回答 ===== */
.asst { font-size: 13px; color: #141414; }
.prose { line-height: 24px; }
.prose p { margin: 0 0 8px; }
.prose p:last-child { margin-bottom: 0; }
.prose h3 { font-size: 15px; margin: 14px 0 8px; }
.prose h4 { font-size: 14px; margin: 12px 0 6px; }
.prose h5 { font-size: 13px; margin: 10px 0 6px; }
.prose h6 { font-size: 13px; margin: 10px 0 6px; }
.prose ul, .prose ol { padding-left: 24px; margin: 0 0 8px; }
.prose li { margin: 2px 0; }
.prose code { font-family: Consolas, "Courier New", monospace; font-size: 12px; background: rgba(0,0,0,.05); border-radius: 3px; padding: 1px 4px; }
.prose pre { background: #f9f9f9; border: 0.667px solid #e6e6e6; border-radius: 4px; padding: 8px 10px; overflow-x: auto; margin: 0 0 8px; }
.prose pre code { background: none; padding: 0; font-size: 12px; line-height: 1.5; }
.prose blockquote { border-left: 3px solid #e6e6e6; padding-left: 10px; color: #636261; margin: 0 0 8px; }
.prose table { border-collapse: collapse; margin: 0 0 8px; }
.prose th, .prose td { border: 0.667px solid #e6e6e6; padding: 4px 8px; font-size: 12px; }
.prose th { background: #f9f9f9; }
.prose a { color: #0969da; text-decoration: none; }
.prose a:hover { text-decoration: underline; }
.prose hr { border: none; border-top: 0.667px solid #e6e6e6; margin: 10px 0; }
.prose strong { font-weight: 600; }

/* ===== 汇总卡 ===== */
.sum { background: #f9f9f9; border: 0.667px solid #e6e6e6; border-radius: 4px; overflow: hidden; }
.sum-h { padding: 6px 8px; gap: 8px; height: auto; min-height: 28px; border-bottom: 0.667px solid #e6e6e6; }
.sum-t { color: #636261; font-size: 12px; }
.sum-add { color: #2f7d4f; font-size: 12px; margin-left: 4px; }
.sum-del { color: #ad0707; font-size: 12px; }
.sum .chev { margin-left: auto; }
.sum-list { background: #fff; padding: 4px; }
.sum-item { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px; border-radius: 2px; font-size: 12px; margin-top: 2px; white-space: nowrap; }
.sum-item:first-child { margin-top: 0; }
.sum-item:hover { background: rgba(0,0,0,.04); }
.sum-n { color: #141414; }
.sum-s { color: #636261; margin-left: 8px; }
.sum-a { margin-right: 4px; }
.sum-dd { margin-right: 8px; }
.sum-m { color: #faad14; margin-left: 4px; font-size: 12px; }

/* ===== 待办 ===== */
.todo-list { font-size: 12px; color: #636261; }
.todo-item { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; }
.todo-mark { flex: 0 0 auto; }
.todo-done { color: #2f7d4f; }
.todo-doing { color: #faad14; }
.todo-pending { color: #636261; }
.todo-item-done span { color: #8e8c8b; text-decoration: line-through; }

/* ===== 子任务 ===== */
.subtask > .blk-c > .blk-ci > .blk { margin-top: 8px; }
.subtask > .blk-c > .blk-ci > .rfline { margin-top: 4px; }
.subtask .asst { font-size: 12px; color: #636261; }

/* ===== 目录 & 悬浮按钮 ===== */
.toc {
  position: fixed; right: 0; top: 0; bottom: 0; width: 260px;
  border-left: 0.667px solid #e6e6e6; background: #fff;
  padding: 16px 0 16px 0; overflow-y: auto; z-index: 100;
  transform: translateX(100%); transition: transform .2s ease;
}
.toc.show { transform: translateX(0); }
.toc-title { font-size: 12px; color: #636261; padding: 0 16px 8px; font-weight: 600; }
.toc-item { display: flex; gap: 8px; padding: 4px 16px; text-decoration: none; color: #636261; font-size: 12px; line-height: 1.4; }
.toc-item:hover { background: #f9f9f9; }
.toc-item.active { background: #f0f0f0; color: #141414; }
.toc-num { color: #8e8c8b; flex: 0 0 auto; min-width: 22px; text-align: right; }
.toc-q { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.float-btns { position: fixed; right: 20px; bottom: 24px; display: flex; flex-direction: column; gap: 8px; z-index: 110; }
.fbtn {
  background: #fff; border: 0.667px solid #e6e6e6; border-radius: 6px;
  padding: 7px 12px; font-size: 12px; color: #141414; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.08); white-space: nowrap;
}
.fbtn:hover { background: #f9f9f9; }
body.toc-open .float-btns { right: 280px; }

@media (max-width: 1400px) { .toc { display: none; } .float-btns { right: 16px; } body.toc-open .float-btns { right: 16px; } }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="i-mag" viewBox="0 0 24 24" fill="currentColor">${SYM_MAG}</symbol>
  <symbol id="i-think" viewBox="0 0 24 24" fill="currentColor">${SYM_THINK}</symbol>
  <symbol id="i-chev" viewBox="0 0 24 24" fill="currentColor">${SYM_CHEV}</symbol>
  <symbol id="i-sum" viewBox="0 0 24 24" fill="currentColor">${SYM_SUM}</symbol>
</svg>
<div class="wrap">
  <div class="doc-head">
    <h1>${esc(DATA.session?.title || DATA.sessionTitle || '会话导出')}</h1>
    <div class="doc-meta">
      <span>共 ${mainTurns.length} 轮对话</span>
      <span>导出自 Qoder ACP 会话流</span>
      <span>生成时间：${new Date().toLocaleString('zh-CN')}</span>
    </div>
  </div>
  ${sections.join('\n')}
</div>
<nav class="toc" id="toc">
  <div class="toc-title">对话目录</div>
  ${tocEntries.join('')}
</nav>
<div class="float-btns">
  <button class="fbtn" onclick="setAll(true)">全部展开</button>
  <button class="fbtn" onclick="setAll(false)">全部折叠</button>
  <button class="fbtn" id="tocBtn" onclick="toggleToc()">显示目录</button>
  <button class="fbtn" onclick="window.scrollTo({top:0,behavior:'smooth'})">回到顶部</button>
</div>
<script>
function tg(h) { h.parentElement.classList.toggle('closed'); }
function setAll(open) {
  document.querySelectorAll('.blk').forEach(function (b) { b.classList.toggle('closed', !open); });
}
function toggleToc() {
  var t = document.getElementById('toc');
  t.classList.toggle('show');
  document.body.classList.toggle('toc-open');
  document.getElementById('tocBtn').textContent = t.classList.contains('show') ? '隐藏目录' : '显示目录';
}
(function () {
  var items = Array.prototype.slice.call(document.querySelectorAll('.toc-item'));
  if (!items.length) return;
  var targetIds = items.map(function (a) { return a.getAttribute('data-target'); });
  var els = targetIds.map(function (id) { return document.getElementById(id); });
  var current = -1;
  function onScroll() {
    var y = window.scrollY + 80;
    var idx = 0;
    for (var i = 0; i < els.length; i++) {
      if (els[i] && els[i].offsetTop <= y) idx = i;
    }
    if (idx !== current) {
      current = idx;
      items.forEach(function (a, i) { a.classList.toggle('active', i === idx); });
      var act = items[idx];
      if (act && act.scrollIntoView) { /* keep TOC in view */ }
    }
  }
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(function () { onScroll(); ticking = false; });
    }
  }, { passive: true });
  onScroll();
})();
</script>
</body>
</html>`;

fs.writeFileSync(OUT_HTML, html);
console.log('[html] saved', OUT_HTML, (fs.statSync(OUT_HTML).size / 1024 / 1024).toFixed(2), 'MB,', mainTurns.length, 'turns');
