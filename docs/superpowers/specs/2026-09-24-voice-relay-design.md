# 语音中转搬 VPS 设计（方案 A：独立服务）

> 创建：2026-09-24。状态：待用户 review。用户已决策：独立服务，不并入现有后端。

## 目标

7 个语音接口从 Vercel serverless 搬到 VPS 自建服务，前端零改动；
密钥仍由客户端请求头携带（现行防烧 key 设计不变），服务端不存密钥。

## 接口清单（逻辑平移，不改语义）

| 方法路径 | 来源 | 上游 |
|---|---|---|
| POST /api/minimax/t2a | `api/minimax/t2a.ts:3-56` | minimaxi.com / minimax.io（region 头优先） |
| POST /api/minimax/voice-clone | `api/minimax/voice-clone.ts` | /v1/voice_clone 透传 |
| POST /api/minimax/upload | `api/minimax/upload.ts` | /v1/files/upload（multipart 原样转发） |
| POST /api/minimax/get-voice | `api/minimax/get-voice.ts` | /v1/get_voice 透传 |
| POST /api/minimax/bake-voice | `api/minimax/bake-voice.ts` + `_bakeVoiceCore.ts` | 内部三步编排 |
| POST /api/fishaudio/tts | `api/fishaudio/tts.ts` | api.fish.audio/v1/tts（二进制透传） |
| POST /api/elevenlabs/tts | `api/elevenlabs/tts.ts` | /v1/text-to-speech/{id}/stream（二进制透传） |

`/api/minimax/music` 无服务端文件（靠前端 404 回退直连），保持现状，不补。

## 架构

- 新原生服务 `vps-backend/src/voice-relay/run.js`，抄 `mastodon-mcp`/`xhs` 模板：
  读 `/opt/sullyos/.env`、监听 `127.0.0.1:8839`（已验空闲，见审查注记）。
- 直接 import 仓库 `api/*` 的 handler（复用逻辑，零漂移），外包一层极简路由：
  路径分发 + query 解析 + raw body 透传 + `api/_cors.ts` 同款 CORS（`Allow-Origin *`）。
  若 VPS 无 TS 运行时则改薄改写（plan 阶段按 vps-backend 实际 toolchain 定，以测试为准）。
- 服务自己解析 JSON 请求体（Vercel 自动解析，plain node 需手动；multipart 上传走 raw passthrough）；
  未知 `/api` 路径一律 404（保住 music 回退语义）；另加 `/api/health` 供探针。
- systemd 独立 unit `voice-relay.service`（抄 `deploy/mastodon-mcp.service`），
  与 `sullyos.service` 并存；无 pm2。
- Caddy `ethernet.bot.cd` 块：`/api/*` 的 `reverse_proxy` 目标从
  `https://sully-os-plsvena.vercel.app` 改为 `127.0.0.1:8839`（一行），其余不动。
- 前端、推送、其他后端一概不动。

## 配置（非密钥）

- `MINIMAX_REGION`、`MINIMAX_GROUP_ID`、`FISH_MODEL`（缺省 s2.1-pro）：
  实施时用只读 API 读出 Vercel 现值，原样写入 VPS `.env`（值在执行时抄，不进文档）。
- elevenlabs 无需服务端配置。

## 验证

1. 单测：路由映射（7 路径命中）+ CORS 预检 + 404 行为（`/api/minimax/music` 仍 404）。
2. 上游调用用 mock 断言透传形状（method/headers/body 原样），不烧真实 key。
3. 上线探针：`/api/*` 经 Caddy 到本地端口 200 系；真 key 实测由用户在手机端打一次电话确认。
4. 回滚：Caddy 一行改回 Vercel + reload，停新服务；旧链路全程保留。

## 非目标

- 不补 music 端点；不改前端；不动 Vercel 项目（观察期后另行确认删除）；
  不动 Pages（另行收尾）；不碰其他 VPS 服务与 Caddy 块。
