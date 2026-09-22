# API Base URL 端点后缀容错 · 设计文档（2026-09-12）

> 状态：用户已批准（保存/请求前自动剥掉结尾多余的 `/chat/completions` + 一句提示）。
> 执行计划：`docs/superpowers/plans/2026-09-12-api-base-url-endpoint-suffix-plan.md`。

## 1. 背景

用户在 API 配置里把 Base URL 填成了 `https://opencode.ai/zen/go/v1/chat/completions`（把端点也写进去了）。程序约定 Base URL 填到 `/v1` 为止，再自行拼 `/chat/completions`、`/models`，于是：

- 刷新模型列表 → 请求 `.../v1/chat/completions/models` → 上游 404（经主代理中转原样透传，用户看到"莫名其妙的 404"）；
- 聊天 → 会拼成 `.../chat/completions/chat/completions` → 同样 404。

这个坑用户已连续踩两次（第一次在手机端表现为直连 CORS 失败，掩盖了 URL 本身也错）。

## 2. 目标与非目标

**目标**

1. `normalizeApiBaseUrl` 在清洗（去首尾不可见字符、去尾斜杠）之后，再剥掉结尾误填的 `/chat/completions`（大小写不敏感）。
2. 保存类动作检测到剥除时给一句 toast 提示，让用户知道被自动纠正了。
3. 已有坏配置在下次启动载入时自动修复（`OSContext` 载入路径本来就 `normalizeApiConfig` 并回写 localStorage，入口唯一）。

**非目标**

- 不改任何请求拼接逻辑（各调用点依旧 `base + '/chat/completions'`）。
- 不做通用端点猜测（不剥 `/completions`、`/responses`、`/embeddings` 等，避免误伤合法路径；以后有实测案例再逐个加）。
- 不动协作/桥等独立 URL 输入路径（它们不填 LLM Base URL）。

## 3. 设计

### 3.1 中心化剥除（唯一入口）

`utils/apiConfigNormalize.ts` 是 Base URL 清洗的唯一入口，被这些地方共用：

- `apps/Settings.tsx`：主 API 保存、识图 API 保存、预设新建/编辑；
- `utils/apiPresetSwitch.ts`：切预设时的配置物化；
- `utils/visionApi.ts`：识图预设载入；
- `utils/checkPhoneApi.ts`：查手机独立 API 配置读写；
- `context/OSContext.tsx:1381/:3003`：启动载入与每次 `updateApiConfig`（载入分支会回写 localStorage，坏值自动痊愈）。

因此只改这一个函数即可全局生效，无需逐调用点改。

行为：

```
cleanEdgeCharacters(value)      // 原有：去首尾空白/零宽字符
  .replace(/\/+$/, '')          // 原有：去尾斜杠
  .replace(/\/chat\/completions$/i, '')  // 新增：剥误填端点（只剥一次、不分大小写）
  .replace(/\/+$/, '')          // 新增后可能留下尾斜杠，再清一次
```

另导出 `hasChatCompletionsSuffix(value)`（同样先做不可见字符与尾斜杠清洗再测试），供保存动作判断是否要弹提示。

### 3.2 保存提示

`apps/Settings.tsx` 四个保存动作（`handleSaveApi`、`handleSaveVisionApi`、`handleSavePreset`、`handleUpdatePreset`）在写入前调用 `hasChatCompletionsSuffix(原始输入)`，命中则 `addToast('已自动去掉 Base URL 末尾的 /chat/completions（填到 /v1 即可）', 'info')`。输入框回填已经用归一化后的值，用户直接看到纠正结果。

### 3.3 请求侧兜底

`utils/modelList.ts` 的 `fetchChatModelList` 在拼 `/models` 前改为 `normalizeApiBaseUrl(baseUrl)`（替换现有 `trim + 去尾斜杠`）。这是第二道保险：即使某条路径绕过了保存归一化（手改 localStorage、旧版本导入的备份），模型列表也不会拼出错误 URL。

## 4. 边界

- 只剥**结尾**的 `/chat/completions`；出现在中间的（如 `/chat/completions/v1`）不动。
- 剥完为空串/畸形（如 `https:///chat/completions`）按现有校验当非法空值处理，不新增特判。
- 幂等：对合法 Base URL 调用结果不变；重复调用不变。
- 不改计费与请求重试行为。

## 5. 验收

- 单测：`utils/apiConfigNormalize.test.ts` 新增剥除/大小写/尾斜杠/中间不剥/`hasChatCompletionsSuffix` 用例；`utils/modelList.test.ts` 新增「Base URL 误带 `/chat/completions` 时请求打到 `/v1/models`」。
- 门禁：全量 vitest、`tsc --noEmit`（触碰文件零命中）、mojibake（动过含中文文件）。
- 手验（可选）：设置里填 `https://opencode.ai/zen/go/v1/chat/completions` 保存 → 出现提示、输入框变 `.../v1`，刷新模型列表成功。
