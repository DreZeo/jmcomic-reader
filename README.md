# JM Comic Reader（Cloudflare Worker + GitHub Pages）

把 [ccbkkb/jmcomic-api](https://github.com/ccbkkb/jmcomic-api) 的 PHP 接口移植到 **Cloudflare Workers**，并附带可部署到 **GitHub Pages** 的暗色阅读前端。

> 仅供个人学习与技术演示。请遵守当地法律与目标站点服务条款，勿用于商业或大规模抓取。

## 架构

```
浏览器 (GitHub Pages 静态站)
   │  ?jmid= / chapter / Canvas 解乱序
   ▼
Cloudflare Worker  (本仓库 worker/)
   │  token + AES-256-ECB 解密 / 域名轮询
   ▼
禁漫官方 API + CDN
```

| 部分 | 路径 | 部署目标 |
|------|------|----------|
| API | `worker/` | Cloudflare Workers |
| 前端 | `frontend/` | GitHub Pages / 任意静态托管 |
| 参考原版 | `_ref-jmcomic-api/`（本地克隆，已 gitignore） | — |

## 功能对照

| 能力 | 原 PHP | 本 Worker |
|------|--------|-----------|
| `?jmid=` 专辑+目录 | ✅ | ✅ |
| `?chapter=` / `@N` / `all` / 批量 | ✅ | ✅ |
| scramble 参数 + segments | ✅ | ✅ |
| 域名自动刷新 | 本地文件缓存 | KV 可选 / 内存回退 |
| Redis 限流 | 可选 | 单 isolate 简易限流 |
| 图片乱序解码 | GD 服务端 | **前端 Canvas** |
| CDN 跨域 | 无 | **`/proxy` 图片代理** |

## 1. 部署 Worker

### 前置

- Node.js 18+
- Cloudflare 账号
- 登录：`npx wrangler login`

### 安装与本地调试

```bash
cd worker
npm install
npm run dev
```

本地默认：`http://127.0.0.1:8787`

```bash
curl "http://127.0.0.1:8787/?health=1"
curl "http://127.0.0.1:8787/?jmid=350234&format=min"
curl "http://127.0.0.1:8787/?jmid=350234&chapter=@1&format=min"
```

### 上线

```bash
cd worker
npm run deploy
```

记下输出的 `https://jmcomic-api.<你的子域>.workers.dev`。

### （可选）绑定 KV 缓存

域名列表与 scramble_id 可缓存，减少上游请求：

```bash
npx wrangler kv namespace create JM_CACHE
```

把返回的 `id` 写进 `worker/wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "JM_CACHE"
id = "粘贴这里"
```

再 `npm run deploy`。

### 环境变量

在 `wrangler.toml` 的 `[vars]`：

| 变量 | 默认 | 说明 |
|------|------|------|
| `ALLOWED_ORIGINS` | `*` | CORS 白名单，逗号分隔；生产建议写成你的 Pages 域名 |
| `RATE_MAX_PER_MIN` | `60` | 每 IP 每分钟请求上限（单 isolate，非全网精确） |

生产示例：

```toml
ALLOWED_ORIGINS = "https://你的用户名.github.io"
```

## 2. 部署前端到 GitHub Pages

### 方式 A：仓库根目录是别的内容时用 `/docs`

1. 把 `frontend/*` 复制到仓库的 `docs/`（或在仓库设置里指定 `frontend` 为 Pages 目录——若平台支持）。
2. GitHub → Settings → Pages → Source: **Deploy from a branch** → branch `main` → folder `/docs`（或 `/ (root)`）。
3. 前端内置 Worker 地址（`frontend/app.js` 中的 `DEFAULT_API_BASE`），**设置页不再暴露 API 配置**。

本仓库可直接：

- 将 Pages 目录设为 `/frontend`（若界面可选），或
- 使用下面的一键同步到 `docs/`：

```bash
# 可选：同步到 docs 供 Pages 使用
rm -rf docs && mkdir -p docs && cp -r frontend/* docs/
```

更换 Worker 域名时：改 `frontend/app.js` 的 `DEFAULT_API_BASE`，再同步到 `docs/` 并重新部署 Pages。  
GitHub Pages 为纯静态托管，无法读取 Cloudflare 环境变量；API 端点以构建时常量形式内置，前端 UI 不提供修改入口。

## 3. 前端使用

1. 年龄确认门（本地记录）
2. 输入 `350234` / `JM350234` / 专辑链接（无需配置 API）
3. 点章节进入阅读；图片经内置 Worker 代理并按 `decode_segments` 在 Canvas 上还原
4. 设置页仅可改主题 / 阅读背景

## API 速查（与 PHP 兼容）

```
GET /?jmid={id}
GET /?jmid={id}&chapter={photoId|id1,id2|@N|all}
GET /?jmid={id}&format=min
GET /?health=1
GET /proxy?url=https://cdn-msp.../media/photos/{id}/{file}
```

图片代理仅允许已知 JM CDN 主机名 + `/media/photos/` 路径。

## 目录结构

```
.
├── README.md
├── worker/
│   ├── package.json
│   ├── wrangler.toml
│   └── src/
│       ├── index.js      # 路由 / CORS / 限流 / proxy
│       ├── config.js     # 密钥与域名常量
│       ├── crypto.js     # AES-256-ECB (crypto-js)
│       ├── jm-client.js  # 上游请求与域名刷新
│       └── models.js     # 解析与 scramble 段数
└── frontend/
    ├── index.html
    ├── styles.css
    └── app.js
```

## 常见问题

**Worker 返回 502 / 上游不可用**  
禁漫 API 域名常变。确认本机可访问 `DOMAIN_SERVER_URLS` 列表，或等待 Worker 拉到新域名；绑定 KV 后缓存更稳。

**前端图片空白 / CORS**  
保持「经 Worker 代理图片」开启。直连 CDN 通常没有 CORS 头，Canvas 会污染。

**GitHub Pages 不能跑 PHP**  
正确。本方案 API 在 Cloudflare，Pages 只托管静态 HTML/JS。

## 许可与致谢

- 接口逻辑移植自 [ccbkkb/jmcomic-api](https://github.com/ccbkkb/jmcomic-api)（MIT）
- 算法渊源 [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python)
- 本仓库代码按 MIT 许可使用
