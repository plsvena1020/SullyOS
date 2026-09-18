# 音乐 App — 网易云音乐接入说明

## 架构

```
用户浏览器 (GitHub Pages 静态前端)
   │  POST /netease/{search,song/url,lyric,...}
   │  Header: X-Netease-Cookie: MUSIC_U=xxx
   ▼
sully-n Worker (Cloudflare Workers, 国内可访问, 免费)
   │  转成 api-enhanced 标准 GET 请求, 加 realIP
   ▼
api-enhanced (部署在 Vercel, 免费 Hobby 计划)
   │  处理加密/协议适配, 转发到网易云
   ▼
music.163.com
```

**重点**: 用户只接触 GitHub Pages + CF Worker, **根本不会直连 Vercel**。Vercel 是 Worker 自己去调的,所以国内用户没有墙的问题。

## 一次性部署 (作者/管理员做)

### 第一步:把 api-enhanced 部署到 Vercel

1. 打开 <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>
2. 右上角 Fork 一份到你自己账号下
3. 打开 <https://vercel.com/new> → 选 "Import Git Repository"
4. 选你刚 Fork 的那个 `api-enhanced`
5. 直接 Deploy (不用改任何设置)
6. 部署完成后得到一个形如 `https://api-enhanced-xxxx.vercel.app` 的地址 → 复制它

### 第二步:改 Worker

打开 `worker/index.js`,找到开头附近这一行:

```js
const NETEASE_API_BASE = "https://请把这行改成你的vercel地址.vercel.app";
```

替换成你刚才 Vercel 给你的地址,保存,重新部署 Worker。

### 第三步:验证

打开音乐 App → 右上齿轮 → "一键诊断(搜索晴天)",应该看到:
- `HTTP 200`
- `code=200`
- `songs=3`

## 用户侧使用

1. 打开音乐 App → 右上齿轮
2. 粘贴 `MUSIC_U=xxx` (从 music.163.com 的 Cookie 里复制)
3. 保存 → 搜歌 → 播放

## 为什么这样架构

### 为什么不直接在 Worker 里实现网易云加密

试过了,自己写 weapi 加密算法能跑通,但网易云 2024 年后对部分接口改了响应,会返回一个 `{"result":"<hex>"}` 的加密响应,得解密才能用。`api-enhanced` 一直在跟进这些协议变化, 自己造轮子追不上。用它省心。

### 为什么 Vercel 不会乱扣钱

Vercel 的 Hobby 免费计划:
- 100 GB 流量/月
- 100 万 Edge 请求/月
- 超了**会停服但不会自动收费**(需要用户主动升级到付费计划才能收费)

和 Netlify 的付费带信用卡绑定模式**不一样**。

### 为什么不让用户自己部署 api-enhanced

5000 用户大部分不会部署。由管理员统一部署一份,用户共享,才是可行路径。如果有能力的用户想自建,只需要 fork api-enhanced 到自己 Vercel,把得到的 URL 填进 App 设置里的 "后端 Worker 地址"... 等等,这里要说明:目前 App 设置里填的是 Worker URL,不是 Vercel URL。想换也可以,但正常用户不需要折腾。

## API 接口(前端 → Worker)

所有都是 `POST application/json`,Header `X-Netease-Cookie: MUSIC_U=xxx`(可选)。Worker 会自动转成 GET 转发给 Vercel 上的 api-enhanced。

| 路径 | Body | 说明 |
|------|------|------|
| `/netease/search` | `{ keyword, limit?, offset? }` | 搜索单曲 |
| `/netease/song/url` | `{ ids:[id], level? }` | 播放链接 |
| `/netease/lyric` | `{ id }` | 歌词 |
| `/netease/song/detail` | `{ ids:[id] }` | 歌曲详情 |
| `/netease/login/status` | `{}` | 当前 cookie 登录状态 |
| `/netease/user/playlist` | `{ uid }` | 用户歌单 |
| `/netease/playlist/detail` | `{ id }` | 歌单详情 |

## 酷狗概念版来源（2026-09-08 起，默认音源）

第二条音源链路，与网易段完全平行（新增路由，网易零改动）：

```
浏览器  POST /kugou/<action> + Header X-Kugou-Cookie: token=..;userid=..;dfid=..;auth=..
   ▼
sully-proxy Worker  (worker/index.js 的 /kugou/* 路由, 白名单+边缘缓存+多上游)
   ▼
KuGouMusicApi  (用户自部署 MakcRe/KuGouMusicApi 到 Vercel, 环境变量 platform=lite)
   ▼
酷狗服务器
```

- **上游项目**：https://github.com/MakcRe/KuGouMusicApi （仿 NeteaseCloudMusicApi 风格；`platform=lite` = 概念版，token 与标准版不通用，扫码必须用概念版 App）。
- **上游地址配置**：CF env `KUGOU_UPSTREAMS`（逗号分隔，优先）或 worker/index.js 里的 `KUGOU_UPSTREAMS` 常量。
- **action 白名单**：search、search/lyric、lyric、song/url（→ `/song/url/auth/merge`）、user/verify、user/detail、user/vip/detail、user/playlist、playlist/track/all(/new)、everyday/recommend、personal/fm、user/listen、lastest/songs/listen、register/dev、refresh/login、login/qr/key|create|check、login/cellphone、captcha/sent。
- **实测结论（本地探针，platform=lite）**：`/register/dev` dfid 在 `data.dfid`；`/login/qr/key` 一步返回 `data.qrcode`(key) + `data.qrcode_img`(自带 data: 前缀的 base64 PNG)，无需再调 create；`/login/qr/check` 状态在 `data.status`（0 过期 1 等待 2 已扫 4 成功返 token）；**匿名搜索（仅 dfid cookie）返回 error_code:152**——酷狗强制登录态搜索，未登录时 UI 提示先登录。
- **歌曲标识**：酷狗用 hash（32 位 hex）+ album_id/album_audio_id 换播放 URL；`Song.source==='kugou'` + `hash` 字段，`Song.id` 用 albumAudioId 兜底。
- **音质**：standard→128、higher/exhigh→320、lossless→flac、hires→high（VIP 权益决定实际能否取到）。
- **歌词**：两步链 `/search/lyric?hash=` → `/lyric?id&accesskey&fmt=lrc&decode=true` 返回 `body.decodeContent`（LRC 明文）；无翻译歌词（tlyric 置空）。
- **登录不会挤掉手机**：验证码登录带 `support_multi:1` 多登录态并存；设备列表/踢下线（get_dev/dev_logout）是独立显式接口。
- 前端纯函数层 `utils/kugouCore.ts`、API 对象 `context/MusicContext.tsx` 的 `kugouApi`；设计与执行计划见 `docs/superpowers/specs|plans/2026-09-08-kugou-music-source.md`。
