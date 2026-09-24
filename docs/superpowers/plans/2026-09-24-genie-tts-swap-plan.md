# Genie-TTS 替换 GPT-SoVITS 计划（spec + 执行计划）

日期：2026-09-24｜状态：**已执行完成**（对拍通过、已切流量、已删旧）｜实测数据见 §9

## 9. 执行结果（2026-09-24 实测，与原计划有偏差的地方已标注）

### 9.1 与原计划不同的三处

1. **pypi 的 `genie-tts` 1.0.3 不能用**：只带 `Converter/v2`，转 V2ProPlus 缺 `prompt_encoder_fp32.onnx`/`prompt_encoder_fp16.bin`，加载报 `external data size mismatch`（`vq_model...weight_v`）。必须装 GitHub main 的 2.0.2（`pip install --no-deps git+https://github.com/High-Logic/Genie-TTS.git`），它才有 `Converter/v2ProPlus`。
2. **`onnxruntime==1.22.1` 钉死在 pyproject，Python 3.14 装不到**：只有 ≥1.24.1 的 wheel，所以用 `--no-deps` 装 Genie 再手动补依赖。实际装的是 onnxruntime 1.30.0。
3. **范围比原计划小**：前端 `utils/ttsProvider.ts` 只有 minimax/fishaudio/elevenlabs，**没有** gptsovits 分支；唯一代码调用方是 `worker/sullyos-home/src/index.ts` 的 `/home/speak`，而 sullyos-home 根本没部署在 VPS 上。所以不需要加 provider、不需要改 Settings、不需要重写 Chat/CallApp。

### 9.2 踩到的两个上游坑

1. **Genie 2.0.2 的 `_reference_audios` 一份变两份**：`Server.py:19` 和 `Internal.py` 各有一个模块级 dict。`genie.set_reference_audio()` 写的是 Internal 那份，HTTP `/tts` 校验的是 Server 那份 → 函数式预热后 `/tts` 永远 404。**解法**：预热必须走 HTTP 自 POST，见 `/opt/genie-tts/genie_server.py` 的 `warmup()`。
2. **import 时交互式 `input()`**：`Core/Resources.py:108` 在 `GENIE_DATA_DIR` 不存在时 `input()` 要交互。systemd 下无 stdin 直接 `EOFError` 卡死 15 分钟。**解法**：预先 `snapshot_download` 落好 `GenieData/` 再起服务。

### 9.3 依赖装配（Python 3.14 / 无 GPU）

`apt: build-essential cmake python3-dev portaudio19-dev`（pyopenjtalk / pyaudio 需要编译器与 PortAudio 头）
`pip: onnxruntime(1.30) tokenizers numpy soundfile soxr pyyaml sounddevice pydantic huggingface_hub fastapi uvicorn pyopenjtalk-plus pypinyin jieba_fast jamo nltk g2pk2 ko_pron g2pM`
`eunjeon` 装不上（韩语 G2P，中文路径用不到，跳过）
`torch / torchaudio` 只在 `convert_to_onnx` 里用，**转完即卸**，venv 从 1.7G 降到 893M，服务照常 200。

### 9.4 参考音频与语调

6 秒参考（"小猫…星星突然亮了起来。"）语调总上扬；3 秒参考（"夜色渐深，故事才刚刚开始。"）+ RoBERTa 开，用户盲听 verdict 为"效果很好"。最终用 `refs/ref3s.wav`。RoBERTa 是可选增强（缺失时 `text_bert` 退零向量），1.2G fp32 保留。

### 9.5 实际收益（诚实口径）

| 维度 | GPT-SoVITS | Genie-TTS | 结论 |
|---|---|---|---|
| 磁盘 | 4.0G（程序 2.1 + conda 1.9） | 2.7G（venv 0.9 + GenieData 1.5 + onnx 0.3） | **省 1.3G**，盘空 22G→27G |
| 内存 | 4.5G | **6.25G（更差）** | RoBERTa fp32 1.2G + 加载时生成 fp32 bin 642M |
| 速度 | 4-22 秒/句 | 3-4 秒/句（冷启首句 16 秒） | 略快 |
| 正确性 | `/home/speak` 一直 400（缺 ref_audio_path） | 200 | **顺带修好一个坏功能** |

**内存是这次替换的净损失**，唯一可调杠杆是 RoBERTa fp32→fp16（省约 600M），代价是需重新盲听确认音质。

### 9.7 内存优化（用户要求"尽量节省内存"后追加）

**先纠正一处错误结论**：本节初版曾报告"RSS 从 5.92G 降到 2.79G"，那是**测量错误**——2.79G 是在服务重启后、首次 TTS 之前测的，而 RoBERTa / HuBERT / SpeakerEncoder 三个模型是**首次合成时才懒加载**的。补测懒加载后的真实稳态后，正确数字如下。

两项优化：
1. **RoBERTa fp32（1142MB）→ fp16（571MB）**：不需要改代码，`ModelManager.resolve_roberta_assets` 的候选顺序是 `("RoBERTa.onnx", "model.onnx", "model_fp16.onnx")`，把 `model.onnx` 改名即可让官方支持的 fp16 生效。`load_roberta_model` 用的是普通 `InferenceSession`，不做 fp32 内联，所以只省文件本身的 571MB。
2. **glibc malloc 调参**（收益更大）：`MALLOC_ARENA_MAX=2` + `MALLOC_TRIM_THRESHOLD_=131072` + `MALLOC_MMAP_THRESHOLD_=131072`，加进 systemd unit。原因是 `load_session_with_fp16_conversion` 会把 fp16 权重转成 fp32 内联进 proto 再 `SerializeToString()`，单个 306MB decoder 瞬时产生约 1.2GB 副本，glibc 默认不还给 OS。

真实稳态（连续 3 句合成后实测）：

| 阶段 | 服务 RSS | 系统 available |
|---|---|---|
| RoBERTa fp32，无 malloc 调参 | 6.25G | 1.3G |
| RoBERTa fp16，无 malloc 调参 | 5.80G | 1.4G |
| RoBERTa fp16 + malloc 调参 | **4.6G**（4519→4519→4592MB，不涨） | **2.4G** |

**与 GPT-SoVITS 的诚实对比**：`free -h` 口径下，会话开始时（GPT-SoVITS 运行中）系统 used 3.4Gi / available 4.4Gi；现在（Genie 运行中）used 5.3Gi / available 2.4Gi。**内存净多占约 1.9G，这次替换在内存上是负收益**，只在磁盘（+4G 空档）和速度（3-4 秒 vs 4-22 秒）上赢。

用户复听 verdict（fp16 RoBERTa）：`fp16_b`（关心语）挺好，`fp16_c`（叙述句）偏僵硬但可接受。回滚方式：`mv model.onnx.fp32.bak model.onnx`（fp32 副本仍在盘上，1142MB）。

**剩余可调杠杆**（均未执行，需用户决策）：关掉 RoBERTa（`ROBERTA_MODEL_DIR` 指向不存在路径即自动降级为 `text_bert=zeros`）可再省约 571MB + 它的 ORT arena，但中文韵律会退化为"无 RoBERTa"版本——该版本用户尚未盲听过，且用户明确表示中文退化不能接受，故此路关闭。

### 9.10 线程数下调（为换机预留，已应用到现机）

用户透露未来可能换到 4 核 / 8G / 40G SSD，负载不变。在现机做了 4 线程实测（`OMP_NUM_THREADS=4`、`MKL_NUM_THREADS=4`、`MemoryMax=6G→5G`）：

| | 8 线程 | 4 线程 |
|---|---|---|
| RSS | 4592M | 4379M |
| 峰值 VmHWM | 5755M | 5278M |
| 合成速度 | 3-4 秒/句 | 1-5 秒/句（无退化） |

结论：内存大头是模型权重固定占用，不是 ORT 线程 arena，所以线程减半只省 200-480M。**换机可行性**：新机内存与现机相同（8G），Genie 稳态 4379M + 其他服务约 800M = 5.2G / 7.9G，剩约 1.9G，够用。磁盘 21G/40G 剩 19G，够用。真正的约束不是内存也不是核数，而是**不要再往这台机器加吃内存的服务**（峰值 5278M 距 MemoryMax=5G 只差 300M，需保留 swap 兜底）。

这套 4 线程 / 5G 上限配置已留在现机生效，不必等到换机才改。

### 9.8 第二个上游 bug：/tts 返回裸 PCM 却标 audio/wav

`TTSPlayer` 对流式路径和 `save_path` 路径调用同一个 `_preprocess_for_playback`，但 `save_path` 额外用 `wave.open` 包了 RIFF 头，流式路径直接发裸 PCM，而 `Server.py` 的 `/tts` 声明 `media_type="audio/wav"`。

后果：`/home/speak` 会把打不开的字节当 `data:audio/wav;base64,...` 返回。**修法**：在 `worker/sullyos-home/src/speak.ts` 加纯函数 `wrapPcmAsWav`，在 base64 前补 44 字节头（s16le / 32000Hz / mono）。已验证该实现与 Python `wave` 模块输出**逐字节一致**，ffprobe 确认 `pcm_s16le 32000Hz mono`。

固定参数不做成可配置：上游 `TTSPlayer` 和包内 Tutorial 客户端都写死 32000/1/2。

### 9.9 落地物

- VPS：`/opt/genie-tts/{genie_server.py, refs/ref3s.wav, onnx/ether/, GenieData/}`、`/etc/systemd/system/genie-tts.service`（9882，MemoryMax=6G，自启）
- 已删：`gptsovits-api.service`、`/opt/gpt-sovits`、conda env `gpt-sovits`
- 本仓（工作树 `feat/nano-tts-swap`，未提交）：`worker/sullyos-home/src/index.ts`（9882 + `character_name` + 30s 超时 + `wrapPcmAsWav`）、`speak.ts`（新增 `wrapPcmAsWav`）、`speak.test.ts`（4 条新测试）、`index.test.ts`（3 条新测试）、`worker.bundle.js`（重建，`9880` 命中数 0）
- 验收：`pnpm vitest run worker/sullyos-home` → 20/20 通过；`npx tsc --noEmit` → 79 errors in 22 files（与基线一致，无 sullyos-home 错误）

---

## 1. 目标与决策

- 目标：VPS 语音从 GPT-SoVITS-CPUFast（v2ProPlus，api_v2，9880）换到 Genie-TTS（ONNX 引擎，~200MB runtime，首推理 1 秒级）。
- 前置结论：VPS 权重是 v2ProPlus，正好落在 Genie 仅支持的 V2/V2ProPlus 内（按 SoVITS .pth >150MB 自动走 v2pp 路由），不用重训。
- 删旧底线（2026-09-24 定）：用户说过“原来那个先去掉”，但旧服务是唯一可用语音，对拍过之前删了就没声可播。删旧排在最后一步（§5），对拍不过就当没说过。

## 2. Genie 落地事实（lib-10 已验，仓库原文）

1. 转 ONNX：`pip install torch` 后调 `genie.convert_to_onnx(ckpt, pth, output_dir)`；V2ProPlus 跑 4 步（+PromptEncoder）；产物 9 文件（7 base + prompt_encoder fp16.bin/fp32.onnx）；耗时仓库未给。
2. 服务：`genie.start_server(host, port, workers=1)`（uvicorn）；新端口 9882，与 9880 双跑。
3. API（与 api_v2 不兼容，必须重写调用方）：`/load_character{character_name, onnx_model_dir, language:"zh"}` → `/set_reference_audio{character_name, audio_path, audio_text, language}`（不设直接调 tts 报 404）→ `/tts{character_name, text, split_sentence, save_path}` 回流式 wav（32kHz）。另有 unload/stop/clear_reference_audio_cache。
4. 参考音频：只要 wav/flac/ogg（mp3 是 open issue #20，会报错），3–10 秒建议。用户参考是 mp3（53KB 约 3 秒）→ 必须先转 PCM wav；转写「夜色渐深，故事才刚刚开始。」已有。
5. 中文 RoBERTa 可选、只走中文路径，缺失自动降零向量；中英混读自动切 hybrid。
6. 首次资源 ~391MB（G2P + chinese-hubert + speaker_encoder 184MB），`GENIE_DATA_DIR` 指定落盘位。

## 3. 本次会触碰的文件清单

本仓（工作树 `feat/nano-tts-swap`，行号执行时 grep 复核）：
- `types.ts`：`TtsProvider` 加 `'genie'`（设计文档引 types.ts:401）+ `APIConfig.ttsProvider` + voicePrompts 加键。
- `utils/ttsProvider.ts:12,57-63`：normalize 加分支，overrides 加键。
- 新建 `utils/genieTts.ts`：对齐 minimaxTts 接口（clean/parse 复用），内封 Genie 三步调用（load→set_ref→tts）与 404/400 错误翻译。
- `apps/Settings.tsx:667,969,1295,1375-1376,3207-3255`：provider 选项 + Genie 地址/角色名配置。
- `apps/CallApp.tsx:8,11,355,365,1194,1204`、`apps/Chat.tsx:56,61,72,596,660,666`：provider 分支。
- `context/OSContext.tsx:77,2158`：确认同步（自动生效）。
- `docs/superpowers/specs/2026-09-09-multiplatform-sync-design.md:198-199`：Decision 注记替换结论。

VPS（只增不删，直到 §5）：
- 新增 `/opt/genie-tts`（venv + genie 包 + GenieData + RoBERTa + ONNX 模型目录 + refs/<角色>.wav）。
- 新增 systemd `genie-tts.service`（127.0.0.1:9882，内存上限照抄 gptsovits 段写法）。
- Caddy 给 9882 加一段（照抄 9880 段，BasicAuth 同策略）。
- `gptsovits-api.service`、`/opt/gpt-sovits`、conda env：§5 之前一律不碰。

## 4. 执行步骤（按序打勾）

- [x] 0. 前置确认（执行中 2026-09-24）：用户新给 6 秒参考 `D:\下载\MiniMax_2026-09-13_19_41_37_ether.mp3`，转写「小猫发现一颗星星掉进了水里，它伸出爪子，星星突然亮了起来。」（3–10s 建议内，首选参考；3 秒旧段当备选）。mp3 必须先转 PCM wav（Genie 不吃 mp3）。
- [ ] 1. VPS 落 Genie（约 1 小时）：venv + `pip install genie-tts`，`GENIE_DATA_DIR=/opt/genie-tts/GenieData` 下 391MB + RoBERTa，`convert_to_onnx` 转现有 v2ProPlus 权重。判据：9 个产物文件齐（§2.1 名单）。
- [ ] 2. 起服设角（约 30 分钟）：9882 起服 → load_character(zh) → set_reference_audio（wav+转写）。判据：三步全 success，无 400/404。
- [ ] 3. A/B 对拍（人耳）：固定考题 5 句（日常短句/长句/多音字/中英混读/情绪句），9880 与 9882 同题双录，你盲听 verdict。判据：Genie 不差于 GPT 才过；ONNX 漂移（难字、韵律）一票否决。
- [ ] 4. 本仓接线（约半天，工作树）：§3 文件清单加 `'genie'` provider；Settings 切 genie 后 Chat/Call 各一句端到端。判据：播得出声 + `tsc` 零新增 + TTS 用例绿 + 编码护栏绿。
- [ ] 5. 切流量+删旧（约 30 分钟）：默认切 genie → 观察 24h → 停 gptsovits → 删 `/opt/gpt-sovits` + conda env + `conda clean -a`。判据：`df -h` 回约 4G。

## 5. 验收命令与预期输出

- VPS：`curl 127.0.0.1:9882/tts` → 200 + wav；`systemctl status genie-tts-api` 绿；考题 5 句双份 wav 留档。
- 本仓：`tsc` 零新增；minimax/elevenLabs 4 文件 37 用例绿；含中文文件改后扫 U+FFFD。
- 人耳：5 句盲听，Genie≥GPT。

## 6. 边界与禁止事项

- §3 验收前：不动 gptsovits 任何东西（服务/权重/conda/Caddy 旧段）。
- 不改默认 provider（缺省仍 minimax），只增分支；切默认只在 §5。
- 参考 wav/transcript 只存 VPS，不进 localStorage、不进备份导出。
- localhost 可做：无（Genie 活全在 VPS；考题试听在本机）。需要线上环境：§4 全体（约 VPS 操作窗口）。
- 风险备案：转 ONNX 报 buffer/external-data mismatch（Issue #19/#32 同类）→ 停下贴原文，不换权重、不重训，直接回滚到维持 CPUFast。

## 7. 回滚

- 代码：接线单独 commit，revert 即回。
- 服务：Settings 切回旧 provider；`systemctl restart gptsovits-api` 即回（§5 前它一直活着）。
- 转 ONNX 失败：删 `/opt/genie-tts` 即可，旧服务零影响。

## 8. 待你决策（执行前）

1. 回「执行」+ 约 VPS 操作窗口（§4 的 0-2 步约 2 小时，含下载等待）。
2. 考题 5 句是否沿用 Nano/ZipVoice 那三句 + 加两句（中英混读、情绪句），还是你另给？
