# 塔罗「深空景深 + WebGL 天空」— 设计 spec + 执行计划

日期：2026-09-12（第三波，接 `plans/2026-09-12-tarot-aurora-reading-plan.md` / `plans/2026-09-12-tarot-sky-constellation-plan.md`）
状态：用户已批准（同日对话终稿：WebGL 着色器方案 + 前景散景盖在内容上 + Tab 切换联动视差 + 只背景滑 + 60fps 封顶 + 性能华丽兼备、自适应降档）。本文件同时是 spec 与弱执行者清单。

## 触碰文件清单（其他窗口请避开）

| 操作 | 文件 |
|------|------|
| 新增 | `apps/tarot/TarotSkyShader.tsx` |
| 新增 | `apps/tarot/TarotBokeh.tsx` |
| 改 | `apps/tarot/TarotParticles.tsx` |
| 改 | `apps/TarotApp.tsx` |
| 新增 | `plans/2026-09-12-tarot-depth-parallax-plan.md`（本文件） |
| 收尾 | `notes/ethernet-features.md` |
| 不动 | `apps/tarot/TarotCards.tsx`、`apps/tarot/ReadingView.tsx`、`apps/tarot/RitualView.tsx`、`apps/tarot/LibraryView.tsx`、`apps/tarot/ZodiacRing.tsx`、`utils/tarot*`、数据结构/存储/注册点 |

---

# Part 1 · 设计 spec

## 1.1 分层（自下而上）与视差系数

| 层 | 实现 | Tab 视差系数 | 说明 |
|----|------|--------------|------|
| 底色渐变 | CSS（不动） | — | |
| 星云柔光（3 团） | CSS（alpha 提高） | 0.05（±7%/Tab，居中 1.5 为原点） | wrapper 上 transform + 1.6s 缓动 |
| 极光柔光+幕帘+大极光带 | CSS（增强） | 0.075（±13.5%/Tab） | 仅 WebGL 回落时可见；shader 激活时整体 opacity→0 |
| WebGL 天空 | `TarotSkyShader` | uniform `u_offset`（±0.13 屏宽） | 星云云团 + 3 条极光幕帘 + 银河雾 |
| 2D 星尘/星座/流星 | `TarotParticles` | 远 0.2 / 中 0.55 / 近 1.0 / 星座 0.75 | lerp 1.2s 追赶；基准 ±34px |
| 内容 | 不动 | — | 纯淡入 |
| 前景散景 | `TarotBokeh`（z-30） | 0.8-1.5/颗 | 盖在内容上，9/12 颗 |
| 晕影 | CSS | — | 0.42 → 0.30 |

视差基准公式：`target = -(tabIndex - 1.5) * 34`（px，Tab 0..3）；CSS 层用百分比同式。近层滑得多、远层滑得少 = 景深。

## 1.2 `TarotSkyShader.tsx`（新）

- WebGL1（`canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })`），全屏三角（3 顶点 buffer：(‑1,‑1)(3,‑1)(‑1,3)）。
- 片段着色器（GLSL ES 1.0，mediump）：
  - `hash/noise/fbm`（value noise，4 octaves 星云、3 octaves 极光，固定循环上限）
  - `base`：深空底色（#150f26→#0b0914 方向渐变，alpha 0.35，作为 CSS 底色之上的叠加）
  - `nebula`：`fbm(p*1.6 + t*0.012)` 紫罗兰 `vec3(.42,.32,.78)*0.20` + 第二层 `fbm(p*2.7 - t*0.008)` 青玉 `vec3(.25,.55,.48)*0.10`
  - `aurora`：3 条幕帘，每条 `bandY(t)` 做纵向高斯窗（窗宽随 t 呼吸），帘纹 `pow(fbm(vec2(u*3+t*0.06+seed, y*2.2-t*0.02)), 2.2)`，色带按 `u` 与 `sin(u*2.4+t*0.05)` 在紫→青玉→金之间混；三条不同 seed/速度方向（一快一慢一反向），横向流动明显
  - `milky`：斜向 `fbm` 雾带（方向 (-0.85,0.53)），白/淡紫，alpha 0.10
  - 输出 `gl_FragColor = vec4(col, clamp(alpha,0.,1.))`，`gl.enable(BLEND); gl.blendFunc(SRC_ALPHA, ONE)`（叠加发光）；画布透明处透出 CSS 层
  - uniforms：`u_time`(s)、`u_resolution`(vec2，backing 尺寸)、`u_offset`(float，归一化屏宽)；`uv = gl_FragCoord.xy/u_resolution`，`p = (gl_FragCoord.xy - 0.5*u_resolution)/u_resolution.y`（保纵横比），`p.x += u_offset * 1.6`
- 分辨率与 60fps：`quality` 初始 1.0，backing = css 尺寸 × `min(DPR,2) × quality`；rAF 跳帧到 ≥16ms 绘制一帧（~60fps），动画 dt 用真实间隔。
- 自适应降档：EMA(帧间隔) 采样，热身 60 帧；每 3s 检查：EMA>20ms 且 quality>0.55 → quality-=0.15 → resize；quality<=0.55 且 EMA>26ms → 调 `onFallback()` 并停止。只降不升。
- `prefers-reduced-motion`：只画一帧（u_time 固定 8.0s），不启动循环。
- 生命周期：`visibilitychange` 暂停/恢复；`webglcontextlost`（preventDefault）→ `onFallback()`；卸载时 `WEBGL_lose_context.loseContext()`。
- Props：`{ parallaxIndex?: number; onFallback?: () => void }`；`parallaxIndex` 经 ref 传入，帧内 `offset += (target-offset)*min(1,dt*2.5)`。
- reduced-motion 静态与 context 创建失败均走 `onFallback` 不可用态（纯静态仍可显示；失败时由父级隐藏）。

## 1.3 `TarotBokeh.tsx`（新，前景 z-30）

- 2D canvas，DPR `min(dpr,1.5)`；9 颗（宽屏 12）；每颗 `{ x,y,r:40-130, sprite:金/紫/青玉, alpha:0.05-0.10, driftVx:±(2-8)px/s, bobAmp:6-18, bobSpeed:0.15-0.4, phase, pf:0.8-1.5 }`
- 预渲染 3 张 128px 径向渐变 sprite；每帧 `globalCompositeOperation='lighter'` + `drawImage`（≈12 次，零分配）
- 视差：`x = wrap(baseX + elapsed*driftVx + parallaxX*pf, width+2m, -m)`；`y = baseY + sin(elapsed*bobSpeed+phase)*bobAmp`
- 60fps 跳帧同 shader；`visibilitychange` 暂停；reduced-motion 静态一帧；卸载清理。
- Props 同 shader：`{ parallaxIndex?: number }`。

## 1.4 `TarotParticles.tsx` 增强

- 新增 props `{ parallaxIndex?: number }`（ref 同步），帧内 `parallaxX` lerp（`dt*2`）到 `-(parallaxIndex-1.5)*34`。
- 星点：宽屏 220（85/75/60），手机 150（60/55/35）；alpha 远 0.10-0.25、中 0.22-0.45、近 0.40-0.80；near 星芒概率 0.4；星芒/光晕改 **预渲染 sprite**（金/白 × 光晕/十字 4 张），消除每帧 `createRadialGradient`。
- 银河：手机 420 点 / 宽屏 560 点，alpha `(1-|g|)*(0.08+rand*0.14)`。
- 星座：内置 6 组（北斗七星/仙后座/猎户座/天鹅座/天秤座/金牛座）；同屏常驻手机 5 / 宽屏 7；3×3 分区（中心 20/50/80% 横、18/47/76% 纵，抖动 ±7%）优先选未被占用分区；每组 `scale 0.16-0.40`、`ttl 20-32s`、fade 3s、初始/重生延迟 -1~-8s 错峰；线 alpha 0.26→0.38；标签仅近层（scale≥0.26）显示，alpha 0.16*env。
- 流星/火流星/流星雨参数不变；绘制坐标加各自视差偏移（0.8）；头部光晕也改 sprite。
- 60fps 跳帧（≥16ms 绘制一帧）；resize 重建 sprite/星/银河/星座；reduced-motion 静态帧画银河 + 三层星 + 全部星座 env=1。
- 所有层 x 坐标绘制时 `wrap(x+offset, width)` 防边缘跳变。

## 1.5 `TarotApp.tsx` 接线

- `tabIndex = TABS.findIndex(t => t.id === tab)`；`supportsWebGL()` 同步探测（临时 canvas `getContext('webgl')` 后 loseContext）决定初始 `skyOff`。
- 星云 3 团包一层 parallax wrapper（7%/Tab）；极光 wrapper（13.5%/Tab）：`transform: translateX(...)` + `transition: transform 1.6s cubic-bezier(.22,.8,.24,1)`。
- CSS 幕帘增强（回落保底）：`.tarot-curtain` 动画改 transform 横移（±20%，18s alternate，含 skew/scaleY 呼吸）；`.tarot-curtain-rev` 26s 反向；条纹 alpha 0.20-0.30、周期 320px、覆盖高 72%；新增 `.tarot-band` 大极光带（widget 140%，blur 26px，30s 横移）；幕帘+大极光带包一层 `opacity` 受控 wrapper：`skyOff ? 1 : 0`（0.8s 过渡）。
- `<TarotSkyShader parallaxIndex onFallback={() => setSkyOff(true)} />` 仅 `!skyOff` 渲染，位置在极光 wrapper 之后、ZodiacRing 之前。
- `<TarotParticles parallaxIndex />`；`<TarotBokeh parallaxIndex />` 渲染在 nav 之后（z-30）。
- 晕影 0.42 → 0.30。
- 三团柔光 alpha：紫 .24→.30、青玉 .17→.22、金 .10→.14；`tarotAurora` 位移 6%,4% → 12%,8%。

## 1.6 边界与禁止

- 不加依赖（不用 three/pixi）；WebGL 手写；shader 与 canvas 均在 TarotApp 内。
- 不改数据/存储/抽牌/注册点/版本号；不动其他 App。
- 写文件 UTF-8 无 BOM；新代码注释从简。

## 1.7 验收标准

1. `corepack pnpm@9.15.9 vitest run utils/tarot` 全绿。
2. `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts` 全绿。
3. `corepack pnpm@9.15.9 exec tsc --noEmit` 触碰文件零命中（存量基线）。
4. 本次触碰文件字节扫 `EF BF BD` = 0。
5. `pnpm dev` 肉眼：WebGL 星云/极光明显可见且横向流动；满屏星座；Tab 切换背景分层横移、内容纯淡入；前景散景掠过内容；低端/无 WebGL 环境回落 CSS 幕帘；reduced-motion 静态。
6. 收尾全量 vitest（已知 storageOptimize 负载抖动，单独复跑）。

---

# Part 2 · 执行清单（按序）

## Step 1 新增 `apps/tarot/TarotSkyShader.tsx`
按 Part 1.2。要点：全屏三角；fbm/aurora/milky GLSL；60fps 跳帧；quality 自适应（1.0/0.85/0.7/0.55 → onFallback）；reduce 单帧；visibility 暂停；contextlost/loseContext。验收：`tsc --noEmit` 无报错。

## Step 2 新增 `apps/tarot/TarotBokeh.tsx`
按 Part 1.3。验收：`tsc --noEmit` 无报错。

## Step 3 重写 `apps/tarot/TarotParticles.tsx`
按 Part 1.4。保留 reduce/dpr/visibility/cleanup/流星系统骨架；新增 parallax/sprite/6 星座/多实例/60fps。验收：`tsc --noEmit` 无报错。

## Step 4 改 `apps/TarotApp.tsx`
按 Part 1.5。验收：`tsc --noEmit`；层次「底色→星云→极光(回落)→WebGL→星座环→2D 天空→内容→晕影→前景散景」目检。

## Step 5 门禁与收尾
1. tarot 测试 + mojibake + tsc + FFFD 扫（Part 1.7 的 1-4）。
2. `notes/ethernet-features.md` 塔罗条目补一笔（WebGL 深空/视差/满屏星座/前景散景/回落）。
3. 全量 vitest；临时文件清零。
