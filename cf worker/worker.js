// ============================================================
// 酒馆 - Cloudflare Worker
// 前后端一体，支持 @cf/ 模型 (Workers AI) + 外部 API 代理
//
// 环境变量:
//   BASE_URL  - OpenAI 兼容 API 地址 (默认: https://api.openai.com/v1)
//   API_KEY   - API 密钥
//
// Cloudflare 绑定:
//   AI          - Workers AI 绑定 (用于 @cf/ 模型)
//   JIUGUAN_KV  - KV 命名空间 (持久化保存设置、世界书、破限提示词、聊天记录)
// ============================================================

// ============================================================
// 全局状态 (单 worker 内存)
// ============================================================
const AI_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  model: '',
  worldBook: '',
  jailbreakPrompt: ''
};

const users = new Map(); // ws -> { id, name, color, joinTime, pendingWorldbook, pendingJailbreak, abortController }
const messageHistory = []; // 内存消息历史
const MAX_HISTORY = 200;

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateId() {
  let id = '';
  for (let i = 0; i < 8; i++) id += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  return id;
}

function generateColor() {
  const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#16a085','#c0392b','#2980b9','#27ae60','#8e44ad','#d35400','#2c3e50','#7f8c8d'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function addMessage(msg) {
  messageHistory.push(msg);
  if (messageHistory.length > MAX_HISTORY * 2) {
    messageHistory.splice(0, messageHistory.length - MAX_HISTORY);
  }
}

function clearHistory() {
  messageHistory.length = 0;
}

function compressHistory(hist) {
  if (hist.length <= 6) return { compressed: false, history: hist };
  const keep = hist.slice(-6);
  keep.unshift({
    role: 'system',
    content: '上一段对话共 ' + (hist.length - 6) + ' 条消息，已压缩为以下摘要：\n用户发起了关于角色扮演的对话，AI已经作出了相应回复。请继续当前角色和情节进行。'
  });
  return { compressed: true, history: keep };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of users) {
    try { ws.send(msg); } catch (_) {}
  }
}

function broadcastUserList() {
  const list = [];
  for (const [, info] of users) {
    list.push({ id: info.id, name: info.name, color: info.color, joinTime: info.joinTime });
  }
  broadcast({ type: 'userlist', users: list });
}

// ============================================================
// KV 持久化
// ============================================================
let kvLoaded = false;
let kvSaveTimer = null;

async function loadFromKV(env) {
  if (kvLoaded) return;
  kvLoaded = true;
  try {
    await reloadFromKV(env);
    // 加载消息历史
    const msgs = await env.JIUGUAN_KV.get('messages', 'json');
    if (Array.isArray(msgs)) {
      messageHistory.length = 0;
      for (const m of msgs) messageHistory.push(m);
    }
  } catch (_) {}
}

// 强制从 KV 重新读取（忽略 kvLoaded 标志，用于跨 isolate 同步）
async function reloadFromKV(env) {
  try {
    const settings = await env.JIUGUAN_KV.get('settings', 'json');
    if (settings) {
      if (settings.baseUrl !== undefined) AI_SETTINGS.baseUrl = settings.baseUrl;
      if (settings.apiKey !== undefined) AI_SETTINGS.apiKey = settings.apiKey;
      if (settings.model !== undefined) AI_SETTINGS.model = settings.model;
      if (settings.worldBook !== undefined) AI_SETTINGS.worldBook = settings.worldBook;
      if (settings.jailbreakPrompt !== undefined) AI_SETTINGS.jailbreakPrompt = settings.jailbreakPrompt;
    }
  } catch (_) {}
}

async function saveSettingsToKV(env) {
  await env.JIUGUAN_KV.put('settings', JSON.stringify(AI_SETTINGS));
}

async function saveHistoryToKV(env) {
  const toSave = messageHistory.slice(-MAX_HISTORY);
  await env.JIUGUAN_KV.put('messages', JSON.stringify(toSave));
}

function scheduleSaveHistory(env) {
  if (kvSaveTimer) clearTimeout(kvSaveTimer);
  kvSaveTimer = setTimeout(async () => {
    await saveHistoryToKV(env);
    kvSaveTimer = null;
  }, 2000); // 2s 防抖
}

// ============================================================
// AI 流式调用 — 统一入口
// ============================================================
async function callAIStream(messages, model, env, onChunk, onDone, onError, abortSignal) {
  const isCFModel = model && model.startsWith('@cf/');

  if (isCFModel) {
    if (!env.AI) {
      onError('Workers AI 未绑定（需要 AI binding）');
      return;
    }
    try {
      const resp = await env.AI.run(model, { messages, stream: true }, { signal: abortSignal });
      let fullContent = '';
      for await (const chunk of resp) {
        if (chunk.response) {
          fullContent += chunk.response;
          onChunk(chunk.response);
        }
      }
      onDone(fullContent);
    } catch (err) {
      if (err.name === 'AbortError') return onError('已停止生成');
      onError('Workers AI 失败: ' + (err.message || err));
    }
    return;
  }

  // ---- 外部 OpenAI 兼容 API ----
  const baseUrl = (AI_SETTINGS.baseUrl || env.BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const apiKey = AI_SETTINGS.apiKey || env.API_KEY || '';
  const url = baseUrl + '/v1/chat/completions';

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: abortSignal
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      onError('API 请求失败 (' + resp.status + '): ' + errText.substring(0, 200));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const d = t.slice(6);
        if (d === '[DONE]') break;
        try {
          const json = JSON.parse(d);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { fullContent += delta; onChunk(delta); }
          if (json.choices?.[0]?.finish_reason === 'stop') break;
        } catch (_) {}
      }
    }
    onDone(fullContent);
  } catch (err) {
    if (err.name === 'AbortError') return onError('已停止生成');
    onError('AI 请求失败: ' + err.message);
  }
}

// ============================================================
// WebSocket 处理
// ============================================================
async function handleWebSocket(request, env) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  const user = {
    id: generateId(),
    name: '游客',
    color: generateColor(),
    joinTime: new Date().toISOString(),
    pendingWorldbook: false,
    pendingJailbreak: false,
    abortController: null
  };
  users.set(server, user);

  // --- welcome ---
  server.send(JSON.stringify({
    type: 'welcome',
    userId: user.id,
    userColor: user.color,
    serverInfo: {
      cpp_available: false,
      ai_configured: !!(AI_SETTINGS.baseUrl || AI_SETTINGS.model || env.BASE_URL || env.AI)
    }
  }));

  // --- history ---
  server.send(JSON.stringify({ type: 'history', messages: messageHistory.slice(-100) }));

  broadcastUserList();

  server.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        // ============================================================
        // AI 聊天
        // ============================================================
        case 'ai_chat': {
          const content = (data.content || '').trim();
          if (!content) break;

          const model = AI_SETTINGS.model;
          if (!model) {
            server.send(JSON.stringify({ type: 'error', content: '请先选择 AI 模型' }));
            break;
          }

          const aiMessages = [];

          // 基础 system 提示词 — 始终在最前面
          aiMessages.push({ role: 'system', content: '你是酒馆AI助手，在局域网聊天室中与用户对话。你友善、乐于助人，用中文回复。' });

          // 世界书 — 按钮注入（插入到 system 之后、历史之前）
          if (user.pendingWorldbook) {
            user.pendingWorldbook = false;
            if (AI_SETTINGS.worldBook && AI_SETTINGS.worldBook.trim()) {
              aiMessages.push({ role: 'system', content: '【世界书】\n' + AI_SETTINGS.worldBook.trim() });
            }
          }

          // 破限提示词 — 按钮注入
          if (user.pendingJailbreak) {
            user.pendingJailbreak = false;
            if (AI_SETTINGS.jailbreakPrompt && AI_SETTINGS.jailbreakPrompt.trim()) {
              aiMessages.push({ role: 'system', content: AI_SETTINGS.jailbreakPrompt.trim() });
            }
          }

          // 添加历史消息
          if (Array.isArray(data.history)) {
            for (const msg of data.history) {
              if (msg.role === 'user' || msg.role === 'assistant') {
                aiMessages.push(msg);
              }
            }
          }

          // 当前用户消息
          aiMessages.push({ role: 'user', content: content });

          // 广播开始信号
          broadcast({
            type: 'ai_chunk_start',
            sender: 'AI · ' + model,
            senderColor: '#10a37f',
            timestamp: new Date().toISOString()
          });

          // 保存用户消息到历史
          const userMsg = {
            id: generateId(),
            type: 'message',
            userId: user.id,
            sender: user.name,
            senderColor: user.color,
            content: content,
            timestamp: new Date().toISOString(),
            is_ai_response: false
          };
          addMessage(userMsg);
          broadcast(userMsg);
          scheduleSaveHistory(env);

          // 流式调用
          const controller = new AbortController();
          user.abortController = controller;

          await callAIStream(
            aiMessages,
            model,
            env,
            (chunk) => { broadcast({ type: 'ai_chunk', chunk: chunk }); },
            (fullContent) => {
              broadcast({
                type: 'ai_chunk_done',
                content: fullContent,
                filtered: false,
                sender: 'AI · ' + model,
                senderColor: '#10a37f',
                timestamp: new Date().toISOString()
              });
              // 保存 AI 回复到历史
              const aiMsg = {
                id: generateId(),
                type: 'message',
                userId: 'ai',
                sender: 'AI · ' + model,
                senderColor: '#10a37f',
                content: fullContent,
                timestamp: new Date().toISOString(),
                is_ai_response: true,
                filtered: false
              };
              addMessage(aiMsg);
              scheduleSaveHistory(env);
            },
            (errMsg) => {
              broadcast({ type: 'ai_chunk_done', error: true, content: errMsg });
            },
            controller.signal
          );

          user.abortController = null;
          break;
        }

        // ============================================================
        // 用户改名
        // ============================================================
        case 'set_name': {
          const oldName = user.name;
          user.name = (data.name || '').trim().substring(0, 20) || '匿名';
          users.set(server, user);
          broadcast({ type: 'system', content: oldName + ' 改名为 ' + user.name });
          broadcastUserList();
          break;
        }

        // ============================================================
        // 编辑消息
        // ============================================================
        case 'edit_message': {
          const { messageId, newContent } = data;
          if (!messageId || !newContent) break;

          const idx = messageHistory.findIndex(m => m.id === messageId);
          if (idx === -1) {
            server.send(JSON.stringify({ type: 'error', content: '消息未找到' }));
            break;
          }
          // 只允许编辑自己的消息
          if (messageHistory[idx].userId !== user.id) {
            server.send(JSON.stringify({ type: 'error', content: '只能编辑自己的消息' }));
            break;
          }

          messageHistory[idx].content = newContent.trim();
          messageHistory[idx].edited = true;
          // 舍弃后续消息
          const removedCount = messageHistory.length - idx - 1;
          messageHistory.splice(idx + 1);

          broadcast({
            type: 'message_edited',
            messageId: messageId,
            newContent: newContent.trim(),
            edited: true,
            truncateAfter: true,
            userId: user.id
          });
          break;
        }

        // ============================================================
        // 停止生成
        // ============================================================
        case 'stop_generation': {
          if (user.abortController) {
            user.abortController.abort();
            user.abortController = null;
            server.send(JSON.stringify({ type: 'generation_stopped', content: '✅ 已停止生成' }));
          } else {
            server.send(JSON.stringify({ type: 'generation_stopped', content: '没有正在进行的生成' }));
          }
          break;
        }

        // ============================================================
        // 注入世界书 / 破限
        // ============================================================
        case 'inject_worldbook': {
          // 跨 isolate 同步：从 KV 重建读取设置
          await reloadFromKV(env);
          if (!AI_SETTINGS.worldBook || !AI_SETTINGS.worldBook.trim()) {
            server.send(JSON.stringify({ type: 'error', content: '世界书内容为空，请先在 AI 设置中填写并保存世界书' }));
            break;
          }
          user.pendingWorldbook = true;
          users.set(server, user);
          server.send(JSON.stringify({ type: 'inject_ack', content: '✅ 世界书已就绪，下一条消息生效' }));
          break;
        }
        case 'inject_jailbreak': {
          // 跨 isolate 同步：从 KV 重建读取设置
          await reloadFromKV(env);
          if (!AI_SETTINGS.jailbreakPrompt || !AI_SETTINGS.jailbreakPrompt.trim()) {
            server.send(JSON.stringify({ type: 'error', content: '破限提示词内容为空，请先在 AI 设置中填写并保存破限提示词' }));
            break;
          }
          user.pendingJailbreak = true;
          users.set(server, user);
          server.send(JSON.stringify({ type: 'inject_ack', content: '✅ 破限提示词已就绪，下一条消息生效' }));
          break;
        }

        // ============================================================
        // 压缩上下文
        // ============================================================
        case 'compress_context': {
          const hist = data.history || [];
          const result = compressHistory(hist);
          if (result.compressed) {
            server.send(JSON.stringify({
              type: 'compress_ack',
              content: '✅ 已压缩: ' + hist.length + ' 条消息 → ' + result.history.length + ' 条',
              history: result.history
            }));
          } else {
            server.send(JSON.stringify({ type: 'compress_ack', content: '对话较短，无需压缩' }));
          }
          break;
        }

        // ============================================================
        // Ping
        // ============================================================
        case 'ping':
          server.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          server.send(JSON.stringify({ type: 'error', content: '未知消息类型: ' + data.type }));
      }
    } catch (err) {
      server.send(JSON.stringify({ type: 'error', content: '服务器内部错误: ' + err.message }));
    }
  });

  server.addEventListener('close', () => {
    users.delete(server);
    broadcastUserList();
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ============================================================
// HTTP REST API
// ============================================================
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ---- 前端页面 ----
  if (path === '/' || path === '/index.html') {
    return serveFrontend();
  }

  // ---- API: 服务器信息 ----
  if (path === '/api/info') {
    return json({
      name: '酒馆',
      version: '2.0.0 (Worker)',
      online: users.size,
      uptime: 0,
      cpp_available: false
    });
  }

  // ---- API: 获取 AI 设置 ----
  if (path === '/api/ai/settings' && request.method === 'GET') {
    return json({
      baseUrl: AI_SETTINGS.baseUrl || '',
      apiKey: AI_SETTINGS.apiKey || '',
      model: AI_SETTINGS.model || '',
      worldBook: AI_SETTINGS.worldBook || '',
      jailbreakPrompt: AI_SETTINGS.jailbreakPrompt || ''
    });
  }

  // ---- API: 保存 AI 设置 ----
  if (path === '/api/ai/settings' && request.method === 'POST') {
    try {
      const body = await request.json();
      if (body.baseUrl !== undefined) AI_SETTINGS.baseUrl = body.baseUrl;
      if (body.apiKey !== undefined) AI_SETTINGS.apiKey = body.apiKey;
      if (body.model !== undefined) AI_SETTINGS.model = body.model;
      if (body.worldBook !== undefined) AI_SETTINGS.worldBook = body.worldBook;
      if (body.jailbreakPrompt !== undefined) AI_SETTINGS.jailbreakPrompt = body.jailbreakPrompt;

      // 以环境变量为 fallback
      if (!AI_SETTINGS.baseUrl && env.BASE_URL) AI_SETTINGS.baseUrl = env.BASE_URL;
      if (!AI_SETTINGS.apiKey && env.API_KEY) AI_SETTINGS.apiKey = env.API_KEY;

      await saveSettingsToKV(env);
      return json({ success: true });
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  // ---- API: 获取模型列表 ----
  if (path === '/api/ai/models' && request.method === 'POST') {
    try {
      const body = await request.json();
      const baseUrl = body.baseUrl || AI_SETTINGS.baseUrl || env.BASE_URL;
      const apiKey = body.apiKey || AI_SETTINGS.apiKey || env.API_KEY;

      let models = [];

      // 有 Workers AI binding 时添加 @cf 模型
      if (env.AI) {
        models.push(
          { id: '@cf/meta/llama-3.1-8b-instruct', owned_by: 'Meta (CF)' },
          { id: '@cf/meta/llama-3-8b-instruct', owned_by: 'Meta (CF)' },
          { id: '@cf/mistral/mistral-7b-instruct-v0.1', owned_by: 'Mistral (CF)' },
          { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', owned_by: 'DeepSeek (CF)' },
          { id: '@cf/qwen/qwen2-7b-instruct', owned_by: 'Qwen (CF)' },
          { id: '@cf/tiiuae/falcon-7b-instruct', owned_by: 'TII (CF)' }
        );
      }

      // 从外部 API 获取
      if (baseUrl && apiKey) {
        try {
          const resp = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
            headers: { 'Authorization': 'Bearer ' + apiKey }
          });
          if (resp.ok) {
            const d = await resp.json();
            const ext = (d.data || d || []).filter(m => m.id).map(m => ({
              id: m.id,
              owned_by: m.owned_by || 'External'
            }));
            const exist = new Set(models.map(m => m.id));
            for (const m of ext) {
              if (!exist.has(m.id)) { models.push(m); exist.add(m.id); }
            }
          }
        } catch (_) {}
      }

      // 保底
      if (models.length === 0) {
        models = [
          { id: 'gpt-4o-mini', owned_by: 'OpenAI' },
          { id: 'gpt-4o', owned_by: 'OpenAI' },
          { id: 'gpt-3.5-turbo', owned_by: 'OpenAI' }
        ];
      }

      return json({ success: true, models });
    } catch (e) {
      return json({ success: false, error: e.message });
    }
  }

  // ---- API: 获取消息历史 ----
  if (path === '/api/messages') {
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, MAX_HISTORY);
    return json(messageHistory.slice(-limit));
  }

  // ---- API: 清空消息 ----
  if (path === '/api/messages/clear' && request.method === 'POST') {
    clearHistory();
    await saveHistoryToKV(env);
    broadcast({ type: 'history_cleared' });
    return json({ success: true });
  }

  // ---- API: 导出对话 ----
  if (path === '/api/export') {
    return new Response(JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), messages: messageHistory
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="jiuguan_chat_' + new Date().toISOString().slice(0,10) + '.json"'
      }
    });
  }

  // ---- API: 导入对话 ----
  if (path === '/api/import' && request.method === 'POST') {
    try {
      const body = await request.json();
      let msgs = [];
      if (Array.isArray(body)) msgs = body;
      else if (body && Array.isArray(body.messages)) msgs = body.messages;
      else return json({ error: '格式不正确，请提交导出文件' }, 400);

      messageHistory.length = 0;
      for (const m of msgs) addMessage(m);
      scheduleSaveHistory(env);
      broadcast({ type: 'history_imported', messages: messageHistory.slice() });
      return json({ success: true, count: messageHistory.length });
    } catch (e) {
      return json({ error: '导入失败: ' + e.message }, 400);
    }
  }

  // ---- API: 在线用户 ----
  if (path === '/api/users') {
    const list = [];
    for (const [, info] of users) {
      list.push({ id: info.id, name: info.name, color: info.color, joinTime: info.joinTime });
    }
    return json(list);
  }

  return new Response('Not Found', { status: 404 });
}

// ============================================================
// 前端页面
// ============================================================
function serveFrontend() {
  return new Response(FRONTEND_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ============================================================
// Worker 入口
// ============================================================
export default {
  async fetch(request, env) {
    // 初始化 AI 设置（环境变量 fallback + KV）
    await loadFromKV(env);
    if (!AI_SETTINGS.baseUrl && env.BASE_URL) AI_SETTINGS.baseUrl = env.BASE_URL;
    if (!AI_SETTINGS.apiKey && env.API_KEY) AI_SETTINGS.apiKey = env.API_KEY;

    const url = new URL(request.url);

    // WebSocket 升级
    if (url.pathname === '/ws') {
      return handleWebSocket(request, env);
    }

    return handleRequest(request, env);
  }
};

// ============================================================
// 前端 HTML (嵌入)
// ============================================================
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>🍺 酒馆</title>
    <style>
        :root {
            --bg: #1a1a2e;
            --surface: #16213e;
            --surface2: #0f3460;
            --accent: #e94560;
            --text: #eaeaea;
            --text-dim: #8892b0;
            --msg-self: #1a3a5c;
            --msg-other: #1e2a45;
            --system: #5a6785;
            --border: #2a3a5c;
            --radius: 12px;
            --shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
            background: var(--bg); color: var(--text); height: 100vh; overflow: hidden;
        }
        .app { display:flex; height:100vh; max-width:1200px; margin:0 auto; }
        .sidebar { width:260px; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink:0; }
        .main { flex:1; display:flex; flex-direction:column; min-width:0; }
        .sidebar-header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; }
        .sidebar-header h1 { font-size:20px; font-weight:700; background:linear-gradient(135deg,var(--accent),#ff6b6b); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
        .sidebar-header .badge { font-size:11px; background:var(--accent); color:#fff; padding:2px 8px; border-radius:10px; -webkit-text-fill-color:#fff; }
        .connection-status { padding:10px 20px; display:flex; align-items:center; gap:8px; font-size:13px; border-bottom:1px solid var(--border); }
        .status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .status-dot.connected { background:#2ecc71; box-shadow:0 0 6px #2ecc71; }
        .status-dot.disconnected { background:#e74c3c; box-shadow:0 0 6px #e74c3c; }
        .status-dot.connecting { background:#f39c12; animation:pulse 1s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        .user-section { padding:12px 20px; border-bottom:1px solid var(--border); }
        .user-section label { font-size:12px; color:var(--text-dim); display:block; margin-bottom:6px; }
        .name-input-group { display:flex; gap:6px; }
        .name-input-group input { flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font-size:13px; outline:none; transition:border .2s; }
        .name-input-group input:focus { border-color:var(--accent); }
        .name-input-group button { padding:8px 12px; border:none; border-radius:6px; background:var(--accent); color:#fff; font-size:13px; cursor:pointer; transition:opacity .2s; white-space:nowrap; }
        .name-input-group button:hover { opacity:.85; }
        .ai-section { padding:12px 20px; border-bottom:1px solid var(--border); }
        .ai-section .section-header { display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; }
        .ai-section .section-header h3 { font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; }
        .ai-section .section-header .toggle-icon { font-size:10px; color:var(--text-dim); transition:transform .2s; }
        .ai-section .section-header .toggle-icon.open { transform:rotate(90deg); }
        .ai-section .ai-body { display:none; margin-top:10px; }
        .ai-section .ai-body.open { display:block; }
        .ai-section label { font-size:12px; color:var(--text-dim); display:block; margin-bottom:4px; margin-top:10px; }
        .ai-section label:first-child { margin-top:0; }
        .ai-section input, .ai-section select { width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font-size:13px; outline:none; transition:border .2s; box-sizing:border-box; }
        .ai-section input:focus, .ai-section select:focus { border-color:var(--accent); }
        .ai-section .btn-row { display:flex; gap:6px; margin-top:10px; }
        .ai-section .btn-row button { flex:1; padding:8px 0; border:none; border-radius:6px; font-size:13px; cursor:pointer; transition:opacity .2s; white-space:nowrap; }
        .ai-section .btn-row button:hover { opacity:.85; }
        .ai-section .btn-primary { background:var(--accent); color:#fff; }
        .ai-section .btn-secondary { background:var(--surface2); color:var(--text); }
        .ai-section .btn-secondary:disabled { opacity:.4; cursor:not-allowed; }
        .ai-section .ai-status { font-size:11px; margin-top:8px; padding:6px 8px; border-radius:4px; display:none; }
        .ai-section .ai-status.ok { display:block; background:rgba(46,204,113,.1); color:#2ecc71; }
        .ai-section .ai-status.err { display:block; background:rgba(233,69,96,.1); color:var(--accent); }
        .ai-section .ai-status.loading { display:block; background:rgba(243,156,18,.1); color:#f39c12; }
        .user-list-section { flex:1; overflow-y:auto; padding:12px 0; }
        .user-list-section h3 { font-size:12px; color:var(--text-dim); padding:0 20px 8px; text-transform:uppercase; letter-spacing:1px; }
        .user-item { display:flex; align-items:center; gap:10px; padding:8px 20px; font-size:14px; transition:background .15s; }
        .user-item:hover { background:rgba(255,255,255,.03); }
        .user-item .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
        .user-item .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .user-item .self-tag { font-size:10px; background:rgba(255,255,255,.1); padding:1px 6px; border-radius:4px; color:var(--text-dim); }
        .sidebar-actions { padding:10px 20px; border-top:1px solid var(--border); }
        .sidebar-btn { display:block; width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:6px; background:transparent; color:var(--text); font-size:12px; cursor:pointer; transition:all .2s; text-align:center; }
        .sidebar-btn:hover { background:rgba(255,255,255,.05); }
        .sidebar-btn.danger { color:#e74c3c; border-color:#e74c3c44; }
        .sidebar-btn.danger:hover { background:#e74c3c22; border-color:#e74c3c; }
        .inject-btn { display:block; width:100%; padding:6px 10px; margin-top:6px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--accent); font-size:11px; cursor:pointer; transition:all .2s; text-align:center; }
        .inject-btn:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
        .msg .edit-area{display:none;margin-top:4px;}.msg.editing .content{display:none;}.msg.editing .edit-area{display:block;}.msg .edit-input{width:100%;padding:6px 8px;border:1px solid var(--accent);border-radius:4px;background:var(--bg);color:var(--text);font-size:13px;outline:none;resize:vertical;font-family:inherit;box-sizing:border-box;}.msg .edit-hint{font-size:10px;color:var(--text-dim);margin-top:3px;}.msg .edit-btn{font-size:10px;color:var(--accent);cursor:pointer;margin-left:6px;opacity:.5;}.msg .edit-btn:hover{opacity:1;}
        .sidebar-footer { padding:12px 20px; border-top:1px solid var(--border); font-size:12px; color:var(--text-dim); text-align:center; }
        .chat-header { padding:14px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
        .chat-header h2 { font-size:16px; font-weight:600; }
        .chat-header .info { font-size:13px; color:var(--text-dim); }
        .messages { flex:1; overflow-y:auto; padding:16px 24px; display:flex; flex-direction:column; gap:8px; }
        .msg { max-width:80%; padding:10px 16px; border-radius:var(--radius); position:relative; word-wrap:break-word; line-height:1.5; }
        .msg.other { align-self:flex-start; background:var(--msg-other); border-bottom-left-radius:4px; }
        .msg.self { align-self:flex-end; background:var(--msg-self); border-bottom-right-radius:4px; }
        .msg .sender { font-size:12px; font-weight:600; margin-bottom:4px; }
        .msg .time { font-size:11px; color:var(--text-dim); margin-top:4px; text-align:right; }
        .msg .filter-tag { font-size:10px; background:rgba(233,69,96,.2); color:var(--accent); padding:1px 6px; border-radius:4px; margin-left:6px; }
        .msg .ai-tag { font-size:10px; background:rgba(16,163,127,.2); color:#10a37f; padding:1px 6px; border-radius:4px; margin-left:6px; }
        .msg.ai-response { border-left:3px solid #10a37f; }
        .msg.system { align-self:center; background:transparent; font-size:12px; color:var(--system); max-width:100%; text-align:center; padding:4px 12px; }
        .msg.streaming { border-left:3px solid #10a37f; }
        .msg.streaming .sender .ai-tag { animation:pulse 1s infinite; }
        .stream-cursor { animation:blink 0.8s step-end infinite; color:#10a37f; font-size:14px; }
        @keyframes blink { 50%{opacity:0} }
        .msg.system .time { display:none; }
        .input-area { padding:12px 24px 20px; border-top:1px solid var(--border); display:flex; gap:10px; align-items:flex-end; }
        .input-area textarea { flex:1; padding:12px 16px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); font-size:14px; resize:none; outline:none; min-height:44px; max-height:120px; line-height:1.4; font-family:inherit; transition:border .2s; }
        .input-area textarea:focus { border-color:var(--accent); }
        .input-area textarea::placeholder { color:var(--text-dim); }
        .input-area .send-btn { padding:12px 24px; border:none; border-radius:var(--radius); background:var(--accent); color:#fff; font-size:15px; cursor:pointer; transition:opacity .2s,transform .1s; height:44px; display:flex; align-items:center; gap:6px; white-space:nowrap; }
        .input-area .send-btn:hover { opacity:.85; }
        .input-area .send-btn:active { transform:scale(.97); }
        .input-area .send-btn:disabled { opacity:.4; cursor:not-allowed; }
        .connect-overlay { display:none; position:fixed; inset:0; background:var(--bg); z-index:1000; justify-content:center; align-items:center; flex-direction:column; gap:16px; }
        .connect-overlay.show { display:flex; }
        .connect-overlay h2 { font-size:28px; color:var(--text); }
        .connect-overlay p { color:var(--text-dim); font-size:15px; }
        .connect-overlay .loader { width:40px; height:40px; border:3px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
        @keyframes spin { to{transform:rotate(360deg)} }
        .connect-overlay .error-msg { color:var(--accent); font-size:14px; display:none; }
        .connect-overlay .retry-btn { display:none; padding:10px 24px; border:1px solid var(--accent); border-radius:8px; background:transparent; color:var(--accent); font-size:14px; cursor:pointer; transition:background .2s; }
        .connect-overlay .retry-btn:hover { background:rgba(233,69,96,.1); }
        .connect-form { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:24px 32px; width:360px; max-width:90vw; display:flex; flex-direction:column; gap:12px; }
        .connect-form label { font-size:13px; color:var(--text-dim); }
        .connect-form input { padding:10px 14px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font-size:14px; outline:none; width:100%; }
        .connect-form input:focus { border-color:var(--accent); }
        .connect-form .hint { font-size:12px; color:var(--text-dim); }
        .connect-form button { padding:10px; border:none; border-radius:6px; background:var(--accent); color:#fff; font-size:15px; cursor:pointer; font-weight:600; }
        .connect-form button:hover { opacity:.85; }
        @media (max-width:768px) {
            .sidebar { display:none; }
            .sidebar.mobile-show { display:flex; position:fixed; inset:0; width:100%; z-index:100; border-right:none; }
            .messages { padding:12px 16px; }
            .input-area { padding:10px 16px 16px; }
            .msg { max-width:90%; }
            .mobile-toggle { display:flex !important; }
        }
        .mobile-toggle { display:none; background:none; border:none; color:var(--text); font-size:20px; cursor:pointer; padding:4px; }
        ::-webkit-scrollbar { width:6px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
        ::-webkit-scrollbar-thumb:hover { background:var(--text-dim); }
    </style>
</head>
<body>
<div class="connect-overlay show" id="connectOverlay">
    <div class="loader" id="connectLoader"></div>
    <h2>🍺 连接酒馆</h2>
    <p id="connectStatus">正在连接服务器...</p>
    <div class="error-msg" id="connectError"></div>
    <button class="retry-btn" id="retryBtn">重新连接</button>
</div>
<div class="app">
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-header"><h1>🍺 酒馆</h1><span class="badge">v2</span></div>
        <div class="connection-status"><span class="status-dot disconnected" id="statusDot"></span><span id="statusText">未连接</span></div>
        <div class="user-section">
            <label>你的名字</label>
            <div class="name-input-group">
                <input type="text" id="nameInput" maxlength="20" placeholder="输入昵称...">
                <button id="nameBtn">改名</button>
            </div>
        </div>
        <div class="ai-section">
            <div class="section-header" id="aiSectionToggle">
                <h3>🤖 AI 连接</h3>
                <span class="toggle-icon" id="aiToggleIcon">▶</span>
            </div>
            <div class="ai-body" id="aiBody">
                <label>API Base URL</label>
                <input type="url" id="aiBaseUrl" placeholder="https://api.openai.com" autocomplete="off">
                <label>API Key</label>
                <input type="password" id="aiApiKey" placeholder="sk-..." autocomplete="off">
                <div class="btn-row">
                    <button class="btn-secondary" id="aiFetchModelsBtn">🔄 获取模型</button>
                    <button class="btn-primary" id="aiSaveBtn">💾 保存</button>
                </div>
                <label>选择模型</label>
                <select id="aiModelSelect"><option value="">— 先获取模型列表 —</option></select>
                <div class="ai-status" id="aiStatus"></div>
                <label style="margin-top:14px;">☍ 世界书 (World Book)</label>
                <textarea id="worldBookInput" rows="3" placeholder="输入世界观设定、角色描述、背景故事等...\n这些内容将在每个用户的第一次提问时自动注入到 AI 上下文中"></textarea>
                <button class="inject-btn" id="injectWbBtn">📖 注入世界书</button>
                <label style="margin-top:10px;">⚠ 破限提示词 (Jailbreak)</label>
                <textarea id="jailbreakInput" rows="2" placeholder="输入用于突破 AI 限制的系统提示词..."></textarea>
                <button class="inject-btn" id="injectJbBtn">⚡ 注入破限提示词</button>
            </div>
        </div>
        <div class="user-list-section">
            <h3>在线酒友 <span id="onlineCount">(0)</span></h3>
            <div id="userList"></div>
        </div>
        <div class="sidebar-actions">
            <div class="ctx-stats" id="ctxStats" style="display:none;padding:8px 20px;font-size:11px;color:var(--text-dim);border-top:1px solid var(--border);"></div>
            <div class="btn-row" style="padding:8px 20px 0;gap:6px;">
                <button class="sidebar-btn" id="exportBtn">📤 导出</button>
                <button class="sidebar-btn" id="importBtn">📥 导入</button>
            </div>
            <div class="btn-row" style="padding:4px 20px 10px;gap:6px;">
                <button class="sidebar-btn" id="compressBtn">🗜 压缩上下文</button>
            </div>
            <button class="sidebar-btn danger" id="clearHistoryBtn">🗑 删除聊天记录</button>
        </div>
        <div class="sidebar-footer">🍺 酒馆 · Worker 版</div>
    </aside>
    <main class="main">
        <div class="chat-header">
            <div style="display:flex;align-items:center;gap:10px;">
                <button class="mobile-toggle" id="menuToggle">☰</button>
                <h2>🍺 大堂</h2>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
                <span class="info" id="cppStatus">C++: ❌</span>
                <span class="info" id="onlineHeaderCount">0 人在线</span>
            </div>
        </div>
        <div class="messages" id="messages"></div>
        <div class="input-area">
            <textarea id="msgInput" rows="1" placeholder="向 AI 提问... (Enter 发送)" maxlength="2000"></textarea>
            <button class="send-btn" id="sendBtn"><span>➤</span> 发送</button>
            <button class="stop-btn" id="stopBtn" style="display:none;">⏹</button>
        </div>
    </main>
</div>
<script>
(function(){
    'use strict';
    const state = {
        ws: null, userId: null, userName: '游客', userColor: '#e94560',
        connected: false, users: [], messages: [],
        aiConfigured: false, aiModels: [], aiHistory: [],
        aiBaseUrl: '', aiApiKey: '', aiModel: '',
        worldBook: '', jailbreakPrompt: '',
        abortController: null,
        _streamMsgEl: null, _streamFullContent: ''
    };
    const $ = function(s){ return document.querySelector(s); };
    const dom = {
        overlay: $('#connectOverlay'), loader: $('#connectLoader'),
        connectStatus: $('#connectStatus'), connectError: $('#connectError'), retryBtn: $('#retryBtn'),
        sidebar: $('#sidebar'), menuToggle: $('#menuToggle'),
        statusDot: $('#statusDot'), statusText: $('#statusText'),
        nameInput: $('#nameInput'), nameBtn: $('#nameBtn'),
        userList: $('#userList'), onlineCount: $('#onlineCount'),
        messages: $('#messages'), msgInput: $('#msgInput'), sendBtn: $('#sendBtn'),
        cppStatus: $('#cppStatus'), onlineHeaderCount: $('#onlineHeaderCount'),
        aiSectionToggle: $('#aiSectionToggle'), aiBody: $('#aiBody'), aiToggleIcon: $('#aiToggleIcon'),
        aiBaseUrl: $('#aiBaseUrl'), aiApiKey: $('#aiApiKey'),
        aiFetchModelsBtn: $('#aiFetchModelsBtn'), aiSaveBtn: $('#aiSaveBtn'),
        aiModelSelect: $('#aiModelSelect'), aiStatus: $('#aiStatus'),
        worldBookInput: $('#worldBookInput'), jailbreakInput: $('#jailbreakInput'),
        ctxStats: $('#ctxStats'), exportBtn: $('#exportBtn'), importBtn: $('#importBtn'),
        compressBtn: $('#compressBtn'), stopBtn: $('#stopBtn')
    };
    function getWsUrl(){ return 'wss://' + location.host + '/ws'; }
    function connect(){
        showConnecting('正在连接服务器...');
        var url = getWsUrl();
        var ws;
        try { ws = new WebSocket(url); } catch(e){ showError('无法创建 WebSocket 连接'); return; }
        state.ws = ws;
        ws.onopen = function(){
            state.connected = true;
            hideOverlay();
            updateConnectionUI(true);
            dom.sendBtn.disabled = false;
            dom.msgInput.focus();
        };
        ws.onmessage = function(ev){
            try { handleMessage(JSON.parse(ev.data)); } catch(e){ console.warn('[WS] 解析失败', e); }
        };
        ws.onclose = function(){
            state.connected = false;
            if(state.ws === ws){ updateConnectionUI(false); showError('连接断开，正在重连...'); setTimeout(connect, 3000); }
        };
        ws.onerror = function(){
            if(state.ws === ws && ws.readyState === WebSocket.CONNECTING) showError('无法连接到服务器');
        };
    }
    function handleMessage(data){
        switch(data.type){
            case 'welcome':
                state.userId = data.userId;
                dom.cppStatus.textContent = 'C++: ❌';
                state.aiConfigured = data.serverInfo.ai_configured || false;
                loadAISettingsFromServer();
                break;
            case 'history':
                if(Array.isArray(data.messages)){
                    state.messages = data.messages;
                    dom.messages.innerHTML = '';
                    data.messages.forEach(addMessageToDOM);
                    scrollToBottom();
                }
                break;
            case 'message':
                state.messages.push(data);
                addMessageToDOM(data);
                scrollToBottom();
                if(data.is_ai_response && data.content){
                    state.aiHistory.push({ role: 'assistant', content: data.content });
                    if(state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
                }
                break;
            case 'ai_chunk_start':
                dom.stopBtn.style.display = 'block';
                state._streamMsgEl = null;
                var el = document.createElement('div');
                el.className = 'msg other ai-response streaming';
                el.innerHTML = '<div class="sender" style="color:' + (data.senderColor || '#10a37f') + '">' + esc(data.sender || 'AI') + '<span class="ai-tag">AI</span></div><div class="stream-content"></div><div class="time">' + fmt(data.timestamp) + ' <span class="stream-cursor">▌</span></div>';
                dom.messages.appendChild(el);
                state._streamMsgEl = el;
                state._streamFullContent = '';
                scrollToBottom();
                break;
            case 'ai_chunk':
                if (!state._streamMsgEl) break;
                state._streamFullContent += data.chunk || '';
                var sc = state._streamMsgEl.querySelector('.stream-content');
                if (sc) { sc.textContent = state._streamFullContent; scrollToBottom(); }
                break;
            case 'ai_chunk_done':
                if (state._streamMsgEl) {
                    if (data.error) {
                        if (state._streamMsgEl.parentNode) state._streamMsgEl.parentNode.removeChild(state._streamMsgEl);
                    } else {
                        var sc = state._streamMsgEl.querySelector('.stream-content');
                        var cursor = state._streamMsgEl.querySelector('.stream-cursor');
                        if (sc) sc.textContent = data.content || '';
                        if (cursor) cursor.style.display = 'none';
                        state._streamMsgEl.classList.remove('streaming');
                        state.aiHistory.push({ role: 'assistant', content: data.content || '' });
                        if (state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
                    }
                    state._streamMsgEl = null;
                    scrollToBottom();
                }
                dom.stopBtn.style.display = 'none';
                updateCtxStats();
                break;
            case 'system': addSystemMessage(data.content); scrollToBottom(); break;
            case 'userlist': state.users = data.users || []; updateUserList(); break;
            case 'message_edited':
                var meEl = document.querySelector('[data-msgid="' + data.messageId + '"]');
                if(meEl){
                    meEl.querySelector('.content').textContent = data.newContent;
                    meEl.querySelector('.edit-input').value = data.newContent;
                }
                if(data.truncateAfter){
                    var allMsgs = dom.messages.querySelectorAll('.msg:not(.system)');
                    var meIdx = null;
                    for(var mi=0; mi<allMsgs.length; mi++){
                        if(allMsgs[mi].getAttribute('data-msgid') === data.messageId){ meIdx = mi; break; }
                    }
                    if(meIdx !== null){
                        while(dom.messages.lastChild && dom.messages.lastChild !== allMsgs[meIdx]){
                            dom.messages.removeChild(dom.messages.lastChild);
                        }
                        var histIdx = state.aiHistory.findIndex(function(h){ return h.role === 'user' && h.content === data.newContent; });
                        if(histIdx >= 0) state.aiHistory = state.aiHistory.slice(0, histIdx + 1);
                        else state.aiHistory = [];
                    }
                }
                break;
            case 'history_imported':
                dom.messages.innerHTML = ''; state.aiHistory = [];
                if(data.messages){ data.messages.forEach(function(m){ addMessageToDOM(m); if(m.is_ai_response && m.content) state.aiHistory.push({role:'assistant',content:m.content}); else if(!m.is_ai_response && m.content && m.userId !== 'ai') state.aiHistory.push({role:'user',content:m.content}); }); }
                addSystemMessage('✅ 已导入 ' + (data.messages ? data.messages.length : 0) + ' 条记录');
                updateCtxStats();
                break;
            case 'generation_stopped': addSystemMessage(data.content); dom.stopBtn.style.display = 'none'; break;
            case 'compress_ack': addSystemMessage(data.content); if(data.history) state.aiHistory = data.history; updateCtxStats(); break;
            case 'inject_ack': addSystemMessage(data.content); break;
            case 'history_cleared': dom.messages.innerHTML = ''; state.aiHistory = []; addSystemMessage('🗑 聊天记录已被清空'); break;
            case 'error': addSystemMessage('❌ ' + data.content); break;
        }
    }
    function addMessageToDOM(msg){
        var el = document.createElement('div');
        if(msg.type === 'system'){ el.className = 'msg system'; el.textContent = msg.content; dom.messages.appendChild(el); return; }
        if(msg.id) el.setAttribute('data-msgid', msg.id);
        var isSelf = msg.userId === state.userId;
        var cn = 'msg ' + (isSelf ? 'self' : 'other');
        if(msg.is_ai_response) cn += ' ai-response';
        el.className = cn;
        var sc = msg.senderColor || '#aaa';
        var tags = '';
        if(msg.filtered) tags += '<span class="filter-tag">已过滤</span>';
        if(msg.is_ai_response) tags += '<span class="ai-tag">AI</span>';
        el.innerHTML = '<div class="sender" style="color:' + sc + '">' + esc(msg.sender) + tags + '<span class="edit-btn">✏</span></div><div class="content">' + esc(msg.content) + '</div><div class="edit-area"><textarea class="edit-input" rows="2">' + esc(msg.content) + '</textarea><div class="edit-hint">Enter 保存并舍弃后续 | Escape 取消</div></div><div class="time">' + fmt(msg.timestamp) + '</div>';
        dom.messages.appendChild(el);
    }
    function addSystemMessage(t){ var el = document.createElement('div'); el.className = 'msg system'; el.textContent = t; dom.messages.appendChild(el); }
    function updateUserList(){
        dom.userList.innerHTML = '';
        dom.onlineCount.textContent = '(' + state.users.length + ')';
        dom.onlineHeaderCount.textContent = state.users.length + ' 人在线';
        state.users.forEach(function(u){
            var el = document.createElement('div'); el.className = 'user-item';
            var selfTag = u.id === state.userId ? '<span class="self-tag">我</span>' : '';
            el.innerHTML = '<span class="dot" style="background:' + u.color + '"></span><span class="name">' + esc(u.name) + '</span>' + selfTag;
            dom.userList.appendChild(el);
        });
    }
    function scrollToBottom(){ setTimeout(function(){ dom.messages.scrollTop = dom.messages.scrollHeight; }, 10); }
    function showConnecting(t){ dom.overlay.classList.add('show'); dom.connectStatus.textContent = t; dom.connectError.style.display = 'none'; dom.retryBtn.style.display = 'none'; }
    function hideOverlay(){ dom.overlay.classList.remove('show'); }
    function showError(t){ dom.overlay.classList.add('show'); dom.connectStatus.textContent = t; dom.connectError.style.display = 'none'; dom.retryBtn.style.display = 'block'; }
    function updateConnectionUI(on){
        dom.statusDot.className = 'status-dot ' + (on ? 'connected' : 'disconnected');
        dom.statusText.textContent = on ? '已连接' : '未连接';
    }
    function sendChatMessage(){
        var content = dom.msgInput.value.trim();
        if(!content || !state.connected) return;
        state.ws.send(JSON.stringify({ type: 'ai_chat', content: content, history: state.aiHistory }));
        state.aiHistory.push({ role: 'user', content: content });
        if(state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
        dom.msgInput.value = '';
        dom.msgInput.style.height = 'auto';
    }
    function setName(){
        var name = dom.nameInput.value.trim().substring(0, 20);
        if(!name) return;
        state.userName = name;
        if(state.connected) state.ws.send(JSON.stringify({ type: 'set_name', name: name }));
    }
    function esc(s){ var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function fmt(iso){
        if(!iso) return '';
        try { var d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); } catch(_){ return ''; }
    }
    function pad(n){ return n < 10 ? '0' + n : '' + n; }
    function loadAISettingsFromServer(){
        fetch('/api/ai/settings').then(function(r){ return r.json(); }).then(function(data){
            state.aiBaseUrl = data.baseUrl || '';
            state.aiModel = data.model || '';
            dom.aiBaseUrl.value = state.aiBaseUrl;
            if (data.apiKey) {
                state.aiApiKey = data.apiKey;
                dom.aiApiKey.value = data.apiKey;
                localStorage.setItem('jiuguan_ai_apikey', data.apiKey);
            } else {
                var k = localStorage.getItem('jiuguan_ai_apikey');
                if(k){ state.aiApiKey = k; dom.aiApiKey.value = k; }
            }
            state.worldBook = data.worldBook || '';
            state.jailbreakPrompt = data.jailbreakPrompt || '';
            if(data.worldBook !== undefined) dom.worldBookInput.value = data.worldBook || '';
            if(data.jailbreakPrompt !== undefined) dom.jailbreakInput.value = data.jailbreakPrompt || '';
            if(state.aiModel){ updateModelSelect([{ id: state.aiModel }]); dom.aiModelSelect.value = state.aiModel; }
            updateAIStatus();
        }).catch(function(){});
    }
    function saveAISettings(){
        var baseUrl = dom.aiBaseUrl.value.trim();
        var apiKey = dom.aiApiKey.value.trim();
        var model = dom.aiModelSelect.value;
        var worldBook = dom.worldBookInput ? dom.worldBookInput.value : '';
        var jailbreakPrompt = dom.jailbreakInput ? dom.jailbreakInput.value : '';
        if(!baseUrl){ showAIStatus('请先输入 API Base URL', 'err'); return; }
        state.aiBaseUrl = baseUrl; state.aiModel = model; state.aiApiKey = apiKey;
        localStorage.setItem('jiuguan_ai_apikey', apiKey);
        fetch('/api/ai/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: baseUrl, apiKey: apiKey, model: model, worldBook: worldBook, jailbreakPrompt: jailbreakPrompt })
        }).then(function(r){ return r.json(); }).then(function(data){
            if(data.success){ state.aiConfigured = !!(baseUrl && model); showAIStatus('✅ 已保存，立即生效', 'ok'); setTimeout(hideAIStatus, 2000); if(window.innerWidth<=768){ dom.sidebar.classList.remove('mobile-show'); dom.aiBody.classList.remove('open'); dom.aiToggleIcon.classList.remove('open'); } }
            else { showAIStatus('❌ ' + (data.error || '保存失败'), 'err'); }
        }).catch(function(err){ showAIStatus('❌ ' + err.message, 'err'); });
    }
    function fetchModels(){
        var baseUrl = dom.aiBaseUrl.value.trim();
        var apiKey = dom.aiApiKey.value.trim();
        if(!baseUrl){ showAIStatus('请先输入 API Base URL', 'err'); return; }
        dom.aiFetchModelsBtn.disabled = true;
        dom.aiFetchModelsBtn.textContent = '⏳ 获取中...';
        showAIStatus('正在获取模型列表...', 'loading');
        fetch('/api/ai/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: baseUrl, apiKey: apiKey })
        }).then(function(r){ return r.json(); }).then(function(data){
            dom.aiFetchModelsBtn.disabled = false;
            dom.aiFetchModelsBtn.textContent = '🔄 获取模型';
            if(data.success && data.models && data.models.length > 0){
                state.aiModels = data.models;
                updateModelSelect(data.models);
                if(state.aiModel && data.models.some(function(m){ return m.id === state.aiModel; })) dom.aiModelSelect.value = state.aiModel;
                showAIStatus('✅ ' + data.models.length + ' 个模型', 'ok');
                setTimeout(hideAIStatus, 2000);
            } else { showAIStatus('❌ ' + (data.error || '获取失败'), 'err'); }
        }).catch(function(err){
            dom.aiFetchModelsBtn.disabled = false;
            dom.aiFetchModelsBtn.textContent = '🔄 获取模型';
            showAIStatus('❌ ' + err.message, 'err');
        });
    }
    function updateModelSelect(models){
        var sel = dom.aiModelSelect;
        sel.innerHTML = '';
        if(models.length === 0){ sel.innerHTML = '<option value="">— 先获取模型列表 —</option>'; return; }
        var eo = document.createElement('option'); eo.value = ''; eo.textContent = '— 请选择模型 —'; sel.appendChild(eo);
        models.forEach(function(m){
            var o = document.createElement('option'); o.value = m.id; o.textContent = m.id + (m.owned_by ? ' (' + m.owned_by + ')' : ''); sel.appendChild(o);
        });
    }
    function showAIStatus(t, type){ dom.aiStatus.textContent = t; dom.aiStatus.className = 'ai-status ' + type; dom.aiStatus.style.display = 'block'; }
    function hideAIStatus(){ dom.aiStatus.style.display = 'none'; }
    function updateAIStatus(){
        if(state.aiBaseUrl && state.aiModel){ showAIStatus('✅ AI: ' + state.aiModel, 'ok'); }
        else if(state.aiBaseUrl){ showAIStatus('⚠️ 请选择模型', 'err'); }
        else { hideAIStatus(); }
    }
    dom.retryBtn.addEventListener('click', function(){ if(state.ws) try{ state.ws.close(); }catch(_){} connect(); });
    dom.sendBtn.addEventListener('click', sendChatMessage);
    dom.msgInput.addEventListener('keydown', function(e){ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendChatMessage(); } });
    dom.msgInput.addEventListener('input', function(){ dom.msgInput.style.height = 'auto'; dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 120) + 'px'; });
    dom.nameBtn.addEventListener('click', setName);
    dom.nameInput.addEventListener('keydown', function(e){ if(e.key === 'Enter') setName(); });
    dom.menuToggle.addEventListener('click', function(){ dom.sidebar.classList.toggle('mobile-show'); });
    dom.messages.addEventListener('click', function(e){
        dom.sidebar.classList.remove('mobile-show');
        var btn = e.target.closest('.edit-btn');
        if(btn){
            var el = btn.closest('.msg');
            if(el && el.classList.contains('self')){
                el.classList.add('editing');
                var ta = el.querySelector('.edit-input');
                if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
            }
            return;
        }
    });
    dom.messages.addEventListener('keydown', function(e){
        var editInput = e.target.closest('.edit-input');
        if(!editInput) return;
        var el = editInput.closest('.msg');
        if(!el) return;
        if(e.key === 'Enter' && !e.shiftKey){
            e.preventDefault();
            var newContent = editInput.value.trim();
            if(!newContent || !state.ws) return;
            var msgId = el.getAttribute('data-msgid');
            if(!msgId) return;
            el.classList.remove('editing');
            state.ws.send(JSON.stringify({type:'edit_message', messageId:msgId, newContent:newContent}));
        }
        if(e.key === 'Escape'){ el.classList.remove('editing'); e.preventDefault(); }
    });
    dom.aiSectionToggle.addEventListener('click', function(){ dom.aiBody.classList.toggle('open'); dom.aiToggleIcon.classList.toggle('open'); });
    dom.aiFetchModelsBtn.addEventListener('click', fetchModels);
    dom.aiSaveBtn.addEventListener('click', saveAISettings);
    dom.aiModelSelect.addEventListener('change', function(){ state.aiModel = dom.aiModelSelect.value; if(state.aiBaseUrl && state.aiModel) updateAIStatus(); });
    document.getElementById('injectWbBtn').addEventListener('click', function(){
        if(!state.connected||!state.ws)return;
        state.ws.send(JSON.stringify({type:'inject_worldbook'}));
        this.textContent='✅ 已就绪'; var _t=this;setTimeout(function(){_t.textContent='📖 注入世界书';},2000);
    });
    document.getElementById('injectJbBtn').addEventListener('click', function(){
        if(!state.connected||!state.ws)return;
        state.ws.send(JSON.stringify({type:'inject_jailbreak'}));
        this.textContent='✅ 已就绪'; var _t=this;setTimeout(function(){_t.textContent='⚡ 注入破限提示词';},2000);
    });
    document.getElementById('clearHistoryBtn').addEventListener('click', function(){
        if(!confirm('确定要删除所有聊天记录吗？此操作不可撤销。')) return;
        var btn = this; btn.disabled = true; btn.textContent = '⏳ 删除中...';
        fetch('/api/messages/clear', { method: 'POST' }).then(function(r){ return r.json(); }).then(function(d){
            if(d.success){ dom.messages.innerHTML = ''; state.aiHistory = []; addSystemMessage('🗑 聊天记录已清空'); btn.textContent = '✅ 已清空'; setTimeout(function(){ btn.textContent = '🗑 删除聊天记录'; btn.disabled = false; }, 1500); }
            else { btn.textContent = '❌ 删除失败'; setTimeout(function(){ btn.textContent = '🗑 删除聊天记录'; btn.disabled = false; }, 2000); }
        }).catch(function(){ btn.textContent = '❌ 删除失败'; setTimeout(function(){ btn.textContent = '🗑 删除聊天记录'; btn.disabled = false; }, 2000); });
    });
    dom.exportBtn.addEventListener('click', function(){ window.open('/api/export', '_blank'); });
    dom.importBtn.addEventListener('click', function(){
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = function(e){
            var file = e.target.files[0];
            if(!file) return;
            var reader = new FileReader();
            reader.onload = function(ev){
                try { var data = JSON.parse(ev.target.result);
                    fetch('/api/import', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
                    .then(function(r){ return r.json(); }).then(function(d){ if(d.success) addSystemMessage('✅ 导入 ' + d.count + ' 条消息成功'); else addSystemMessage('❌ 导入失败: ' + (d.error || '')); })
                    .catch(function(err){ addSystemMessage('❌ ' + err.message); });
                } catch(err) { addSystemMessage('❌ 文件格式错误'); }
            };
            reader.readAsText(file);
        };
        input.click();
    });
    dom.compressBtn.addEventListener('click', function(){
        if(!state.connected || !state.ws){ addSystemMessage('❌ 未连接'); return; }
        state.ws.send(JSON.stringify({type:'compress_context', history: state.aiHistory}));
        this.textContent = '⏳ 压缩中...';
        var _t = this; setTimeout(function(){ _t.textContent = '🗜 压缩上下文'; }, 3000);
    });
    dom.stopBtn.addEventListener('click', function(){ if(state.ws) state.ws.send(JSON.stringify({type:'stop_generation'})); });
    function updateCtxStats(){
        var h = state.aiHistory;
        if(!h || h.length === 0){ dom.ctxStats.style.display = 'none'; return; }
        var chars = 0; h.forEach(function(m){ if(m.content) chars += m.content.length; });
        var tokens = Math.round(chars / 2);
        var pairs = 0; for(var i=0; i<h.length; i+=2) if(h[i] && h[i+1]) pairs++;
        dom.ctxStats.style.display = 'block';
        dom.ctxStats.innerHTML = '· 对话: <span>' + pairs + '</span> 轮 · 上下文: <span>' + tokens.toLocaleString() + '</span> token';
    }
    setInterval(updateCtxStats, 3000);
    setInterval(function(){
        if(!state.connected) return;
        fetch('/api/info').then(function(r){ return r.json(); }).then(function(info){
            dom.onlineHeaderCount.textContent = info.online + ' 人在线';
        }).catch(function(){});
    }, 10000);
    var urlParams = new URLSearchParams(window.location.search);
    dom.nameInput.value = urlParams.get('name') || '酒客' + Math.floor(Math.random() * 1000);
    state.userName = dom.nameInput.value;
    connect();
})();
</script>
</body>
</html>`;
