// ============================================================
// 酒馆 - 后端服务器
// Node.js 主服务器: HTTP (Express) + WebSocket (ws)
// C++ 子进程: 消息处理 (敏感词过滤、统计)
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ============================================================
// 配置
// ============================================================
const PORT = process.env.PORT || 3000;
const CPP_PATH = path.join(__dirname, 'cpp', 'message_processor.exe');
const FRONTEND_PATH = path.join(__dirname, '..', 'frontend');
const MESSAGE_HISTORY_FILE = path.join(__dirname, 'messages.json');

const MAX_HISTORY = 200;         // 最多保存多少条历史消息
const CPP_RESTART_DELAY = 2000;  // C++ 崩溃后重启延迟 (ms)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ============================================================
// 消息历史 (内存 + 文件持久化)
// ============================================================
let messageHistory = [];

function loadHistory() {
    try {
        if (fs.existsSync(MESSAGE_HISTORY_FILE)) {
            const raw = fs.readFileSync(MESSAGE_HISTORY_FILE, 'utf-8');
            messageHistory = JSON.parse(raw);
            if (!Array.isArray(messageHistory)) messageHistory = [];
            console.log(`[历史] 已加载 ${messageHistory.length} 条历史消息`);
        }
    } catch (e) {
        console.warn('[历史] 加载失败，使用空历史:', e.message);
        messageHistory = [];
    }
}

function saveHistory() {
    try {
        // 只保留最近 MAX_HISTORY 条
        const toSave = messageHistory.slice(-MAX_HISTORY);
        fs.writeFileSync(MESSAGE_HISTORY_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (e) {
        console.error('[历史] 保存失败:', e.message);
    }
}

function addMessage(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY * 2) {
        messageHistory = messageHistory.slice(-MAX_HISTORY);
    }
    saveHistory();
}

// 清空所有聊天记录
function clearHistory() {
    messageHistory = [];
    saveHistory();
    console.log('[历史] 聊天记录已清空');
}

// ============================================================
// C++ 子进程管理器
// ============================================================
let cppProcess = null;
let cppPendingResolve = null;

function startCppProcess() {
    if (cppProcess) {
        try { cppProcess.kill(); } catch (_) {}
    }

    console.log('[C++] 启动消息处理器...');
    cppProcess = spawn(CPP_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = '';
    cppProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        // C++ 模块每行输出一个 JSON 响应
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const result = JSON.parse(line.trim());
                    if (cppPendingResolve) {
                        cppPendingResolve(result);
                        cppPendingResolve = null;
                    }
                } catch (e) {
                    console.error('[C++] JSON 解析错误:', line, e.message);
                }
            }
        }
    });

    cppProcess.stderr.on('data', (data) => {
        console.error('[C++ stderr]', data.toString().trim());
    });

    cppProcess.on('exit', (code) => {
        console.log(`[C++] 进程退出 (code: ${code})，${code !== 0 ? CPP_RESTART_DELAY + 'ms 后重启...' : '不再重启'}`);
        cppProcess = null;
        if (cppPendingResolve) {
            cppPendingResolve({ result: 'error', error: 'C++ processor crashed' });
            cppPendingResolve = null;
        }
        if (code !== 0) {
            // 非正常退出则重启
            setTimeout(startCppProcess, CPP_RESTART_DELAY);
        }
    });

    cppProcess.on('error', (err) => {
        console.error('[C++] 启动失败:', err.message);
        cppProcess = null;
        if (cppPendingResolve) {
            cppPendingResolve({ result: 'error', error: err.message });
            cppPendingResolve = null;
        }
    });
}

// 发送消息到 C++ 处理器，返回 Promise
function processWithCpp(action, content, sender) {
    return new Promise((resolve, reject) => {
        if (!cppProcess) {
            // C++ 不可用时，返回默认结果
            resolve({
                result: 'ok',
                action: action,
                content: content,
                sender: sender,
                char_count: content.length,
                word_count: content.split(/\s+/).filter(s => s).length,
                summary: content.length > 20 ? content.substring(0, 20) + '...' : content,
                filtered: false,
                timestamp: new Date().toLocaleTimeString(),
                cpp_available: false
            });
            return;
        }

        const request = JSON.stringify({
            action: action,
            content: content,
            sender: sender
        });

        cppPendingResolve = resolve;
        cppProcess.stdin.write(request + '\n');

        // 超时处理
        setTimeout(() => {
            if (cppPendingResolve) {
                cppPendingResolve({
                    result: 'timeout',
                    action: action,
                    content: content,
                    error: 'C++ processor timeout'
                });
                cppPendingResolve = null;
            }
        }, 5000);
    });
}

// ============================================================
// 用户在线管理
// ============================================================
const connectedUsers = new Map(); // ws -> { id, name, color, joinTime }

function generateColor() {
    const colors = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
        '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
        '#16a085', '#c0392b', '#2980b9', '#27ae60',
        '#8e44ad', '#d35400', '#2c3e50', '#7f8c8d'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateId() {
    let id = '';
    for (let i = 0; i < 8; i++) id += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    return id;
}

// ============================================================
// HTTP 服务器 (Express)
// ============================================================
const app = express();
const server = http.createServer(app);

// 静态文件服务 - 前端页面 (禁用缓存，确保前端及时更新)
app.use(express.static(FRONTEND_PATH, {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));
app.use(express.json());

// API: 获取服务器信息
app.get('/api/info', (req, res) => {
    res.json({
        name: '酒馆',
        version: '1.0.0',
        online: connectedUsers.size,
        uptime: process.uptime(),
        cpp_available: cppProcess !== null
    });
});

// API: 获取在线用户列表
app.get('/api/users', (req, res) => {
    const users = [];
    for (const [ws, info] of connectedUsers) {
        users.push({
            id: info.id,
            name: info.name,
            color: info.color,
            joinTime: info.joinTime
        });
    }
    res.json(users);
});

// API: 清空消息历史
app.post('/api/messages/clear', (req, res) => {
    clearHistory();
    // 通知所有 WebSocket 客户端
    broadcast({ type: 'history_cleared' });
    res.json({ success: true });
});

// API: 获取消息历史
app.get('/api/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, MAX_HISTORY);
    res.json(messageHistory.slice(-limit));
});

// API: 导出对话 (JSON 下载)
app.get('/api/export', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="jiuguan_chat_' + new Date().toISOString().slice(0,10) + '.json"');
    res.json({ version: 1, exportedAt: new Date().toISOString(), messages: messageHistory });
});

// API: 导入对话
app.post('/api/import', express.json({ limit: '50mb' }), (req, res) => {
    try {
        const data = req.body;
        let msgs = [];
        if (Array.isArray(data)) msgs = data;
        else if (data && Array.isArray(data.messages)) msgs = data.messages;
        else return res.status(400).json({ error: '\u683c\u5f0f\u4e0d\u6b63\u786e\uff0c\u8bf7\u63d0\u4ea4\u5bfc\u51fa\u6587\u4ef6' });
        messageHistory = msgs.slice(-MAX_HISTORY);
        saveHistory();
        broadcast({ type: 'history_imported', messages: messageHistory });
        console.log('[\u5386\u53f2] \u5bfc\u5165 ' + messageHistory.length + ' \u6761\u6d88\u606f');
        res.json({ success: true, count: messageHistory.length });
    } catch (e) {
        res.status(400).json({ error: '\u5bfc\u5165\u5931\u8d25: ' + e.message });
    }
});

// API: 发送消息 (HTTP 方式)
// ============================================================
// AI 设置管理
// ============================================================
let aiSettings = {
    baseUrl: '',
    apiKey: '',
    model: '',
    worldBook: '',
    jailbreakPrompt: ''
};

function loadAISettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const saved = JSON.parse(raw);
            if (saved.baseUrl !== undefined) aiSettings.baseUrl = saved.baseUrl;
            if (saved.apiKey !== undefined) aiSettings.apiKey = saved.apiKey;
            if (saved.model !== undefined) aiSettings.model = saved.model;
            if (saved.worldBook !== undefined) aiSettings.worldBook = saved.worldBook;
            if (saved.jailbreakPrompt !== undefined) aiSettings.jailbreakPrompt = saved.jailbreakPrompt;
            console.log('[AI] 已加载设置: baseUrl=' + (aiSettings.baseUrl || '(空)') + ', model=' + (aiSettings.model || '(空)'));
        }
    } catch (e) {
        console.warn('[AI] 加载设置失败:', e.message);
    }
}

function saveAISettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(aiSettings, null, 2), 'utf-8');
        console.log('[AI] 设置已保存');
        return true;
    } catch (e) {
        console.error('[AI] 保存设置失败:', e.message);
        return false;
    }
}

// 向外部 AI API 发送请求的通用函数
async function proxyAIRequest(pathname, body, method) {
    if (!aiSettings.baseUrl) {
        return { error: '请先设置 API Base URL' };
    }
    const url = aiSettings.baseUrl.replace(/\/+$/, '') + '/' + pathname.replace(/^\/+/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (aiSettings.apiKey) {
        headers['Authorization'] = 'Bearer ' + aiSettings.apiKey;
    }

    // 创建超时控制器 (30秒)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const resp = await fetch(url, {
            method: method || 'GET',
            headers: headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return { error: 'API 请求失败 (' + resp.status + '): ' + errText.substring(0, 500) };
        }
        return await resp.json();
    } catch (e) {
        clearTimeout(timeoutId);
        const msg = e.name === 'AbortError' ? '请求超时 (30秒)' : e.message;
        return { error: '请求外部 API 失败: ' + msg };
    }
}

// 流式 AI 请求：通过 WebSocket 逐 chunk 推送回复
async function proxyAIStream(ws, pathname, body, user) {
    if (!aiSettings.baseUrl) {
        ws.send(JSON.stringify({ type: 'error', content: 'AI 未配置：请先设置 API Base URL' }));
        return null;
    }
    if (!aiSettings.apiKey) {
        ws.send(JSON.stringify({ type: 'error', content: 'AI 未配置：请先设置 API Key' }));
        return null;
    }
    const url = aiSettings.baseUrl.replace(/\/+$/, '') + '/' + pathname.replace(/^\/+/, '');
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + aiSettings.apiKey
    };

    const controller = new AbortController();
    if (user) user.abortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s 超时

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            ws.send(JSON.stringify({ type: 'error', content: 'AI 请求失败 (' + resp.status + '): ' + errText.substring(0, 200) }));
            return null;
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
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                    if (delta && delta.content) {
                        fullContent += delta.content;
                        // 广播每个 chunk 给所有客户端
                        broadcast({
                            type: 'ai_chunk',
                            chunk: delta.content,
                            fullContent: fullContent
                        });
                    }
                } catch (_) {}
            }
        }

        return fullContent;
    } catch (e) {
        clearTimeout(timeoutId);
        const msg = e.name === 'AbortError' ? '请求超时 (60秒)' : e.message;
        ws.send(JSON.stringify({ type: 'error', content: 'AI 请求失败: ' + msg }));
        return null;
    } finally {
        if (user) user.abortController = null;
    }
}

// API: 获取 AI 设置
app.get('/api/ai/settings', (req, res) => {
    res.json({
        baseUrl: aiSettings.baseUrl,
        apiKey: aiSettings.apiKey,
        model: aiSettings.model,
        worldBook: aiSettings.worldBook || '',
        jailbreakPrompt: aiSettings.jailbreakPrompt || ''
    });
});

// API: 保存 AI 设置
app.post('/api/ai/settings', (req, res) => {
    const { baseUrl, apiKey, model, worldBook, jailbreakPrompt } = req.body;
    if (baseUrl !== undefined) aiSettings.baseUrl = baseUrl.trim();
    if (apiKey !== undefined) aiSettings.apiKey = apiKey.trim();
    if (model !== undefined) aiSettings.model = model.trim();
    if (worldBook !== undefined) aiSettings.worldBook = worldBook;
    if (jailbreakPrompt !== undefined) aiSettings.jailbreakPrompt = jailbreakPrompt;
    if (saveAISettings()) {
        console.log('[AI] 更新设置: baseUrl=' + (aiSettings.baseUrl || '(空)') + ', model=' + (aiSettings.model || '(空)') + ', apiKey=' + (aiSettings.apiKey ? '(已设置)' : '(空)'));
        res.json({ success: true, baseUrl: aiSettings.baseUrl, model: aiSettings.model });
    } else {
        res.status(500).json({ error: '保存设置失败' });
    }
});

// API: 获取模型列表（代理到外部 API）
app.post('/api/ai/models', async (req, res) => {
    const { baseUrl, apiKey } = req.body;
    // 允许前端临时指定（未保存时获取用）
    const useBaseUrl = (baseUrl || aiSettings.baseUrl || '').replace(/\/+$/, '');
    const useApiKey = apiKey || aiSettings.apiKey || '';
    if (!useBaseUrl) {
        return res.status(400).json({ error: '请先设置 API Base URL' });
    }
    const url = useBaseUrl + '/v1/models';
    const headers = { 'Content-Type': 'application/json' };
    if (useApiKey) {
        headers['Authorization'] = 'Bearer ' + useApiKey;
    }
    // 设置超时 (15秒)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch(url, { headers: headers, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return res.status(resp.status).json({ error: '获取模型列表失败 (' + resp.status + '): ' + errText.substring(0, 500) });
        }
        const data = await resp.json();
        // 提取模型列表
        let models = [];
        if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => ({ id: m.id, owned_by: m.owned_by || '' }));
        }
        res.json({ success: true, models: models, note: data.data ? undefined : '可能格式有误，请检查 Base URL 是否正确' });
    } catch (e) {
        clearTimeout(timeoutId);
        var msg = e.name === 'AbortError' ? '请求超时 (15秒)，请检查 API Base URL 是否正确且网络可达' :
                  (e.cause && e.cause.code === 'ENOTFOUND') ? '无法解析域名，请检查 API Base URL 是否正确' :
                  (e.cause && e.cause.code === 'ECONNREFUSED') ? '连接被拒绝，请检查 API 服务是否已启动' :
                  e.message;
        res.status(502).json({ error: '请求失败: ' + msg });
    }
});

// API: AI 聊天（非流式，代理到外部 API）
app.post('/api/ai/chat', async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: '缺少 messages' });
    }
    if (!aiSettings.baseUrl) {
        return res.status(400).json({ error: '请先设置 API Base URL' });
    }
    if (!aiSettings.model) {
        return res.status(400).json({ error: '请先选择模型' });
    }
    const result = await proxyAIRequest('v1/chat/completions', {
        model: aiSettings.model,
        messages: messages,
        stream: false
    }, 'POST');
    if (result.error) {
        return res.status(502).json(result);
    }
    res.json({ success: true, result: result });
});

app.post('/api/send', async (req, res) => {
    const { content, sender } = req.body;
    if (!content || !sender) {
        return res.status(400).json({ error: '缺少 content 或 sender' });
    }

    const cppResult = await processWithCpp('process', content, sender);

    const msg = {
        id: generateId(),
        type: 'message',
        sender: sender,
        content: cppResult.filtered ? cppResult.content : content,
        charCount: cppResult.char_count,
        filtered: cppResult.filtered || false,
        timestamp: new Date().toISOString(),
        cppProcessed: cppProcess !== null
    };

    addMessage(msg);

    // 广播给所有 WebSocket 客户端
    broadcast({
        type: 'message',
        ...msg
    });

    res.json({ success: true, message: msg });
});

// ============================================================
// WebSocket 服务器
// ============================================================
const wss = new WebSocketServer({ server });

function broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    for (const [ws, _] of connectedUsers) {
        if (ws !== excludeWs && ws.readyState === 1) { // OPEN
            try {
                ws.send(payload);
            } catch (e) {
                console.error('[WS] 发送失败:', e.message);
            }
        }
    }
}

wss.on('connection', (ws, req) => {
    // 获取客户端 IP
    const clientIp = req.socket.remoteAddress || 'unknown';
    console.log(`[WS] 新连接: ${clientIp}`);

    // 为用户分配临时信息
    const userId = generateId();
    const userInfo = {
        id: userId,
        name: `游客${connectedUsers.size + 1}`,
        color: generateColor(),
        joinTime: new Date().toISOString(),
        ip: clientIp,
        contextInjected: false,
        pendingJailbreak: false,
        pendingWorldbook: false,
        abortController: null
    };
    connectedUsers.set(ws, userInfo);

    // 发送欢迎消息（只发给新连接）
    ws.send(JSON.stringify({
        type: 'welcome',
        userId: userId,
        serverInfo: {
            name: '酒馆',
            online: connectedUsers.size,
            cpp_available: cppProcess !== null,
            ai_configured: !!(aiSettings.baseUrl && aiSettings.model)
        }
    }));

    // 发送历史消息
    ws.send(JSON.stringify({
        type: 'history',
        messages: messageHistory.slice(-50)
    }));

    // 发送在线用户列表
    broadcastUserList();

    // 系统消息：用户加入
    broadcast({
        type: 'system',
        content: `${userInfo.name} 进入了酒馆`,
        userId: userId,
        timestamp: new Date().toISOString()
    });

    // 处理收到的消息
    ws.on('message', async (raw) => {
        try {
            let data;
            try {
                data = JSON.parse(raw.toString());
            } catch (e) {
                ws.send(JSON.stringify({ type: 'error', content: '消息格式错误' }));
                return;
            }

            const user = connectedUsers.get(ws);
            if (!user) return;

            switch (data.type) {
                case 'chat': {
                    const content = (data.content || '').trim();
                    if (!content) break;

                    // 通过 C++ 处理器分析消息
                    const cppResult = await processWithCpp('process', content, user.name);

                    const msg = {
                        id: generateId(),
                        type: 'message',
                        userId: user.id,
                        sender: user.name,
                        senderColor: user.color,
                        content: cppResult.filtered ? cppResult.content : content,
                        charCount: cppResult.char_count,
                        wordCount: cppResult.word_count,
                        summary: cppResult.summary,
                        filtered: cppResult.filtered || false,
                        timestamp: new Date().toISOString()
                    };

                    addMessage(msg);
                    broadcast(msg);

                    // 如果消息被过滤，单独通知发送者
                    if (cppResult.filtered) {
                        ws.send(JSON.stringify({
                            type: 'filter_notice',
                            content: '消息包含敏感词，已自动过滤',
                            original: content,
                            filtered: cppResult.content
                        }));
                    }
                    break;
                }

                case 'ai_chat': {
                    const content = (data.content || '').trim();
                    if (!content) break;
                    if (!aiSettings.baseUrl) {
                        ws.send(JSON.stringify({ type: 'error', content: 'AI 未配置：请先设置 API Base URL' }));
                        break;
                    }
                    if (!aiSettings.model) {
                        ws.send(JSON.stringify({ type: 'error', content: 'AI 未配置：请先选择模型' }));
                        break;
                    }

                    console.log('[AI] 收到 AI 聊天请求 (流式):', content.substring(0, 50));

                    // 先广播用户消息
                    const userMsg = {
                        id: generateId(),
                        type: 'message',
                        userId: user.id,
                        sender: user.name,
                        senderColor: user.color,
                        content: content,
                        timestamp: new Date().toISOString(),
                        is_ai_request: true
                    };
                    addMessage(userMsg);
                    broadcast(userMsg);

                    // 构建对话消息
                    const aiMessages = data.history || [];

                    // 世界书：仅首次注入
                    if (!user.contextInjected) {
                        user.contextInjected = true;
                        if (aiSettings.worldBook && aiSettings.worldBook.trim()) {
                            aiMessages.unshift({ role: 'system', content: '【世界书】\n' + aiSettings.worldBook.trim() });
                            console.log('[AI] 为用户 ' + user.name + ' 注入世界书 (' + aiSettings.worldBook.length + ' 字)');
                        }
                    }

                                        // 按钮触发：破限提示词注入
                    if (user.pendingJailbreak) {
                        user.pendingJailbreak = false;
                        if (aiSettings.jailbreakPrompt && aiSettings.jailbreakPrompt.trim()) {
                            aiMessages.unshift({ role: 'system', content: aiSettings.jailbreakPrompt.trim() });
                            console.log('[AI] 按钮注入破限提示词 (' + aiSettings.jailbreakPrompt.length + ' 字)');
                        }
                    }

                    // 按钮触发：世界书注入
                    if (user.pendingWorldbook) {
                        user.pendingWorldbook = false;
                        if (aiSettings.worldBook && aiSettings.worldBook.trim()) {
                            aiMessages.unshift({ role: 'system', content: '【世界书】\\n' + aiSettings.worldBook.trim() });
                            console.log('[AI] 按钮注入世界书 (' + aiSettings.worldBook.length + ' 字)');
                        }
                    }

// 打印注入后的 system 消息摘要
                    const systemMsgs = aiMessages.filter(m => m.role === 'system');
                    if (systemMsgs.length > 0) {
                        console.log('[AI] ── 上下文注入详情 ──');
                        systemMsgs.forEach((m, i) => {
                            const preview = m.content.substring(0, 80).replace(/\n/g, '↵');
                            console.log('[AI]   system[' + i + ']: ' + preview + '... (' + m.content.length + ' 字)');
                        });
                        console.log('[AI] ─────────────────────');
                    }

                    aiMessages.push({ role: 'user', content: content });

                    console.log('[AI] 正在流式请求外部 API...');

                    // 广播一个空的 ai_chunk_start 让前端准备好消息容器
                    broadcast({
                        type: 'ai_chunk_start',
                        sender: 'AI \u00b7 ' + aiSettings.model,
                        senderColor: '#10a37f',
                        timestamp: new Date().toISOString()
                    });

                    // 流式调用
                    const fullContent = await proxyAIStream(ws, 'v1/chat/completions', {
                        model: aiSettings.model,
                        messages: aiMessages,
                        stream: true
                    }, user);

                    if (!fullContent) {
                        // 错误已由 proxyAIStream 发送，但需要通知前端流结束
                        broadcast({ type: 'ai_chunk_done', content: '', error: true });
                        break;
                    }

                    console.log('[AI] 流式回复完成, 共 ' + fullContent.length + ' 字');

                    // 通过 C++ 处理器处理完整内容
                    const cppAiResult = await processWithCpp('process', fullContent, 'AI \u00b7 ' + aiSettings.model);
                    const finalContent = cppAiResult.filtered ? cppAiResult.content : fullContent;

                    // 发送完成信号（包含最终内容和过滤状态）
                    broadcast({
                        type: 'ai_chunk_done',
                        content: finalContent,
                        filtered: cppAiResult.filtered || false,
                        sender: 'AI \u00b7 ' + aiSettings.model,
                        senderColor: '#10a37f',
                        timestamp: new Date().toISOString()
                    });

                    // 保存到历史消息
                    const aiMsg = {
                        id: generateId(),
                        type: 'message',
                        userId: 'ai',
                        sender: 'AI \u00b7 ' + aiSettings.model,
                        senderColor: '#10a37f',
                        content: finalContent,
                        timestamp: new Date().toISOString(),
                        is_ai_response: true,
                        filtered: cppAiResult.filtered || false
                    };
                    addMessage(aiMsg);
                    break;
                }

                case 'set_name': {
                    const oldName = user.name;
                    user.name = (data.name || '').trim().substring(0, 20) || '匿名';
                    connectedUsers.set(ws, user);
                    broadcastUserList();
                    broadcast({
                        type: 'system',
                        content: `${oldName} 改名为 ${user.name}`,
                        userId: user.id,
                        timestamp: new Date().toISOString()
                    });
                    break;
                }

                case 'edit_message': {
                    const { messageId, newContent } = data;
                    if (!messageId || !newContent) break;
                    const idx = messageHistory.findIndex(m => m.id === messageId);
                    if (idx === -1) { ws.send(JSON.stringify({ type: 'error', content: '消息未找到' })); break; }
                    // 只允许编辑自己的消息
                    if (messageHistory[idx].userId !== user.id) { ws.send(JSON.stringify({ type: 'error', content: '只能编辑自己的消息' })); break; }
                    // 更新消息内容
                    messageHistory[idx].content = newContent.trim();
                    messageHistory[idx].edited = true;
                    // 舍弃之后的所有消息
                    const removedCount = messageHistory.length - idx - 1;
                    messageHistory = messageHistory.slice(0, idx + 1);
                    saveHistory();
                    console.log('[历史] 用户 ' + user.name + ' 编辑了消息 ' + messageId + '，舍弃了 ' + removedCount + ' 条后续消息');
                    // 广播编辑事件
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

                case 'stop_generation': {
                    if (user && user.abortController) {
                        user.abortController.abort();
                        console.log('[AI] \u7528\u6237 ' + user.name + ' \u505c\u6b62\u751f\u6210');
                        ws.send(JSON.stringify({ type: 'generation_stopped', content: '\u2705 \u5df2\u505c\u6b62\u751f\u6210' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'generation_stopped', content: '\u6ca1\u6709\u6b63\u5728\u8fdb\u884c\u7684\u751f\u6210' }));
                    }
                    break;
                }

                case 'compress_context': {
                    if (!aiSettings.model) { ws.send(JSON.stringify({ type: 'error', content: '\u8bf7\u5148\u914d\u7f6e AI \u6a21\u578b' })); break; }
                    console.log('[AI] \u7528\u6237 ' + user.name + ' \u8bf7\u6c42\u538b\u7f29\u4e0a\u4e0b\u6587');
                    // \u53d6\u6700\u8fd1 6 \u6761\u6d88\u606f\uff0c\u5269\u4f59\u7684\u7528\u7b80\u77ed\u6458\u8981\u66ff\u4ee3
                    var hist = data.history || [];
                    if (hist.length <= 6) { ws.send(JSON.stringify({ type: 'compress_ack', content: '\u5bf9\u8bdd\u8f83\u77ed\uff0c\u65e0\u9700\u538b\u7f29' })); break; }
                    var keep = hist.slice(-6);
                    var summary = '\u4e0a\u4e00\u6bb5\u5bf9\u8bdd\u5171 ' + (hist.length - 6) + ' \u6761\u6d88\u606f\uff0c\u5df2\u538b\u7f29\u4e3a\u4ee5\u4e0b\u6458\u8981\uff1a\n';
                    summary += '\u7528\u6237\u53d1\u8d77\u4e86\u5173\u4e8e\u89d2\u8272\u626e\u6f14\u7684\u5bf9\u8bdd\uff0cAI\u5df2\u7ecf\u4f5c\u51fa\u4e86\u76f8\u5e94\u56de\u590d\u3002\u8bf7\u7ee7\u7eed\u5f53\u524d\u89d2\u8272\u548c\u60c5\u8282\u8fdb\u884c\u3002';
                    keep.unshift({ role: 'system', content: summary });
                    console.log('[AI] \u4e0a\u4e0b\u6587\u538b\u7f29: ' + hist.length + ' -> ' + keep.length + ' \u6761');
                    ws.send(JSON.stringify({ type: 'compress_ack', content: '\u2705 \u5df2\u538b\u7f29: ' + hist.length + ' \u6761\u6d88\u606f -> ' + keep.length + ' \u6761', history: keep }));
                    break;
                }

                case 'inject_jailbreak': {
                    user.pendingJailbreak = true;
                    connectedUsers.set(ws, user);
                    ws.send(JSON.stringify({ type: 'inject_ack', content: '\u2705 \u7834\u9650\u63d0\u793a\u8bcd\u5df2\u5c31\u7eea\uff0c\u4e0b\u4e00\u6761\u6d88\u606f\u751f\u6548' }));
                    break;
                }
                case 'inject_worldbook': {
                    user.pendingWorldbook = true;
                    connectedUsers.set(ws, user);
                    ws.send(JSON.stringify({ type: 'inject_ack', content: '\u2705 \u4e16\u754c\u4e66\u5df2\u5c31\u7eea\uff0c\u4e0b\u4e00\u6761\u6d88\u606f\u751f\u6548' }));
                    break;
                }

                case 'ping': {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                }

                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        content: `未知消息类型: ${data.type}`
                    }));
            }
        } catch (err) {
            console.error('[WS] 消息处理异常:', err.message, err.stack);
            try { ws.send(JSON.stringify({ type: 'error', content: '服务器内部错误: ' + err.message })); } catch (_) {}
        }
    });

    // 连接关闭
    ws.on('close', () => {
        const user = connectedUsers.get(ws);
        if (user) {
            console.log(`[WS] 断开: ${user.name} (${clientIp})`);
            broadcast({
                type: 'system',
                content: `${user.name} 离开了酒馆`,
                userId: user.id,
                timestamp: new Date().toISOString()
            });
            connectedUsers.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
    });
});

function broadcastUserList() {
    const users = [];
    for (const [ws, info] of connectedUsers) {
        users.push({
            id: info.id,
            name: info.name,
            color: info.color,
            joinTime: info.joinTime
        });
    }
    broadcast({ type: 'userlist', users: users });
}

// ============================================================
// 获取局域网 IP
// ============================================================
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// ============================================================
// 启动
// ============================================================
loadHistory();
loadAISettings();

// 启动 C++ 子进程（如果 exe 存在）
if (fs.existsSync(CPP_PATH)) {
    startCppProcess();
} else {
    console.warn(`[C++] ${CPP_PATH} 不存在，将以纯 Node.js 模式运行`);
}

// 全局错误处理
process.on('uncaughtException', (err) => {
    console.error('[致命] 未捕获异常:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('[致命] 未处理的 Promise 拒绝:', err);
});

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n[关闭] 正在关闭服务器...');
    if (cppProcess) {
        cppProcess.stdin.write('exit\n');
        setTimeout(() => {
            try { cppProcess.kill(); } catch (_) {}
        }, 500);
    }
    server.close(() => {
        saveHistory();
        process.exit(0);
    });
});

// 端口冲突时给出清晰提示
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('');
        console.error('  ============================================');
        console.error('   \u6e21\u53e3 ' + PORT + ' \u5df2\u88ab\u5360\u7528!');
        console.error('   \u6267\u884c\u4ee5\u4e0b\u547d\u4ee4\u6740\u6389\u65e7\u8fdb\u7a0b:');
        console.error('   netstat -ano | findstr :' + PORT);
        console.error('   taskkill /PID /F');
        console.error('');
        console.error('   \u6216\u7528\u5176\u4ed6\u7aef\u53e3\u542f\u52a8:');
        console.error('   $env:PORT=' + (PORT + 1) + '; node server.js');
        console.error('  ============================================');
        console.error('');
    } else {
        console.error('[\u81f4\u547d] \u670d\u52a1\u5668\u9519\u8bef:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('');
    console.log('  ╔═══════════════════════════════════════════╗');
    console.log('  ║            🍺 酒馆 已开张                  ║');
    console.log('  ╠═══════════════════════════════════════════╣');
    console.log(`  ║  本机:     http://localhost:${PORT}            ║`);
    console.log(`  ║  局域网:   http://${localIP}:${PORT}            ║`);
    console.log(`  ║  在线:     ${connectedUsers.size} 人                  ║`);
    console.log(`  ║  端口:     ${PORT}                           ║`);
    console.log('  ╚═══════════════════════════════════════════╝');
    console.log('');
    console.log(`C++ 消息处理器: ${cppProcess ? '✅ 已启动' : '❌ 未加载'}`);
    console.log(`消息历史: ${messageHistory.length} 条`);
    console.log('按 Ctrl+C 停止服务器');
});
