/**
 * 解析 Qoder ACP 流式导出数据，重建完整对话（用户问题/思考过程/工具调用/回答）
 * 输入: 流数据 json + 会话记录 dump json
 * 输出: 完整对话 json
 * 参数: node parse.js <stream.json> <dump.json> <out.json>
 */
const fs = require('fs');
const path = require('path');

const streamFile = process.argv[2] || path.join(__dirname, 'session_stream.json');
const dumpFile = process.argv[3] || path.join(__dirname, 'session_dump.json');
const jsonOut = process.argv[4] || path.join(__dirname, '导出_完整对话.json');
const stream = JSON.parse(fs.readFileSync(streamFile, 'utf8'));
const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));

const notifs = stream.notifications;
const session = dump.session;
const records = session.chatRecords;

// record 的 requestId -> 记录（用于补充元数据与顺序）
const recByReq = new Map();
for (const r of records) recByReq.set(r.requestId, r);

// 思考链 chunk 是按"思维块"推送的：98.3% 的块边界是句子完整结束点（应分段），
// 1.7% 是句子中间被切断（应空格连接）。块间插入空行恢复分段。
const SENT_END = /[.?!:;，。！？：；、]$/;

// 解析 qodercn:///agent/file?path=xxx 或 qodercn:///agent/attachment?path=xxx
// 形式的 URI，返回解码后的本地路径；解析失败返回空串
function decodeAgentUri(uri) {
  if (!uri) return '';
  try {
    const url = new URL(uri);
    const p = url.searchParams.get('path');
    if (!p) return '';
    return decodeURIComponent(p).replace(/\\/g, '/');
  } catch (e) {
    return '';
  }
}

// 从本地路径提取文件名（含扩展名）；失败则回退到 uri 尾部
function fileNameFromPath(localPath, fallback) {
  const p = localPath || '';
  const base = p.split('/').filter(Boolean).pop() || '';
  return base || fallback || '(未知文件)';
}

function joinThoughtChunks(chunks) {
  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i].text || '';
    if (i === 0) { out = text; continue; }
    const prev = (chunks[i - 1].text || '').trimEnd();
    const cur = text.trimStart();
    if (prev.endsWith('\n')) {
      // 前块已自带换行，直接续接
      out += cur;
    } else if (SENT_END.test(prev)) {
      // 完整句子结束 → 段落边界，插空行
      out += '\n\n' + cur;
    } else {
      // 句子被切断 → 空格连接
      out += ' ' + cur;
    }
  }
  // 规范化：压缩 3 个以上连续换行为空行（2 个），并去除首尾多余空白
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// 回答 chunk 是流式 token 级推送，换行已保留在块内 → 直接拼接
function joinMessageChunks(chunks) {
  return chunks.map((m) => m.text || '').join('').replace(/\n{3,}/g, '\n\n').trim();
}

// —— 工具结果摘要提取 ——

// 变更文件摘要：rawOutput 数组中带 diffInfo/fileStatus/path 的项
// 例：{path, fileStatus:"APPLIED", mode:"MODIFIED", diffInfo:{add, delete, modCounts, addChars, delChars}}
function extractDiffSummaries(output) {
  const arr = Array.isArray(output) ? output : [];
  return arr
    .filter((it) => it && it.path && it.fileStatus && it.diffInfo)
    .map((it) => ({
      path: it.path,
      fileStatus: it.fileStatus,          // APPLIED / DELETED / ...
      mode: it.mode || '',                 // ADD / MODIFIED / DELETED
      add: it.diffInfo.add ?? 0,           // 该文件本轮累计值（汇总卡用）
      delete: it.diffInfo.delete ?? 0,
      lastAdd: it.lastDiffInfo ? (it.lastDiffInfo.add ?? 0) : (it.diffInfo.add ?? 0),      // 本次编辑增量（顶层变更行用）
      lastDelete: it.lastDiffInfo ? (it.lastDiffInfo.delete ?? 0) : (it.diffInfo.delete ?? 0),
      modCounts: it.diffInfo.modCounts ?? 0,
      addChars: it.diffInfo.addChars ?? 0,
      delChars: it.diffInfo.delChars ?? 0,
    }));
}

// 检索/读取的文件位置：rawOutput 数组中带 fileName/startLine/endLine/path 的项
function extractFileRefs(output) {
  const arr = Array.isArray(output) ? output : [];
  return arr
    .filter((it) => it && it.fileName && it.path)
    .map((it) => ({
      fileName: it.fileName,
      path: it.path,
      startLine: it.startLine ?? null,
      endLine: it.endLine ?? null,
    }));
}

// 终端/命令输出：rawOutput 数组中带 content 的项（run_in_terminal / get_terminal_output）
function extractTerminalOutput(output) {
  const arr = Array.isArray(output) ? output : [];
  const parts = arr.filter((it) => it && typeof it.content === 'string' && it.content);
  if (parts.length === 0) return null;
  return parts.map((it) => it.content).join('\n');
}

// 按通知流顺序重建每轮
// 每轮 = 一个 requestId，字段：
//   requestId, order, userQuestions[], thoughts[], toolCalls[], assistantTexts[], plans[], createdAt, finishStatus
const turns = new Map();
const order = [];

function ensureTurn(rid) {
  if (!turns.has(rid)) {
    turns.set(rid, {
      requestId: rid,
      order: order.length,
      userMessages: [],
      thoughts: [],       // {text, thinkingMs, llmMessageId, ts}
      toolCalls: [],      // {toolCallId, title, kind, rawInput, meta}
      toolResults: new Map(), // toolCallId -> {status, rawOutput, meta}
      assistantMessages: [],
      plans: [],
      events: [],         // 时序事件流：thought | tool_call（用于重建交织UI）
      createdAt: null,
    });
    order.push(rid);
  }
  return turns.get(rid);
}

for (const n of notifs) {
  const params = n.params || {};
  const meta = params._meta || {};
  const rid = meta['ai-coding/request-id'] || '';
  const update = params.update || {};
  const type = update.sessionUpdate;
  const ts = meta['ai-coding/message-created-at'] || null;

  if (!rid) continue;
  const turn = ensureTurn(rid);
  if (ts && !turn.createdAt) turn.createdAt = ts;

  switch (type) {
    case 'user_message_chunk': {
      // 用户消息块可能有 4 种 content 类型，全部保留并保序：
      //   text     -> {type:'text', text}
      //   image    -> {type:'image', data, mimeType, uri}            (uri 指向本地临时图片)
      //   resource -> {type:'resource', resource:{text,mimeType,uri}} (resource.text 是文件完整内容)
      //   image+annotations -> 同上 image
      const c = update.content || {};
      const ctype = c.type;
      if (ctype === 'text') {
        const text = c.text || '';
        if (text) turn.userMessages.push({ type: 'text', text, ts });
      } else if (ctype === 'image') {
        turn.userMessages.push({
          type: 'image',
          mimeType: c.mimeType || 'image/png',
          uri: c.uri || '',
          localPath: decodeAgentUri(c.uri),
          ts,
        });
      } else if (ctype === 'resource') {
        const r = c.resource || {};
        turn.userMessages.push({
          type: 'resource',
          mimeType: r.mimeType || '',
          uri: r.uri || '',
          localPath: decodeAgentUri(r.uri),
          text: r.text || '',
          ts,
        });
      } else if (ctype) {
        // 未知类型也保留原始结构，不丢数据
        turn.userMessages.push({ type: ctype, raw: c, ts });
      }
      break;
    }
    case 'agent_thought_chunk': {
      const text = update.content?.text || '';
      if (text) {
        const ev = {
          text,
          thinkingMs: meta['ai-coding/thinking-duration-millis'] || null,
          llmMessageId: meta['ai-coding/llm-message-id'] || null,
          ts,
        };
        turn.thoughts.push(ev);
        turn.events.push({ type: 'thought', ...ev });
      }
      break;
    }
    case 'tool_call': {
      const ev = {
        toolCallId: update.toolCallId,
        title: update.title || meta['ai-coding/tool-name'] || '',
        kind: update.kind || meta['ai-coding/tool-kind'] || '',
        rawInput: update.rawInput ?? null,
        // 层级与子会话元数据
        parentToolCallId: meta['ai-coding/parent-tool-call-id'] || null,
        subRequestId: meta['ai-coding/sub-request-id'] || null,
        subSessionId: meta['ai-coding/sub-session-id'] || null,
        toolName: meta['ai-coding/tool-name'] || update.title || '',
        toolKind: meta['ai-coding/tool-kind'] || update.kind || '',
        thinkingMs: meta['ai-coding/thinking-duration-millis'] || null,
        llmMessageId: meta['ai-coding/llm-message-id'] || null,
        ts,
      };
      turn.toolCalls.push(ev);
      turn.events.push({ type: 'tool_call', ...ev });
      break;
    }
    case 'tool_call_update': {
      turn.toolResults.set(update.toolCallId, {
        status: update.status || '',
        rawOutput: update.rawOutput ?? null,
        internalStatus: meta['ai-coding/tool-call-internal-status'] || '',
        errorCode: meta['ai-coding/tool-call-error-code'] ?? null,
        errorMessage: meta['ai-coding/tool-call-error-message'] || '',
        thinkingMs: meta['ai-coding/thinking-duration-millis'] || null,
        ts,
      });
      break;
    }
    case 'agent_message_chunk': {
      const text = update.content?.text || '';
      if (text) {
        const ev = {
          text,
          thinkingMs: meta['ai-coding/thinking-duration-millis'] || null,
          llmMessageId: meta['ai-coding/llm-message-id'] || null,
          ts,
        };
        turn.assistantMessages.push(ev);
        turn.events.push({ type: 'message', ...ev });
      }
      break;
    }
    case 'plan': {
      turn.plans.push({
        planType: update._meta?.['ai-coding/plan_type'] || '',
        entries: update.entries || [],
        ts,
      });
      break;
    }
    default:
      break;
  }
}

// 组装最终结构
const finalTurns = order.map((rid) => {
  const t = turns.get(rid);
  const rec = recByReq.get(rid) || null;
  // 用户消息：纯文本（向后兼容）+ 附件列表（图片/文件，保序）
  const userParts = t.userMessages.map((m, i) => {
    if (m.type === 'text') {
      return { order: i, type: 'text', text: m.text };
    }
    if (m.type === 'image') {
      return {
        order: i,
        type: 'image',
        mimeType: m.mimeType,
        uri: m.uri,
        localPath: m.localPath,
        fileName: fileNameFromPath(m.localPath, '图片' + (i + 1)),
        // 图片内容不在流中（data 为空），原文件在本地 Temp 目录
        originalExists: m.localPath ? fs.existsSync(m.localPath) : false,
      };
    }
    if (m.type === 'resource') {
      return {
        order: i,
        type: 'resource',
        mimeType: m.mimeType,
        uri: m.uri,
        localPath: m.localPath,
        fileName: fileNameFromPath(m.localPath, '附件' + (i + 1)),
        content: m.text, // 文件完整内容
        contentLength: m.text.length,
      };
    }
    return { order: i, type: m.type, raw: m.raw };
  });
  const userText = userParts.filter((p) => p.type === 'text').map((p) => p.text).join('') ||
    (rec?.question || '');
  const userAttachments = userParts.filter((p) => p.type !== 'text');

  const thoughtText = joinThoughtChunks(t.thoughts);
  const assistantText = joinMessageChunks(t.assistantMessages);
  const thinkingMs = t.thoughts.reduce((a, m) => a + (m.thinkingMs || 0), 0) ||
    (t.assistantMessages.reduce((a, m) => a + (m.thinkingMs || 0), 0));

  // 工具调用序列（配对 result）
  const toolCalls = t.toolCalls.map((c) => {
    const res = t.toolResults.get(c.toolCallId);
    const output = res?.rawOutput ?? null;
    return {
      toolCallId: c.toolCallId,
      title: c.title,
      kind: c.kind,
      toolName: c.toolName,
      toolKind: c.toolKind,
      input: c.rawInput,
      status: res?.status || '',
      internalStatus: res?.internalStatus || '',
      error: res?.errorMessage || null,
      errorCode: res?.errorCode ?? null,
      thinkingMs: c.thinkingMs || res?.thinkingMs || null,
      output,
      // 层级与子会话
      parentToolCallId: c.parentToolCallId,
      subRequestId: c.subRequestId,
      subSessionId: c.subSessionId,
      // 结果摘要提取
      diffSummaries: extractDiffSummaries(output),
      fileRefs: extractFileRefs(output),
      terminalOutput: extractTerminalOutput(output),
    };
  });

  // 构建时序 timeline（thought / tool_call / message 按原始通知流交错，用于重建截图式交织UI）
  const timeline = [];
  for (const ev of t.events) {
    if (ev.type === 'thought') {
      timeline.push({
        type: 'thought',
        text: ev.text,
        thinkingMs: ev.thinkingMs,
        llmMessageId: ev.llmMessageId,
      });
    } else if (ev.type === 'tool_call') {
      const tc = toolCalls.find((c) => c.toolCallId === ev.toolCallId);
      if (tc) {
        timeline.push({
          type: 'tool',
          data: tc,
        });
      }
    } else if (ev.type === 'message') {
      timeline.push({
        type: 'message',
        text: ev.text,
      });
    }
  }

  return {
    requestId: rid,
    order: t.order,
    createdAt: t.createdAt || rec?.gmtCreate || null,
    gmtCreate: rec?.gmtCreate || null,
    finishStatus: rec?.finishStatus ?? null,
    sessionType: rec?.sessionType || null,
    userMessage: userText,
    userAttachments,
    thinkingProcess: thoughtText,
    thinkingDurationMs: thinkingMs,
    assistantReply: assistantText,
    plans: t.plans.map((p) => ({ planType: p.planType, entries: p.entries })),
    toolCalls,
    timeline,
    summary: rec?.summary || null,
  };
});

// —— 跨轮次全局工具树 ——
// 子任务（task）工具的调用在 ACP 流中拥有独立 requestId（sub-request-id），
// 因此父子调用分属不同"轮"。这里用全局 toolCallId 映射把所有调用挂成一棵森林：
// 主轮的 task 是根，子轮内的调用挂到对应 parentToolCallId 下。
const allCallNodes = new Map();   // toolCallId -> {node, requestId}
for (const t of finalTurns) {
  for (const c of t.toolCalls) {
    allCallNodes.set(c.toolCallId, { node: { ...c, children: [] }, requestId: t.requestId });
  }
}
// 挂载子节点
for (const { node } of allCallNodes.values()) {
  const pid = node.parentToolCallId;
  if (pid && allCallNodes.has(pid)) {
    allCallNodes.get(pid).node.children.push(node);
  }
}
// 为每轮生成树（仅该轮的根调用及其子孙），并标记子任务轮
const turnByReq = new Map(finalTurns.map((t) => [t.requestId, t]));
for (const t of finalTurns) {
  const roots = t.toolCalls
    .filter((c) => !c.parentToolCallId || !allCallNodes.has(c.parentToolCallId))
    .map((c) => allCallNodes.get(c.toolCallId).node);
  t.toolTree = roots;
  // 纯子任务轮：本轮的调用全部有父、且父在别的轮 → 工具树为空（调用已挂到父轮）
  const hasOwnRoot = roots.length > 0;
  t.isSubTaskTurn = t.toolCalls.length > 0 && !hasOwnRoot;
  if (t.isSubTaskTurn) {
    const firstChild = t.toolCalls[0];
    const parentCall = firstChild.parentToolCallId && allCallNodes.get(firstChild.parentToolCallId);
    t.parentTurnRequestId = parentCall ? parentCall.requestId : null;
  } else {
    t.parentTurnRequestId = null;
  }
}

// 输出 JSON
const outJson = {
  exportedAt: new Date().toISOString(),
  sessionId: session.sessionId,
  sessionTitle: session.sessionTitle,
  projectName: session.projectName,
  gmtCreate: session.gmtCreate,
  gmtModified: session.gmtModified,
  totalTurns: finalTurns.length,
  stats: {
    turnsWithQuestion: finalTurns.filter((t) => t.userMessage).length,
    turnsWithThinking: finalTurns.filter((t) => t.thinkingProcess).length,
    turnsWithReply: finalTurns.filter((t) => t.assistantReply).length,
    turnsWithTools: finalTurns.filter((t) => t.toolCalls.length > 0).length,
    totalToolCalls: finalTurns.reduce((a, t) => a + t.toolCalls.length, 0),
    totalFileChanges: finalTurns.reduce((a, t) => a + t.toolCalls.reduce((x, c) => x + c.diffSummaries.length, 0), 0),
    totalNestedCalls: finalTurns.reduce((a, t) => a + t.toolCalls.filter((c) => c.parentToolCallId).length, 0),
    totalFailedCalls: finalTurns.reduce((a, t) => a + t.toolCalls.filter((c) => c.status === 'failed').length, 0),
    turnsWithAttachments: finalTurns.filter((t) => t.userAttachments.length > 0).length,
    totalImages: finalTurns.reduce((a, t) => a + t.userAttachments.filter((p) => p.type === 'image').length, 0),
    totalResources: finalTurns.reduce((a, t) => a + t.userAttachments.filter((p) => p.type === 'resource').length, 0),
  },
  turns: finalTurns,
};

fs.writeFileSync(jsonOut, JSON.stringify(outJson, null, 2), 'utf8');
console.log('[json] saved', jsonOut, (fs.statSync(jsonOut).size / 1024 / 1024).toFixed(2), 'MB');
console.log('[json] totalTurns:', finalTurns.length, JSON.stringify(outJson.stats));
