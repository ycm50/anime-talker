# 酒馆 — 局域网 AI 聊天

一个前后端分离的 AI 聊天应用，支持局域网互联，也可部署到 Cloudflare Worker 或 Pages 全球访问。

## 架构

```
┌─────────────────┐     HTTP / WebSocket     ┌──────────────────────┐
│  前端 (PC 浏览器) │  ◄────────────────────►  │  后端 (Node.js)      │
│  frontend/       │     局域网 192.168.x.x    │  backend/server.js   │
│  index.html      │                          │    或                │
├─────────────────┤                          │  Cloudflare Worker   │
│  前端 (Android)  │                          │  worker.js           │
│  frontend/       │                          │    或                │
│  android/        │                          │  Cloudflare Pages    │
└─────────────────┘                          │  pages/_worker.js    │
                                              ├──────────────────────┤
                                              │  AI API              │
                                              │  OpenAI 兼容 / @cf   │
                                              └──────────────────────┘
```

- **后端** — 可选 Node.js (局域网)、Cloudflare Worker (全球)、Cloudflare Pages (全球)
- **前端** — 纯 HTML/CSS/JS，浏览器直接打开，或 Android WebView 加载
- **AI 推理** — 支持 OpenAI 兼容 API + Cloudflare Workers AI (@cf/ 模型)
- **持久化** — 聊天记录、世界书、设置通过 KV 保存（Worker / Pages 模式）

## 快速开始

### 方式 A: Node.js 后端（局域网）

```bash
cd backend
npm install
node server.js
```

服务器默认监听 `0.0.0.0:3000`，可通过环境变量 `PORT` 修改。

### 方式 B: Cloudflare Worker（全球访问）

```bash
npm install -g wrangler
wrangler deploy worker.js
```

配置环境变量与绑定：

```bash
wrangler secret put BASE_URL    # OpenAI 兼容 API 地址
wrangler secret put API_KEY     # API 密钥
wrangler kv:namespace create JIUGUAN_KV  # 创建 KV 命名空间
```

在 `wrangler.toml` 或 Cloudflare Dashboard 绑定 KV 和 AI：

```toml
kv_namespaces = [{ binding = "JIUGUAN_KV", id = "你的KV_ID" }]
ai = { binding = "AI" }

### 方式 C: Cloudflare Pages（全球访问）

不需要 `wrangler`，直接连接 Git 仓库即可自动部署。

**Cloudflare Dashboard → Workers & Pages → 创建 → Pages → 连接到 Git：**

| 设置 | 值 |
|------|-----|
| 构建输出目录 | `pages` ⚠️ 必须设置 |

然后在 Pages 项目 → 设置 → 绑定 中添加：

| 绑定 | 类型 |
|------|------|
| `JIUGUAN_KV` | KV 命名空间（保存设置、聊天记录） |
| `AI` | Workers AI（可选，用于 @cf/ 模型） |

以及环境变量：

| 变量 | 说明 |
|------|------|
| `BASE_URL` | OpenAI 兼容 API 地址 |
| `API_KEY` | API 密钥 |

部署后可通过 `https://你的项目名.pages.dev` 直接访问。
```

### 浏览器访问

打开 `frontend/index.html`（本地）、Worker 或 Pages 域名（云端），在侧边栏设置：

| 字段 | 说明 |
|------|------|
| Base URL | AI API 地址，如 `https://api.openai.com` |
| API Key | AI 服务的 API 密钥 |
| 模型 | AI 模型名（点"获取模型列表"按钮） |

### Android 构建

```bash
cd frontend/android
./gradlew assembleDebug    # Debug APK（已签名，可直接安装）
./gradlew assembleRelease  # Release APK
```

APK 输出位置：`frontend/android/app/build/outputs/apk/`

Android 客户端会自动记忆上次连接的服务器地址，首次打开需手动输入。

## 功能

- **AI 对话** — 流式输出，支持多轮对话
- **世界书** — 设置世界观注入到对话上下文（手动按钮触发）
- **破限提示词** — 手动按钮注入
- **模型切换** — OpenAI 兼容 API / @cf 模型列表自动获取
- **对话管理** — 编辑 / 删除 / 导出 / 导入聊天记录
- **停止生成** — 中断 AI 响应
- **上下文压缩** — 压缩历史记录以节省 Token
- **Android 客户端** — WebView 封装，局域网或远程连接
- **数据持久化** — KV 保存设置、世界书、聊天记录（Worker 模式）

## 项目结构

```
酒馆/
├── backend/           # Node.js 后端（可选）
│   ├── server.js      # 主服务
│   ├── cpp/           # C++ 消息处理器
│   ├── settings.json  # 配置（不提交）
│   └── messages.json  # 聊天记录（不提交）
├── frontend/
│   ├── index.html     # PC 浏览器前端
│   └── android/       # Android 客户端源码
│       └── app/src/main/java/com/jiuguan/MainActivity.kt
├── worker.js          # Cloudflare Worker（可选，替代 Node.js）
├── pages/             # Cloudflare Pages 部署
│   ├── _worker.js     #   Pages Advanced Mode 入口
│   └── README.md      #   部署说明
├── .github/workflows/ # CI 构建
└── README.md
```

## Cloudflare Worker / Pages 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BASE_URL` | OpenAI 兼容 API 地址 | `https://api.openai.com` |
| `API_KEY` | API 密钥 | 空 |

## Cloudflare Worker / Pages 绑定

| 绑定 | 说明 |
|------|------|
| `JIUGUAN_KV` | KV 命名空间（持久化保存设置、世界书、破限提示词、聊天记录） |
| `AI` | Workers AI 绑定（用于 @cf/ 模型） |
