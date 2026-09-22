# 执行计划：聊天相册生图（2026-09-12）

> 设计见 `docs/superpowers/specs/2026-09-12-chat-image-studio-design.md`。按序执行，每步带文件、定位、意图、验收。
> 禁止：改 worker / latent 参数默认值、给 `FIRE_PACK_VERSION` 动刀、保留聊天外的第二套注入来源、把临时文件留在仓库。
> 定位行号是改动前编号，按符号名找位置，不要死认行号。

## 步骤清单

- [ ] 1. `suggestImageTags` 返回 `{tags, resolution}`（JSON + 两级容错）
- [ ] 2. `imageGenTags`：`mentionsCharacterRef` + `GenImageRequest` 去掉 styleTags/gender
- [ ] 3. `types.ts` + 神经链接角色页：画风 / 性别
- [ ] 4. 生图内核注入规则（画风通用、性别仅 @角色）
- [ ] 5. 聊天「相册」按钮二选一 + 生成弹窗
- [ ] 6. 独立相册 App 移除生成入口
- [ ] 7. Step 5b 静默失败诊断
- [ ] 8. 测试更新 + 全量验证 + 文档

---

## 步骤 1：suggestImageTags 新返回

**文件**：`utils/imageGenFlow.ts`

1. `TAG_SUGGEST_SYS` 改为（要点：JSON、按描述决定是否出现角色与画幅、禁止外貌/性别/画风 tag）：

```
你是分镜师。把用户的画面描述转成英文 danbooru 风格生图 tag，并判断画幅。
规则：
- 画面里需要出现角色时，用 @名字 指代（如 @小苏）——系统会替换成固定外貌并注入性别；纯景色不要出现任何人物、不要用 @。
- 不要写发色 / 瞳色 / 服装 / 性别标记（1girl / 1boy 等），也不要写画风 / 画师 tag（这些由系统固定注入）。
- 画幅按构图选：人物特写/竖构图 portrait，横向场景 landscape，方构图 square。
只输出下面这个 JSON，不要 Markdown 代码块、不要解释：
{"tags": "英文 tag，逗号分隔，8-20 个", "resolution": "portrait | landscape | square"}
```

2. 新增解析与返回类型：

```ts
export interface ImageTagSuggestion {
    tags: string;
    resolution: ImageGenResolution;
}

const parseTagSuggestion = (raw: string): ImageTagSuggestion => {
    const text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    // 1) 优先 JSON（取首个 { … }，容忍前后废话）
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(text.slice(start, end + 1));
            const tags = cleanTagLine(String(obj?.tags || obj?.prompt || ''));
            if (tags) {
                return { tags, resolution: normalizeImageGenResolution(obj?.resolution) ?? DEFAULT_IMAGE_GEN_RESOLUTION };
            }
        } catch { /* 落到下一级 */ }
    }
    // 2) 一行 tag，可能带 `| portrait` 后缀（复用聊天标签同款写法）
    const line = cleanTagLine(text).split('\n')[0];
    const m = line.match(/^(.*?)\s*\|\s*([A-Za-z\u4e00-\u9fa5]+)\s*$/);
    if (m) {
        const res = normalizeImageGenResolution(m[2]);
        const tags = cleanTagLine(m[1]);
        if (tags) return { tags, resolution: res ?? DEFAULT_IMAGE_GEN_RESOLUTION };
    }
    return { tags: line, resolution: DEFAULT_IMAGE_GEN_RESOLUTION };
};
```

3. `suggestImageTags` 签名改为：

```ts
export async function suggestImageTags(
    scene: string,
    char: CharacterProfile,
    apiConfig: APIConfig,
    fetchImpl?: LatentFetch,
): Promise<ImageTagSuggestion>
```

- 删掉 `options?: { sceneryOnly?: boolean }`（改由模型判断），user content 固定为
  `【角色】${char.name}\n\n【画面描述】\n${scene.slice(0, 2000)}`。
- 返回 `parseTagSuggestion(content)`；`tags` 为空 → 抛 `'LLM 没写出 tag，换个说法重试'`。

4. `utils/imageGenTags.ts` 导出 `normalizeImageGenResolution`（把现有私有 `normalizeResolution` 复用改名导出，`extractGenImageTags` 内部调用同步改）。

**验收**：`pnpm vitest run utils/imageGenSuggest.test.ts`（步骤 8 更新后）全绿；`tsc` 对两个文件零报错。

## 步骤 2：imageGenTags 调整

**文件**：`utils/imageGenTags.ts`

1. `GenImageRequest` 删除 `styleTags` / `gender` 两个字段（注释一并删）——注入来源改为角色档案。
2. 新增导出：

```ts
/** prompt 里是否 @了这个名字（大小写不敏感；在 resolveAppearanceRefs 之前判定用）。 */
export function mentionsCharacterRef(prompt: string, name: string): boolean {
    const key = (name || '').trim();
    if (!prompt || !key || !prompt.includes('@')) return false;
    return new RegExp(`@${escapeRegExp(key)}(?![\\w])`, 'i').test(prompt);
}
```

3. `composeImagePrompt` 保留原样（内部仍用显式参数）。

**验收**：`pnpm vitest run utils/imageGenTags.test.ts` 全绿（用例在步骤 8 增补）。

## 步骤 3：角色档案字段 + 神经链接 UI

**文件**：`types.ts`、`apps/Character.tsx`

1. `types.ts` 在 `imageGenProfile?: string;`（约 :3380）后面加：

```ts
  /**
   * AI 生图固定注入的画风 / 画师 tag（per-character，通用注入）。
   * 该角色所有生图都会带上：聊天自动配图、主动消息、Spark 首图、聊天相册手动生成；
   * 纯景色生成也注入。逗号分隔，英文 danbooru 风格（如 "by wlop, watercolor"）。
   */
  imageGenStyleTags?: string;
  /**
   * AI 生图性别矫正（per-character）：仅当画面里出现该角色（prompt 里有 @角色名）时，
   * 注入 1boy/1girl 并剔除模型写错的性别标记。纯景色不注入。
   */
  imageGenGender?: 'male' | 'female';
```

2. `apps/Character.tsx` 生图卡片（`AI 生图 · 外貌提示词` 那张卡，约 :2072）textarea 之后新增：
   - 性别三态：`不注入 / 女 / 男`，`onClick={() => handleChange('imageGenGender', v)}`，选中态 `bg-fuchsia-500 text-white`；值 `formData.imageGenGender`。
   - 画风 input：`value={formData.imageGenStyleTags || ''}`，`onChange={(e) => handleChange('imageGenStyleTags', e.target.value)}`，placeholder `by wlop, watercolor, soft lighting（固定注入，纯景色也带）`。
   - 卡片说明补一句：画风对所有生图通用；性别只在画面里出现该角色时注入。

**验收**：`tsc` 对 `apps/Character.tsx` 零报错；dev 里改完刷新仍在（formData 自动保存链路）。

## 步骤 4：生图内核注入规则

**文件**：`utils/imageGenFlow.ts`

`generateImageBlobOnly` 里把注入改为：

```ts
    const profiles = await collectAppearanceProfiles(req.prompt, deps);
    // 画风/质量词通用注入；性别只在画面里真的出现该角色时注入（@引用判定，替换前）。
    const gender = deps.char.imageGenGender
        && mentionsCharacterRef(req.prompt, deps.char.name)
        ? deps.char.imageGenGender
        : undefined;
    const resolved = resolveAppearanceRefs(req.prompt, profiles);
    const prompt = composeImagePrompt(resolved, {
        qualityTags: DEFAULT_QUALITY_PROMPT,
        styleTags: ((deps.char as any).imageGenStyleTags || '') as string,
        gender,
    });
```

- import 增加 `mentionsCharacterRef`。
- 删除对 `req.styleTags` / `req.gender` 的引用。

**验收**：步骤 8 的单测覆盖三条规则（画风通用 / 性别仅 @ / 纯景色无性别）。

## 步骤 5：聊天入口与弹窗

**文件**：`components/chat/ChatInputArea.tsx`、`apps/Chat.tsx`、`components/chat/ChatModals.tsx`

1. `ChatInputArea.tsx`
   - 相册按钮（约 :826）改 `onClick={() => onPanelAction('image-source')}`，图标/文案不变。
   - 删除 `chatImageInputRef`（:83）、`handleImageChange`（:126-132）、hidden input（:833）。`Image` 图标 import 保留。

2. `apps/Chat.tsx`
   - import 加回：`import { suggestImageTags, generateImageBlobOnly } from '../utils/imageGenFlow';`
   - `modalType` union 增加 `'image-source'`。
   - 新状态：

```ts
    const [imageSourceStep, setImageSourceStep] = useState<'menu' | 'generate'>('menu');
    const [imageGenDesc, setImageGenDesc] = useState('');
    const [imageGenBusy, setImageGenBusy] = useState<'' | 'analyzing' | 'generating'>('');
    const chatUploadInputRef = useRef<HTMLInputElement>(null);
```

   - `handlePanelAction` 增加：

```ts
            case 'image-source': setShowPanel('none'); setImageSourceStep('menu'); setImageGenDesc(''); setImageGenBusy(''); setModalType('image-source'); break;
```

   - 新 handler（放 `handlePanelAction` 附近）：

```ts
    const handleConfirmImageGenerate = async () => {
        const desc = imageGenDesc.trim();
        if (!desc || imageGenBusy || !char) return;
        if (apiConfig.imageGenEnabled !== true || !(apiConfig.latentImageKey || '').trim()) {
            addToast('先去「设置 → AI 生图」打开自动生图并填 Latent Key', 'error');
            return;
        }
        setImageGenBusy('analyzing');
        try {
            const { tags, resolution } = await suggestImageTags(desc, char, apiConfig);
            setImageGenBusy('generating');
            const result = await generateImageBlobOnly({ prompt: tags, resolution }, {
                apiConfig,
                char,
                characters,
                saveCharProfile: (id, profile) => updateCharacter(id, { imageGenProfile: profile } as any),
            });
            setModalType('none');
            setImageGenDesc('');
            setImageSourceStep('menu');
            // 与上传同一条路：以「我发的图」上屏 + 存相册 + 触发角色回应
            await handleSendText(result.token, 'image');
        } catch (e: any) {
            if (e?.name === 'AbortError') return;
            addToast(`生成失败：${e?.message || '未知错误'}`, 'error');
        } finally {
            setImageGenBusy('');
        }
    };

    const handleChatImageUploadPick = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setModalType('none');
        void handleImageSelect(file);
    };
```

   - 渲染隐藏 input（放在 ChatModals 附近之外的 JSX 任意处）：`<input ref={chatUploadInputRef} type="file" accept="image/*" hidden onChange={handleChatImageUploadPick} />`
   - 传给 ChatModals 的新 props：

```tsx
                imageSourceStep={imageSourceStep}
                setImageSourceStep={setImageSourceStep}
                imageGenerateDesc={imageGenDesc}
                setImageGenerateDesc={setImageGenDesc}
                imageGenerateBusy={imageGenBusy}
                onPickImageUpload={() => chatUploadInputRef.current?.click()}
                onConfirmImageGenerate={handleConfirmImageGenerate}
```

3. `components/chat/ChatModals.tsx`
   - props interface + destructure 增加上面 7 个字段（`modalType`/`setModalType` 已有）。
   - 新增弹窗（放在 message-options 弹窗之后）：

```tsx
            {/* 聊天相册：上传图片 or 生成图片（生成只填描述；画风/性别在神经链接角色页配） */}
            <Modal
                isOpen={modalType === 'image-source'}
                title={imageSourceStep === 'generate' ? '生成图片' : '相册'}
                onClose={() => { if (!imageGenerateBusy) setModalType('none'); }}
                footer={imageSourceStep === 'generate' && !imageGenerateBusy ? (
                    <>
                        <button onClick={() => setImageSourceStep?.('menu')} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">返回</button>
                        <button onClick={() => void onConfirmImageGenerate?.()} disabled={!imageGenerateDesc?.trim()} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl disabled:opacity-40 active:scale-95 transition-transform">生成</button>
                    </>
                ) : undefined}
            >
                {imageSourceStep === 'generate' ? (
                    imageGenerateBusy ? (
                        <div className="py-10 text-center text-sm text-slate-400">
                            {imageGenerateBusy === 'analyzing' ? '正在把描述转成生图 tag…' : '正在生成，可能需要半分钟到几分钟…'}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <textarea
                                value={imageGenerateDesc || ''}
                                onChange={(e) => setImageGenerateDesc?.(e.target.value)}
                                placeholder="用一句话描述画面，比如：傍晚的湖边，她穿着白色长裙回头笑"
                                className="w-full h-28 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-fuchsia-300 transition-all text-sm leading-relaxed"
                            />
                            <p className="text-[11px] text-slate-400 leading-relaxed">画面里出现角色时会自动套用她的外貌与性别（性别在「神经链接 → 角色 → 设定」里配）；画幅由模型按描述自选。生成后会作为你发的图进入聊天并存进相册。</p>
                        </div>
                    )
                ) : (
                    <div className="space-y-3">
                        <button onClick={() => onPickImageUpload?.()} className="w-full py-4 bg-slate-50 rounded-2xl flex items-center justify-center gap-2 text-slate-700 font-bold active:scale-[0.98] transition-transform">
                            <UploadSimple size={20} className="text-slate-500" /> 上传图片
                        </button>
                        <button onClick={() => setImageSourceStep?.('generate')} className="w-full py-4 bg-fuchsia-50 rounded-2xl flex items-center justify-center gap-2 text-fuchsia-600 font-bold active:scale-[0.98] transition-transform">
                            <Sparkle size={20} weight="fill" /> 生成图片
                        </button>
                    </div>
                )}
            </Modal>
```

   - import 增加 `UploadSimple, Sparkle`（`@phosphor-icons/react`）。

**验收**：dev 里点聊天「相册」出现二选一；上传走原流程；生成成功后图以用户消息上屏、相册可见。

## 步骤 6：独立相册 App 移除生成入口

**文件**：`apps/Gallery.tsx`

删除以下内容（全部是上一轮加入的）：

- import：`Modal`、`Plus`、`UploadSimple`、`Sparkle`、`processImageToBlob`、`putImageBlob`、`getLocalDateKey`、`suggestImageTags`、`generateImageBlobOnly`、`ImageGenResolution`；`useOS()` 里的 `updateCharacter` 还原为不取。
- 状态：`composeMode / genDesc / genResolution / genBusy / genMode / genGender / styleTags / saveStyleTags / uploadInputRef`。
- 函数：`refreshImages / handleAlbumUpload / handleAlbumGenerate`。
- JSX：header 里的「＋」按钮；底部 `<input ref={uploadInputRef} …>` 与整个 `<Modal isOpen={composeMode !== 'none'} …>` 块。
- `useCallback` / `useRef` 的 import 保留（其他地方仍用）。

**验收**：`tsc` 对 `apps/Gallery.tsx` 零报错；grep `generateImageBlobOnly|sully_image_style_prompt` 不再命中 Gallery。

## 步骤 7：静默失败诊断

**文件**：`utils/applyAssistantPostProcessing.ts`

1. Step 5b（约 :2346）改为：

```ts
    const genImageReqs = extractGenImageTags(aiContent);
    if (genImageReqs.length > 0) {
        aiContent = stripGenImageTags(aiContent);
        if (genImageReqs.length > 1) {
            console.warn('[imageGen] 一轮多个 GEN_IMAGE 标签，只执行第一个', { charId: char.id, count: genImageReqs.length });
        }
        const imgReq = genImageReqs[0];
        const enabled = imageGen?.apiConfig?.imageGenEnabled === true;
        const hasKey = !!(imageGen?.apiConfig?.latentImageKey || '').trim();
        if (imageGen && enabled && imgReq) {
            appendDevDebugLog('api', { label: '[imageGen] 已触发后台生图', data: { charId: char.id, prompt: imgReq.prompt, resolution: imgReq.resolution } });
            void runImageGenReply(imgReq, { ...原参数不变... });
        } else if (imgReq) {
            // 静默失败改可查：开关没开 / 缺 Key / 没传运行时（群聊）都留痕，
            // 本地路径每会话节流提示一次，避免「角色想发图却什么都没有」查无头绪。
            const reason = !imageGen ? 'no-runtime' : (!enabled ? 'disabled' : 'no-key');
            console.warn('[imageGen] 角色写了生图标签但没执行', { charId: char.id, reason, prompt: imgReq.prompt });
            appendDevDebugLog('api', { label: '[imageGen] 生图标签被拦下', data: { charId: char.id, reason, prompt: imgReq.prompt } });
            notifyImageGenBlocked(reason, addToast);
        }
    }
```

2. 模块级节流函数（放主入口前）：

```ts
let imageGenBlockedNoticeAt = 0;
/** 生图标签被拦时的用户提示：每 10 分钟最多一次，说明去哪开。 */
function notifyImageGenBlocked(reason: string, addToast: (msg: string, type: 'info' | 'success' | 'error') => void): void {
    const now = Date.now();
    if (now - imageGenBlockedNoticeAt < 10 * 60_000) return;
    imageGenBlockedNoticeAt = now;
    if (reason === 'no-key') addToast('角色想发图，但还没填 Latent API Key（设置 → AI 生图）', 'info');
    else if (reason === 'disabled') addToast('角色想发图，但「自动生图」开关没开（设置 → AI 生图）', 'info');
}
```

3. import `appendDevDebugLog` from './devDebug'（与 `isCaptureEnabled` 同处，检查该文件既有 import 风格）。若 `'api'` 不是合法 category，改用文件中已用的类别（`isCaptureEnabled('instant-push')` 出现在本文件，说明有该类别；按 `DevDebugCaptureCategory` union 选一个存在的）。

**验收**：`pnpm vitest run utils/applyAssistantPostProcessing.imageGen.test.ts` 全绿（原有用例不涉及拦截分支）；手动可控：关闭开关后让角色写标签，console 出现 `[imageGen] …但没执行`。

## 步骤 8：测试与文档

1. `utils/imageGenSuggest.test.ts` 重写为：
   - JSON 输出 → `{ tags, resolution }`；
   - 代码块包裹 JSON、前后有废话 → 仍能解析；
   - 一行 tag + `| 方` → square；纯 tag 行 → portrait；
   - 空回 / LLM 未配置 → throw；
   - 系统提示断言包含 `需要出现角色时` 与 `不要写发色`。
2. `utils/imageGenFlow.test.ts`：
   - 原「固定注入 + 性别矫正」用例改为读角色档案（`imageGenStyleTags/imageGenGender`），断言与现在相同的结果串；
   - 新增：角色有 `imageGenGender: 'male'` 但 prompt 无 `@角色名`（纯景色）→ 结果不含 `1boy`，但含画风 tag；
   - 保留：质量词去重、`@小写` 也替换。
3. `utils/imageGenTags.test.ts`：新增 `mentionsCharacterRef`（大小写/缺 @/未提及）用例；`composeImagePrompt` 用例保持。
4. `notes/ethernet-features.md` AI 生图小节更新：入口在聊天相册按钮（二选一）、独立相册入口移除、画风通用/性别按 @ 注入、画幅由模型、静默失败可查。
5. 全量：`corepack pnpm vitest run`、`corepack pnpm exec vite build`、改动文件无 BOM、无 `EF BF BD`。

---

## 边界与禁止

- 不改 worker（`gen_image` directive 契约不变）、不改 latent 默认参数（er_sde / linear_quadratic / 12 步）。
- 不在 `generateImageBlobOnly` 之外再拼画风/性别/质量词。
- `handleSendText(token, 'image')` 是唯一生成落聊天路径；不要再写第二套落库。
- Gallery App 保持纯浏览（含点评/收藏），不保留任何生成入口。
- 测试 fixture 用虚构名字（小画 / 小苏）。

## 2026-09-22 收尾附记

- 豁免：`latentImageGen` 新增 sampler/scheduler/steps 可配参数 + 422 按上限降级重提，
  默认值保持 12/er_sde/linear_quadratic 不变。禁令本意是锁默认出图行为，参数化
  不改变缺省调用，调用方不传参即旧行为。
- plan 外追认（两处，代码已齐、测试绿，随本线提交）：`SocialApp` 角色帖 AI 配图
  （`generatePostCover`，fire-and-forget + 每轮最多 2 张）；`Settings`「测试生图」
  按钮（固定测试词真跑一张，只预览不落库，烧一次额度）。
- `GroupChat` 挂 `ImageLightbox` 预览（plan 触碰清单漏登，随本线提交）。
