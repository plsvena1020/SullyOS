# API Base URL 端点后缀容错 · 执行计划（2026-09-12）

> 设计：`docs/superpowers/specs/2026-09-12-api-base-url-endpoint-suffix-design.md`。
> 本计划按「弱执行者」标准编写：每步有文件路径、定位、代码意图、验收命令与预期。
> 铁律：不碰另一条线（宽矮窗口）的未提交文件 `utils/layoutMode.ts`、`utils/layoutMode.test.ts`；不改请求拼接逻辑。

## 0. 前提

- 分支 `ethernet`；包管理器 `corepack pnpm@9.15.9`。
- 门禁命令：
  - 全量：`corepack pnpm@9.15.9 vitest run`（storageOptimize / networkFailureDiagnosis 已知全量并发抖动，单跑能过即算过）
  - 类型：`corepack pnpm@9.15.9 exec tsc --noEmit`（判据：触碰文件零命中，存量 45 条不算）
  - 乱码：`corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`

## 1. 中心化剥除

### Step 1.1 `utils/apiConfigNormalize.ts`

现状（第 10-11 行）：

```ts
export const normalizeApiBaseUrl = (value: unknown): string =>
  cleanEdgeCharacters(value).replace(/\/+$/, '');
```

改为：

```ts
/** Base URL 结尾误带端点路径的常见写法；只剥这一个，不做通用猜测。 */
const CHAT_COMPLETIONS_SUFFIX = /\/chat\/completions$/i;

/** 输入（清洗后）是否以误填的 /chat/completions 结尾。保存提示用。 */
export const hasChatCompletionsSuffix = (value: unknown): boolean =>
  CHAT_COMPLETIONS_SUFFIX.test(cleanEdgeCharacters(value).replace(/\/+$/, ''));

export const normalizeApiBaseUrl = (value: unknown): string => {
  const cleaned = cleanEdgeCharacters(value).replace(/\/+$/, '');
  // 用户常把端点路径也填进 Base URL；剥掉后可能残留尾斜杠，再清一次。
  return cleaned.replace(CHAT_COMPLETIONS_SUFFIX, '').replace(/\/+$/, '');
};
```

验收：`corepack pnpm@9.15.9 vitest run utils/apiConfigNormalize.test.ts`（Step 3.1 加完用例后全绿）。

## 2. 请求侧兜底

### Step 2.1 `utils/modelList.ts`

- 顶部加 `import { normalizeApiBaseUrl } from './apiConfigNormalize';`
- `fetchChatModelList` 第 59 行 `const base = baseUrl.trim().replace(/\/+$/, '');` 改为
  `const base = normalizeApiBaseUrl(baseUrl);`
- 其余不动（空 base 仍抛「请先填写 URL」）。

验收：Step 3.2 的用例全绿。

## 3. 保存提示 + 测试

### Step 3.1 `apps/Settings.tsx`

- 第 47 行的 import 追加 `hasChatCompletionsSuffix`。
- 四个保存动作在写入前加同一段（各加一次；文案一致）：
  ```ts
  if (hasChatCompletionsSuffix(localUrl)) {
      addToast('已自动去掉 Base URL 末尾的 /chat/completions（填到 /v1 即可）', 'info');
  }
  ```
  落点：
  - `handleSaveApi`（约 1129 行）——用 `localUrl`；
  - `handleSaveVisionApi`（约 1181 行）——用 `localVisionUrl`；
  - `handleSavePreset`（约 1108 行）——用 `localUrl`；
  - `handleUpdatePreset`（约 1052 行）——用 `editPresetUrl`。
- 注意：判断放在归一化**之前**用原始输入；输入框回填本来就用归一化后的值。

### Step 3.2 测试用例

`utils/apiConfigNormalize.test.ts` 追加：

1. `normalizeApiBaseUrl('https://api.example.com/v1/chat/completions')` → `https://api.example.com/v1`；
2. 带尾斜杠 + 零宽字符 + 大小写：`' https://api.example.com/v1/chat/Completions/\u200B '` → `https://api.example.com/v1`；
3. 中间的路径不动：`https://api.example.com/chat/completions/v1` 原样（仅去尾斜杠）；
4. 合法 Base URL 幂等：`https://api.example.com/v1` 不变；
5. `hasChatCompletionsSuffix`：命中（含尾斜杠/大小写）、不命中（`/v1`、中间出现）。

`utils/modelList.test.ts` 追加一条：直连分支 `fetchChatModelList('https://api.example.com/v1/chat/completions', 'sk-x')` → 请求 URL 为 `https://api.example.com/v1/models`。

验收：
- `corepack pnpm@9.15.9 vitest run utils/apiConfigNormalize.test.ts utils/modelList.test.ts utils/apiPresetSwitch.wiring.test.ts` 全绿。

## 4. 门禁

- `corepack pnpm@9.15.9 vitest run`（全量；已知并发抖动的两个文件单跑复核）。
- `corepack pnpm@9.15.9 exec tsc --noEmit`（触碰文件零命中）。
- `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`。
- 本次纯前端，不需要 `build:workers`；不碰 worker/amsg。

## 5. 收尾

- `notes/ethernet-branch-context.md` 记一条（简短）。
- 提交（等用户确认提交范围）→ push → Vercel 自动构建；手机/电脑载入新版本后，**已存的坏 Base URL 会在启动时自动被修正并回写**，无需重新保存。
- 手验：设置里填 `https://opencode.ai/zen/go/v1/chat/completions` 保存 → 提示 + 输入框变 `.../v1` → 刷新模型列表成功。
