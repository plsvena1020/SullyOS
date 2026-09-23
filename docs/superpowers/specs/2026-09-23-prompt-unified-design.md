# 预设统合（Unified Prompt）· 设计

> 日期 2026-09-23。目标：提示词的编辑层与观测层在预设 App 内闭环——
> 能改的都在里面，改完能在里面验证。唯一真源是真实发送的请求，
> 不做离线模拟、不估 token。
>
> 前置：预设套组系统（`docs/superpowers/specs/2026-09-22-preset-kit-system-design.md`，
> 已落地 `cae0e1f3`）。调用点清单见本文件 §7（2026-09-23 全仓实扫 70 处）。

## 1. 三页结构（定稿）

预设 App 改为三页：**提示词 / 世界书 / 调用地图**。

- 页 1 提示词 = 编辑层（套组、条目、内置段、生效状态、真实发送查看）。
- 页 2 世界书 = 编辑层（现有 `WorldbookApp` 原样嵌入，只加 `embedded` prop
  隐藏自带顶栏；交互与导入导出零改动）。
- 页 3 调用地图 = 观测层（全部调用点的分类、顺序、门、真实记录）。
- sourceKey 与抓取记录互相跳转：条目卡显示“被哪些调用消费”，
  调用卡显示消费的 sourceKey（点击跳条目卡）。

## 2. 内置模板的归属（定稿，纠正上一版错误）

- 内置 20 行**不进任何套组的 entryIds**（迁移维持现状：只收自定义段落，
  无需改迁移代码）。行是全局的（`prompt_presets` 表），启停/恢复默认
  在任何套组下作用相同。
- 条目页顶部常驻可折叠的「内置模板（20）」段：默认预设下展开，
  其他套组下折叠。允许拖动，但只改行 `order` 显示序，**对注入零影响**
  （钢印永远最后、语音永远在语音块——位置是代码定的，卡上如实标注）。
- 解析层对 sourceKey 行维持现状：套组三组（stable/afterHistory/absolute）
  只收自定义行（`resolveActivePackEntries` 显式跳过 `sourceKey` 行，
  需加一行过滤 + 单测；现在它不跳，是本期要补的防线）。

## 3. 可接管条目（定稿）

可接管（独立文本块，挪位置语义成立）：`chat.steelExpression`、
`chat.steelYourself`、`chat.perspectiveTool`。

- 每行加落位字段 `adoptPosition`（`native` 缺省），改为
  stable/afterHistory/absolute 即“被接管”：走套组管道（与自定义同一管线），
  原生注入点自动跳过，绝不双份；拨回 `native` 即还原。
- 管道内排序：同落位组里自定义按 entryIds 序在前，接管条目按目录序在后。
- 不可接管两类，卡上如实标注原因：
  - 技术模板 8 条（memory.×7、amsg.emotionEval、rel.genGuide）：
    独立 LLM 调用的整段模板，聊天请求里没有它们的位置。只能改内容。
  - 语音四条 + 约会/写歌两条：功能块内部器官（语音四选一由全局供应商定），
    套组管道不懂选择逻辑。标「原生注入（功能块内）」。

## 4. 每角色生效清单（只读，定稿）

- 顶栏下一条**套组条**（当前套组名 + 管理弹层：新建/重命名/删除/切换/
  采样参数/导入导出）与**角色 chip**（默认当前角色，可清空；
  清空 = 回纯管理视图，不显示生效状态）。
- 选中角色时，每张条目卡内联一行生效状态，原因枚举：
  `生效` / `生效·兜底内置`（面板停用但调用方回退默认，如语音组）/
  `生效·已接管（落位）` / `不注入·已停用` / `不注入·场景不含` /
  `不注入·该角色未开XX` / `不注入·该场景暂未接入` /
  `无消费点`。
- 互斥组按组渲染：语音组标“全局供应商 minimax → 生效 X”；
  情绪评估组标“该角色 scheduleStyle=mindful → 生效 Y”。
- 判据实现 `utils/presetEffective.ts` 纯函数，直接调用真实注入同源：
  同 resolve 函数、同 char 字段、同 `getTtsProvider()`。零平行逻辑。

## 5. 真实抓取（唯一“完整 prompt”来源，定稿）

- 新模块 `utils/promptCallCapture.ts`：`captureCall(siteId, messages, meta)`，
  按 siteId 分桶的内存环形缓冲（每桶最近 3 次，含角色/场景/时间戳）。
  只存内存，不落盘，刷新即清。零 LLM 调用。
- v1 接入抓取的 site（主链路各插 1-3 行）：
  `chat-main`（useChatAI payload 处）、`emotion-eval`、`memory-digest`、
  `memory-extract`、`rel-gen`、`song-mentor`、`date-session`。
- 渲染规则（SillyTavern 式，与抓取同模块的共享渲染器）：
  聊天历史折成一条占位条目（条数 + 时间范围，不展开原文）；
  历史内 depth 注入条目（预设 absolute + 世界书 at-depth）在占位条之后
  全文列出并标 depth；stable/易变尾/钢印/reminder 全文；
  vision 的 base64 折叠成 `[图片 ×N]`，复制按钮给原样全文；
  顶部只标字符数，**不做 token 估算**。
- 没发过就明说“本会话尚无真实发送记录”，绝不拿模拟顶数。
- `promptPreviewComposer`（离线镜像，有截断与手写概述块）**删除**
  （模块 + 测试；PresetApp 内引用一并替换）。

## 6. 调用地图（定稿）

- 新模块 `utils/promptCallRegistry.ts`：手工策展的调用点登记表。
  字段：`site`（与抓取同 id）、分类、名称、一句话作用、触发时机
  （每轮回复后 / 发送前 / 手动按钮 / 定时 fire / 工具轮内）、
  消费的 sourceKey[]（可跳转）、门（`{ kind: 'char'|'global'|'manual', ref, label }`）、
  可见性（`local` / `local-uncaptured` / `cloud`）。
- 门状态按当前角色实时计算：绿=会触发 / 灰=门关（原因）/ 橙=手动按需。
  判定复用真实函数，不重写。
- 主聊天一轮时序卡（竖排序号）：①主请求 → ②情绪评估 → ③记忆消化 →
  ④AIRP 导演（按角色）→ ⑤二轮工具钩子（按需）→ ⑥云端定时 fire（后台）。
- 云端站点的卡只显示：上传模板全文（前端组装部分，可抓）+
  “到点由 worker 补的段”清单（列名，无原文）+「云端执行·本地不可见」。
- 未接入抓取的小众点标「未接入抓取」，不给假数据。
- wiring 测试锁定每个登记项的实现锚点存在（仿
  `utils/amsg2ChatLoop.wiring.test.ts` 的源码 grep 范式），漂移即红。

## 7. 全仓调用点清单（2026-09-23 实扫，供注册表取材）

分类即注册表分类。`[C]`=云端现场组装（本地不可见），其余前端本地可见。

**主聊天链路**：chat-main（useChatAI 主请求+重试+工具轮续跑）、
主动消息本地生成（OSContext sendProactiveMessage）、[C] amsg onBeforeFire
主干、`[C]` 即时对话（instantChat + activeMsgClient 信封）、`[C]` 主代理
llmStream、`[C]` instant-push 主循环、通话轮回复（CallApp requestAssistantReply）、
群聊三触发（GroupChat）、见面主回复（DateApp callLLM）、协作回合（collaboration engine）。

**记忆系统**：memory-extract（extraction 提取）、memory-digest（digestion 反刍）、
personalityDetect（认知风格判定）、recallRouter（发送前轻量路由）、
事件盒压缩（eventBoxCompression）、`[C]` 门牌整理（plateFire）、
归档（Chat 旧归档 + 角色页强制归档/批量摘要，同归档模板体系）。

**情绪与日程**：emotion-eval（useChatAI evaluateEmotionBackground +
emotionEvalCore 发包点；`[C]` amsg/instant-push 同模板并行）、日程问答（ScheduleApp）。

**关系**：rel-gen（relationshipGen）、印象生成（Character handleGenerateImpression，
硬编码模板）。

**创作与功能**（全部手动/按需，硬编码模板，v1 登记为 local-uncaptured，
除 song-mentor 接抓取）：song-mentor（song.craftRules）、作曲 tag 建议（aceStepApi）、
角色音乐人格（charMusicPersona）、自由漫游决策（xhsFreeRoam）、AIRP 导演
（directorClient）、梦境剧本、学习九件套（StudyApp）、银行留言板/经营分析/
商店场景、社交动态与评论、日记/房间/查手机/浏览器总结/攻略/游戏主持/
人生模拟/世界生成/VR 事件/画廊 tag/记忆轻量 LLM/设置探针/节日台词/
语音翻译（llmTranslate）、单月精炼。

**后台与主动消息**：`[C]` 自主回合（autonomyFire）、`[C]` 调度占位符（非调用）、
fire_pack 组装（activeMsgClient 本地组装、云端发包）。

**工具与识图**（二轮续跑，主回复后的补步）：写日记圆场、RECALL/SEARCH/
翻日记×4/读笔记×2/小红书搜索浏览/透视窗二轮与圆场/小红书主页详情、
识图（visionApi describeImage）、外貌提取（imageGenFlow）。

## 8. chat.appRules 提升（定稿：本期做，可编辑）

ChatApp 行为规范大块（chatPrompts.ts 内模板字符串）提升为目录条目
`chat.appRules`：整块原文入目录，条件插值改为 `__槽位__`
（已知槽位：日程教学、Notion/飞书/用户笔记、要图提醒，另有插值照此办理），
渲染时回填。之后可编辑/启停（停用 = 整块不注入）/恢复默认。
判据：提升前后同一输入的 stable 输出逐字一致（单测锁死）。

## 9. 附带修复（定稿）

- emotionEval Mindful/Living 死行接活：useChatAI 硬编码改为按
  `char.scheduleStyle` 读对应 sourceKey 行（三选一真实生效）。
  其中 else 分支 = Living 内置（即旧行为），绝不用主模板全文回填
 （回填会把整段模板嵌进 `__SCHEDULE_RULE__` 槽位；2026-09-23 裁决，勿改回）。
- date/song 只消费 stable + afterHistory 组（无 depth 机制，absolute 行
  在该场景静默不注入；2026-09-23 接受为既定语义）。
- tags 接线最小集：约会（datePrompts）+ 写歌（songPrompts）传入 kit 条目，
  经共享渲染 helper（resolve + 宏 + placement=5 正则，主链路同源）。
  phone/story/memory 的 tag 保留可选，生效状态如实标“该场景暂未接入”
  （接线另立项；tag 是意图声明，接上即自动生效）。
- 世界书 App 退役：删 constants 启动器条目、PhoneShell 懒加载与注册、
  appPreload 预载、safeAreaApps（+测试）、acnhIcons 图标、`AppID.Worldbook`
  枚举（旧桌面排序残留由 launcherLayout.normalize 静默丢弃，已核实）；
  Character.tsx 世界书空态文案改指预设 App。数据层零迁移。

## 10. 不做

- 按角色启停覆盖（推翻全局作用域，另立项）。
- phone/story/memory 场景的套组接线。
- 云端 prompt 的本地抓取（只展示上传模板 + 补段清单）。
- token 估算（全仓不做）。
- 内置行进套组 entryIds（显示层分组即可，不碰数据关系）。
