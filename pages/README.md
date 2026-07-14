# 酒馆 — Cloudflare Pages 版

## 部署

1. **创建 Pages 项目**

   Cloudflare Dashboard → Workers & Pages → 创建 → Pages → 连接到 Git

   - 项目名称: `jiuguan`（或其他）
   - 生产分支: `master`
   - **构建输出目录: `pages`** ⚠️ 必须设置

2. **设置环境变量**

   | 变量 | 说明 |
   |------|------|
   | `BASE_URL` | OpenAI 兼容 API 地址 |
   | `API_KEY` | API 密钥 |

3. **绑定 KV（必需）**

   ```
   wrangler kv:namespace create JIUGUAN_KV
   ```

   Pages 项目 → 设置 → 绑定 → KV 命名空间 → 添加：
   - 变量名: `JIUGUAN_KV`

4. **绑定 Workers AI（可选）**

   Pages 项目 → 设置 → 绑定 → AI → 添加：
   - 变量名: `AI`

5. **重新部署**

## 文件

| 文件 | 说明 |
|------|------|
| `_worker.js` | 全部功能合一：前端页面（内嵌 HTML）、REST API、WebSocket 聊天 |
