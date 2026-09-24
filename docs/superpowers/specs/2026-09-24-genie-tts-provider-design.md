# Genie-TTS 接入 provider 体系 + 情绪音色 参考设计

日期：2026-09-24｜状态：待审｜**本文件只写设计，未授权改任何业务代码**

## 1. 目标

让自建中文 TTS（Genie-TTS，VPS 本机 9882）成为一个**独立开关**而不是第 4 个 TTS provider，并支持按情绪切换音色；对话正文显示纯文本，情绪等 TTS 专属信息不可见。

**与初稿的关键差异（2026-09-24 用户决定）**：初稿把 Genie 设计成第 4 个 provider，要改 `TtsProvider` 联合类型、provider 归一化、Settings 四选一，并新增第 6 套 provider 专属语音提示词 + 8 处接线。改为独立开关后这些全部不需要：

- 不改 `TtsProvider` 联合类型，不加 `'genie'` 取值
- 不改 `utils/ttsProvider.ts` 的归一化
- **不新增第 6 套语音提示词，不改 `utils/promptPresetCatalog.ts` 及其 8 处接线**——复用现成那套教 `<语音 emotion="...">` 的指南即可，情绪值直接驱动参考音频选择
- Settings 从「四选一 radio」改为「一个开关 + 情绪下拉 + 试听」
- 开关默认**开启**；关闭时自动回退到原有 minimax / 鱼声 / ElevenLabs 三家，这三家代码**保留不动**

**非目标（明确不做）**：读错字/拼音修正。已验证 Genie 不支持（`ChineseG2P.py:41-43` 的 `pattern_filter` 会把 `<熬|ao2>`、`[熬|ao2]`、`熬(ao2)` 全部删成 `熬二`），且 Genie 公开输入只有文本、无请求级 phoneme 接口。唯一发音覆盖是服务端词表 `polyphonic.pickle`，不是请求级。

## 1.1 新增配置

`APIConfig`（`types.ts`）新增字段：

```typescript
/** Genie 自建中文语音。undefined 视为 true（升级后默认开启）。 */
genieVoiceEnabled?: boolean;
/** 情绪来源：'auto' 跟随 <语音 emotion>；'fixed' 固定用 genieEmotion。 */
genieEmotionMode?: 'auto' | 'fixed';
genieEmotion?: string;
```

读取必须用 `utils/genieTts.ts` 导出的 `isGenieVoiceEnabled(apiConfig)`，语义是 `apiConfig.genieVoiceEnabled !== false`（只有显式 `false` 才关闭），这样老用户的 `os_api_config` 没有该字段时自动开启。**不要在调用点散写 `!== false`，统一走这个函数。**

情绪解析规则（`utils/genieTts.ts` 的 `resolveGenieEmotion(options, apiConfig)`）：

1. `genieEmotionMode` 未设或 `'auto'` → 用 `options?.emotion`，不在 7 个白名单内则回落 `'calm'`
2. `'fixed'` → 用 `genieEmotion`，不在白名单内则回落 `'calm'`
3. 白名单 = `calm / happy / sad / angry / surprised / fearful / fluent`

## 2. 已实测的事实（执行时不要重新调查）

### 2.1 Genie 服务端

- API：`POST /load_character{character_name,onnx_model_dir,language}`、`POST /set_reference_audio{character_name,audio_path,audio_text,language}`、`POST /tts{character_name,text,split_sentence}`。
- **`/tts` 返回裸 PCM 无 WAV 头**，但 `content-type` 声明 `audio/wav`。已验证补 44 字节 RIFF 头后与 Python `wave` 模块输出**逐字节一致**。
- `set_reference_audio` 只写 dict，**不重载 ONNX session**；`load_character` 才重载，约 27 秒。
- **并发致命**：并发两条 `/tts` 实测一条 240 秒超时、另一条返回 2.4 倍长垃圾音频。根因 `Core/TTSPlayer.py` 是全局单例（`start_session` 清空队列并替换 callback，`Server.py:122-143` 允许多请求同时进 executor）。
- 性能：短句 3-4 秒；69 字长文本 `split_sentence=false` 15.4 秒产出 13.60 秒音频。
- `Core/Inference.py:9` 定义 `MAX_T2S_LEN=1000` 但未被使用；`:95-109` 最多解码 500 步且到上限仍返回 → **超长文本会静默截断**。
- 内存：稳态 RSS 4.6G，峰值 VmHWM 5.3G，`MemoryMax=5G`。多角色名 = 多份 session（`ModelManager` 按 `character_name` 缓存、不按 `model_dir` 去重），故**只用一个角色 `ether`**。
- 不需要 torch（仅 `convert_to_onnx` 用），已卸载。

### 2.2 情绪参考音频（已录，已验）

7 段，位于 VPS `/opt/genie-tts/refs/emo-<emotion>.wav`，44.1kHz mono。

| emotion | 时长 | 峰值 | RMS | 转写文本 |
|---|---|---|---|---|
| `calm` | 4.02s | 0.855 | 0.158 | 「今天过得怎么样，想不想听我讲讲今天遇到的事？」 |
| `happy` | 4.33s | 0.714 | 0.153 | 同上 |
| `sad` | 4.97s | 0.925 | 0.143 | 同上 |
| `angry` | 4.49s | 0.877 | 0.166 | 同上 |
| `surprised` | 4.09s | 0.919 | 0.162 | 同上 |
| `fearful` | 3.85s | 0.831 | 0.143 | 同上 |
| `fluent` | 3.55s | 0.770 | 0.142 | 「下午三点一刻开会，会上的资料我先发你。」 |

零爆音，RMS 一致（±8%）。**`disgusted` 未录**，任何未映射情绪回落 `calm`。

### 2.3 仓库现状

- 三个 provider（minimax/fishaudio/elevenlabs）都是**浏览器直连第三方公网 API**，经 `vite.config.ts:90-131` 代理。浏览器从未打过 VPS 语音。
- 浏览器→VPS 唯一现成通道：`api/backend-proxy.ts` 同源中转（`/agent/*`、`/amsg/*`）→ VPS Caddy `handle_path /agent/*`（剥前缀）→ main-agent 8830。
- main-agent 已有两个"转发到本机其他服务"的先例：`/v1/mcp-relay`（`index.js:785`）与 `/webdav*`（`index.js:788-791`）。
- Caddy **不需要改**。
- VPS 实际加载 `worker/main-agent/worker.bundle.js`（`vps-backend/config/services.js:47`），**改 src 后必须重建 bundle**。

## 3. 架构

### 3.1 浏览器 → VPS 数据流

```
浏览器 utils/genieTts.ts
  POST {agentUrl}/agent/v1/tts  { text, emotion }  ← 复用现有 agentUrl/agentToken
       （agentRouting 只 trim 不剥尾斜杠，客户端自己 replace(/\/+$/, '')）
  → functions/_lib/backendProxy.js 或 api/backend-proxy.ts（同源，剥 /agent）
  → VPS Caddy handle_path /agent/* → 127.0.0.1:8830
  → main-agent checkAuth → ttsProxy（无状态转发）
  → Genie 适配层 127.0.0.1:9882/speak
       ├─ 锁内：查情绪表 → 按需 POST /set_reference_audio
       ├─ 锁内：长文本按标点分块，逐块 POST /tts {split_sentence:false}
       ├─ 拼 PCM → 补 44 字节 WAV 头
       └─ 返回 200 audio/wav 完整文件，或 503 / 413
```

**关键边界**：情绪表、参考文件路径、分块策略、WAV 格式知识**全部在 VPS 适配层**。main-agent 只做鉴权与转发，不持有任何 TTS 状态。浏览器只传白名单内的 `emotion` 字符串，不知道文件路径。

**理由**：`set_reference_audio` + `/tts` 必须在同一把锁内完成，否则并发时会情绪串音（已实测）。若锁放在 main-agent 而 Genie 重启，main-agent 的情绪缓存不会失效，仍会错配。适配层与 Genie 同进程生命周期，无此问题。

### 3.2 适配层并发与排队

- 一把全局锁 + FIFO 队列，**同一时刻只允许一条合成**。
- **队列上限 2**：超出直接返回 `503 { error: 'busy' }`，不等待。
- 已开始的合成不可取消，必须持锁到音频读完或出错。
- 每次请求都 `set_reference_audio`（不做"情绪未变则跳过"的缓存）——去掉一个跨进程不一致的失效点，代价是每请求多一次本地 HTTP（<50ms）。
- **总超时**：锁等待 ≤ 5 秒，单次合成 ≤ 120 秒，超时释放锁并返回 504。

### 3.3 长文本分块

- 适配层按 `。！？；\n` 切分，每块累计 ≤ 60 字（实测 69 字 15.4 秒，60 字约 13 秒，可接受）。
- 每块发 `split_sentence: false`，块间拼 PCM，**整体只补一次 WAV 头**。
- 单块超过 120 字且无法再切（无标点的超长串）→ 413，不静默截断。
- 全文块数 > 20 → 413。

## 4. 组件与改动清单

### 4.1 VPS 侧（新增/修改，不在仓库内）

| 路径 | 改动 |
|---|---|
| `/opt/genie-tts/genie_server.py` | 加 `/speak` 端点：锁 + 队列 + 情绪表 + 分块 + WAV 包裹 + 错误传播。保留现有 `warmup()` 与 `start_server`。 |
| `/opt/genie-tts/refs/emotions.json` | 情绪表：`{emotion: {wav, text}}`，7 条。 |
| `/etc/systemd/system/genie-tts.service` | 不改（已有 `MemoryMax=5G`、4 线程、自启）。 |

情绪表内容（7 条，其余回落 `calm`）：
```
calm/happy/sad/angry/surprised/fearful → emo-<name>.wav + 「今天过得怎么样，想不想听我讲讲今天遇到的事？」
fluent                                   → emo-fluent.wav    + 「下午三点一刻开会，会上的资料我先发你。」
```

### 4.2 仓库侧

| 文件:行号 | 改动 |
|---|---|
| `types.ts`（`APIConfig` 内） | **新增** `genieVoiceEnabled?: boolean`、`genieEmotionMode?: 'auto' \| 'fixed'`、`genieEmotion?: string`。**不改** `TtsProvider`（第 403 行）、**不改** `voicePrompts`（第 446-451 行） |
| `utils/genieTts.ts` | **新建**。导出 `isGenieVoiceEnabled(apiConfig)`、`resolveGenieEmotion(options, apiConfig)`、`cleanTextForTtsGenie(raw)`、`synthesizeSpeechGenieDetailed(text, char, apiConfig, options?)` |
| `utils/ttsRouter.ts:31-45` | `assertTtsLanguageSupported`：Genie 开启时 `languageBoost` 非空即抛错（未验证粤语/日/韩） |
| `utils/ttsRouter.ts:47-62` | `synthesizeSpeechDetailed` 最前面加 Genie 分支（见下） |
| `utils/ttsRouter.ts:79-87` | `characterHasVoice`：Genie 开启时 **无条件 return true**（单一 ether 音色，无 per-char 配置） |
| `utils/ttsRouter.ts:90-96` | `canSynthesizeSpeech`：Genie 开启时 **无条件 return true**（无 API Key）。否则语音条永不显示 |
| `utils/ttsRouter.ts:99-104` | `cleanTextForTtsProvider`：Genie 开启时用 `cleanTextForTtsGenie` |
| `utils/ttsRouter.ts:106-111` | `stripTtsMarkupForDisplay`：Genie 开启时走 `cleanVoiceMarkupForDisplay` |
| `utils/ttsRouter.ts:114-115` | `providerUsesRawVoiceMarkup` 改为：Genie 开启 → `false`；否则 `p === 'fishaudio' \|\| p === 'elevenlabs'`。当前实现 `!== 'minimax'` 会把 Fish 的 `(laughs)` 原样送进 Genie |
| `utils/ttsCache.ts:44-72` | 复用现有缓存，但 Genie 的 key 必须含 `emotion`（见 §5） |
| `components/date/DateSession.tsx:352` | `const cacheKey = dialogueText;` → 必须并入 `currentLineEmotionRef.current`（emotion）与语种。当前同句 calm/sad 直接复用第一条音频 |
| `components/date/DateSession.tsx:384-393,405-425,496-500` | 同上，三处内存缓存键一并修 |
| `apps/Chat.tsx:713-727` | 下载/分享文件名后缀按真实 MIME 决定，Genie 是 `.wav` 不是 `.mp3` |
| `apps/CallApp.tsx:1205` | **必须改**。当前 `if (activeTtsProvider !== 'minimax')` 才进 router，而默认 provider 就是 minimax → **Genie 永远走不到**。改成 `if (isGenieVoiceEnabled(apiConfig) \|\| activeTtsProvider !== 'minimax')`。**只改这一小段路由，不动 CallApp 的提示词段** |
| `utils/ttsProvider.ts` | 新增 `setGenieVoiceEnabled` / `isGenieVoiceEnabledSync` 单例（供 `resolveVoiceActingGuide` 用，它拿不到 apiConfig） |
| `worker/main-agent/src/index.js:787 后` | 新增 `ttsProxy`（照 `webdavProxy` 模式：读 JSON body、转发到 `127.0.0.1:9882/speak`、原样回传 status/headers/body）+ 一行 `if (plain === '/v1/tts')`。**不持有情绪状态** |
| `worker/main-agent/src/index.test.ts` | 新增：鉴权失败、body 透传、503/504 透传、未知 emotion 透传 |
| `vite.config.ts` 代理段 | 新增 `'/agent'` dev proxy，target 取自环境变量（**禁止把 VPS 域名写进仓库**） |
| `utils/networkFailureDiagnosis.ts:426-430` | 相对路径 `/agent/v1/tts` 在 Capacitor APK 不可用；须走已配置的 `agentUrl` 直连（与现有 agent 调用一致） |

### 4.3 提示词：只加一小段 Genie 专属指南（2026-09-24 用户决定）

**核实结论（推翻初稿假设）**：初稿以为"复用现成那套教 `<语音 emotion>` 的指南"即可，实测不成立——

- `utils/promptPresetCatalog.ts:145`（`voice.minimax`）只教 `<#0.6#>` 停顿与呼吸节奏，**没提** `<语音 emotion>`
- `utils/promptPresetCatalog.ts:154`（`voice.fish`）**明文禁止**："别用圆括号 `(sighs)`、中文 `[轻声]`、全角【】、或 `<语音 emotion>` 属性"
- `voice.elevenlabsStd`（172 行）禁止一切标签；`voice.date`（181 行）教的是 `[v:xxx]`
- 真正教 `<语音 emotion="...">` 的是 `utils/chatPrompts.ts:1255-1256` 的硬编码块，但它在 `if (char.chatVoiceEnabled)` 分支内；`:1277` 的 else 分支**明令禁止**模型写语音标签
- `:1273` 追加的 `resolveVoiceActingGuide()` 返回的是 **按 provider 选的**指南——provider 若是鱼声，教的东西与 `:1256` 直接冲突

**解法（最小改动，3 个文件约 20 行）**：Genie 开启时，`resolveVoiceActingGuide()` 直接返回 Genie 专属短指南，不走 provider 选择。这样情绪标签必然被教到，且与任何 provider 指南不冲突。

| 文件:行号 | 改动 |
|---|---|
| `utils/chatPrompts.ts:52-63` | `resolveVoiceActingGuide()` 开头加一个分支：Genie 开启 → 返回 `GENIE_VOICE_ACTING_GUIDE` 常量（定义在本文件），不走 provider 选择 |
| `utils/chatPrompts.ts` | 新增 `GENIE_VOICE_ACTING_GUIDE` 常量（约 10 行）：教 `<语音 emotion="...">` 的 8 个取值、每条消息最多一个标签、不要复读文字 |
| `utils/ttsProvider.ts` | 新增 `setGenieVoiceEnabled` / `isGenieVoiceEnabledSync` 模块级单例（照现有 `setTtsProvider` 模式，因 `resolveVoiceActingGuide` 拿不到 apiConfig） |
| `context/OSContext.tsx:2158` 附近 | `apiConfig.genieVoiceEnabled` 变化时调 `setGenieVoiceEnabled`（与现有 `setTtsProvider` 同一处同步） |

**为什么指南字符串放 `chatPrompts.ts` 而不是 `promptPresetCatalog.ts`**：放进 catalog 就要连带改 `promptPresetSeeding.ts` 的迁移表（`:113-115` 会删整个旧 `voicePrompts` 对象，漏一处就会抹掉用户数据）、`presetEffective.ts`、`promptCallRegistry.ts`、以及快照测试——这正是初稿里"8 处接线"的来源。Genie 指南短且专用，v1 不可在预设面板里编辑；这是有意取舍，不是遗漏。

**仍然不改**：`voice.minimax` / `voice.fish` / `voice.elevenlabs*` / `voice.date` 四套现有指南正文一律不动；`chatPrompts.ts:1214-1277` 的主结构（`if chatVoiceEnabled` / `else` 禁止）也不动。

### 4.4 设置与角色页

| 文件:行号 | 改动 |
|---|---|
| `apps/Settings.tsx:3197-3254` | 在 provider 选择区**上方**新增「Genie 自建语音」开关（默认开）；下方新增情绪模式下拉（`auto` / `fixed`）与固定情绪下拉（7 项）；新增「试听」按钮。**不改** provider 四选一 |
| 角色页 | 新增「用这个声音试听一句」 |

试听是**新功能**，不是照抄。失败要显示可执行原因（如"Genie 未就绪"），不能静默无反应。

## 5. 缓存键

Genie 的缓存键**必须**至少含：`provider + normalizedEmotion + language + emotionManifestRevision + chunkPolicyVersion`。

- 缺 `emotion` → 同句 calm/sad 串音（`DateSession.tsx:352` 已是此 bug）
- 缺 `emotionManifestRevision` → 重新录制参考音频后旧缓存永久命中（`utils/ttsCache.ts:10-13` 明确不自动淘汰）

**容量**：32kHz/16-bit WAV ≈ 64KB/秒，比现有 MP3 大数倍。首版**Genie 不进长期共享缓存**（`utils/ttsCache.ts` 跳过），只走每消息语音资产。若要进，必须先加按总字节数的 LRU。

## 6. 错误契约

| 情况 | 适配层返回 | 浏览器行为 |
|---|---|---|
| 队列满（>2 等待） | 503 `{"error":"busy"}` | 走 `speakFallback`，出纯文本 |
| 锁等待超时（>5s） | 504 | 同上 |
| 合成超时（>120s） | 504 | 同上 |
| 文本过长（单块>120 字或块数>20） | 413 | 同上 |
| 未预热完成 | 503 `{"error":"warming_up"}` | 同上，试听要显示原因 |
| 合成内部异常 | 500 | 同上 |

**禁止**返回 `200` + 空或半截音频。Genie 原始行为是后台吞异常且 HTTP 200 已发出，适配层必须校验响应非空且完整。

## 7. 边界与禁止事项

1. **不改 Caddy**（`/agent/*` 已存在且剥前缀）。
2. **不改 `api/backend-proxy.ts` / `functions/_lib/backendProxy.js`**（二进制 body 已透明转发）。
3. **不把 VPS 域名或 Token 写进仓库**，一律走 `agentUrl`/`agentToken`/环境变量。
4. **不改 `context/OSContext.tsx:2158-2167`**（provider 与 voicePrompt 同步是通用的）。
5. **不新增 Genie API Key**。
6. **不动** `gptsovits` 相关（已删除，不恢复）。
7. 不做拼音/SSML/多角色音色。
8. `MemoryMax=5G` 不上调。8G 机器上还要留给 sullyos 后端与其他 MCP 服务。
9. 参考音频与其转写文本只存 VPS，不进 localStorage、不进备份导出。
10. **部署顺序**：先 VPS 适配层就绪并自测通过，再改仓库代码。仓库侧未部署前不影响现有三家。

## 8. 验收

### 8.1 VPS 侧（localhost 可做）

1. `curl -X POST 127.0.0.1:9882/speak -d '{"text":"你回来啦。","emotion":"happy"}'` → 200、`content-type: audio/wav`、首 4 字节 `RIFF`
2. 同上 `emotion` 传未映射值（如 `foo`）→ 200 且**音色等同 calm**（回落生效）
3. 两条并发 `curl` → **两条都 200**，均非 240 秒超时，均长度合理
4. 队列 3 条并发 → 第 3 条 503，前 2 条 200
5. 400 字无标点文本 → 413（不静默截断）
6. 69 字带标点文本 → 200 且音频秒数 ≈ 字符数 × 0.2 ±20%
7. `python -c "读 /proc/<pid>/status 的 VmHWM"` 压测后不越 5G

### 8.2 仓库侧（localhost 可做）

1. `pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts components/date` 全绿
2. `pnpm vitest run worker/main-agent` 全绿
3. `pnpm vitest run utils/promptPresetCatalog utils/presetEffective utils/promptPresetSeeding` 全绿
4. `npx tsc --noEmit` 本次触碰文件零命中（基线有存量错误，见 `notes/ethernet-branch-context.md`）
5. 重建 bundle：`node scripts/build-workers.mjs`，产物 `worker/main-agent/worker.bundle.js` 含 `/v1/tts`
6. `pnpm vitest run utils/mojibakeGuard.test.ts` 绿 + U+FFFD 字节扫零
7. 手动过一遍：设置页选 Genie → 试听出声；Chat 选 Genie → 自动合成
8. **回归 §5 的 DateSession 缓存 bug**：在约会页让**同一句台词**分别以 `calm` 和 `sad` 触发语音，两次音频**必须不同**。注意这条验的是 `DateSession.tsx:352` 的 `voiceCacheRef` 进程内缓存，与 `utils/ttsCache.ts` 共享缓存无关（后者首版跳过 Genie）。若两者只改其一，这条会假通过。

### 8.3 需要线上环境（部署时）

VPS pull + 重启 main-agent 后，手机端真实链路冒烟：选 Genie → 收一条语音 → 下载文件能播。

## 9. 执行分期

范围偏大，拆成两个可独立验收的阶段。**必须按序**，阶段 A 不通过不要进阶段 B。

**阶段 A：VPS 适配层 + 最小可用链路**（对应 `docs/superpowers/plans/2026-09-24-genie-tts-provider-phase-a.md`）
- VPS：`/speak` 端点（锁、队列上限 2、情绪表、分块、WAV 包裹、错误传播、readiness、**用 `save_path` 是否生成作为合成成功信号**）+ `emotions.json`
- 仓库：`types.ts`（只加 3 个配置字段）、`utils/genieTts.ts`（新建）、`utils/ttsRouter.ts`（7 处分流）、`apps/CallApp.tsx:1205`（补漏接）、`utils/ttsProvider.ts`（单例）、`utils/chatPrompts.ts`（Genie 短指南）、`context/OSContext.tsx`（单例同步）、`worker/main-agent/src/index.js` + 其测试 + bundle 重建、`vite.config.ts` dev proxy
- 验收：§8.1 全过 + §8.2 的 1-6 条。此阶段结束时 `/agent/v1/tts` 可用，但**没有 UI 开关**，且默认关闭（见 §10.1），所以对现有用户零行为变化。

**阶段 B：用户可见面 + 缓存修正**
- `apps/Settings.tsx`：开关 + 情绪模式 + 固定情绪 + 试听。**开关 UI 的默认勾选状态为开**，用户第一次保存即写入 `genieVoiceEnabled: true`（这就是"默认开启"的落地方式）
- 角色页：试听
- `DateSession.tsx` 缓存键（4 处）、`ttsCache.ts` 让 Genie 跳过共享缓存、`Chat.tsx:713-727` 与 `CallApp.tsx:1416-1422` 下载后缀改 `.wav`、`networkFailureDiagnosis.ts` 的 Capacitor 说明
- 验收：§8.2 全过 + §8.3 冒烟。

拆分理由：阶段 A 是纯接口，可独立压测与回滚；阶段 B 触面最广，出问题时能立刻判定在 UI/缓存层而非合成层。

## 9.1 改为开关方案后的工作量变化

初稿阶段 B 要碰 16 个文件（含 8 个提示词接线点），改后降到 7 个。提示词只多出 3 个文件、约 20 行（`chatPrompts.ts` 的短指南 + `ttsProvider.ts` 单例 + `OSContext.tsx` 同步），不进 `promptPresetCatalog.ts`，因此**不碰** `promptPresetSeeding.ts` / `presetEffective.ts` / `promptCallRegistry.ts` 那条会抹用户数据的迁移链。

## 10. 用户已定的决策（2026-09-24）

1. **队列上限 = 2**。第 3 条并发直接 503 走纯文本回退，不等待。
2. **`disgusted` 不补录**。陪伴场景用不上，且最容易录假；所有未映射情绪回落 `calm`。
3. **试听放设置页 + 角色页两处**。
4. **情绪来源靠加一小段提示词**（`chatPrompts.ts` 的 Genie 专属短指南），不改 catalog 现有四套指南。
5. **原三家 minimax / 鱼声 / ElevenLabs 保留**，作为开关关闭时的回退路径。

## 10.1 「默认开启」的正确落地方式（重要）

用户要的是"默认开启"，但**阶段 A 不能这么做**：

- 阶段 A 没有 UI 开关。若把 `undefined` 视为开启，所有老用户升级后会被立刻切到 Genie，且**界面上无法关掉**。
- 同时 `characterHasVoice` / `canSynthesizeSpeech` 在开启时无条件为真，会让语音条对所有人出现——包括没配主代理、Genie 未部署、非中文朗读语种、Date 缓存串音的情况。
- 这与阶段 A「对现有用户零行为变化」的前提直接矛盾。

因此：

- **阶段 A**：`isGenieVoiceEnabled(apiConfig)` 语义为 `apiConfig.genieVoiceEnabled === true`，即**纯 opt-in**。`resolveGenieEmotion` 回落 `calm` 的逻辑不变。
- **阶段 B**：Settings 的开关 UI 默认勾选为「开」，用户第一次保存配置时写入 `genieVoiceEnabled: true`。这才是"默认开启"——新用户/首次进入设置的用户会看到它已勾上，老用户在此之前保持原样。
- 若用户希望**老用户升级即生效**，那需要一次显式的数据迁移（给 `os_api_config` 补写 `genieVoiceEnabled: true`），并且必须先把 Date 缓存键、设置开关、readiness 一起做完，即等同提前执行阶段 B 的部分内容。**当前不做**，留到阶段 B 结束时单独决定。

## 11. 已知不做的后续项

- `agentToken` 备份脱敏遗漏（`utils/backupSecrets.ts:29-32` 漏了它）——**是既有泄漏，与本需求无关**，单独处理。
- `ttsRouter` 对纯英文的支持未实测，Genie 路径先只保证中文（含中英自动 hybrid）。
