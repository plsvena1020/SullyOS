# 塔罗「全屏极光 + 鱼眼星座 + 去框首页」— 设计 spec + 执行计划

日期：2026-09-12（第四波，接 `plans/2026-09-12-tarot-depth-parallax-plan.md`）
状态：用户已批准（同日对话：极光未满全屏、星座张力不够要鱼眼镜头、首页大框丑要去框、解读框去掉、「让 XX 解读」改四角纹样长方形按钮）。用户要求尽量省 token，本文件从简但保持可执行。

## 触碰文件清单

| 操作 | 文件 |
|------|------|
| 改 | `apps/tarot/TarotSkyShader.tsx` |
| 改 | `apps/tarot/TarotParticles.tsx` |
| 改 | `apps/TarotApp.tsx` |
| 改 | `apps/tarot/ReadingView.tsx` |
| 改 | `apps/tarot/TarotBokeh.tsx` |
| 新增 | `plans/2026-09-12-tarot-fisheye-homepage-plan.md`（本文件） |
| 收尾 | `notes/ethernet-features.md` |
| 不动 | 牌库/抽牌/存储/注册点/提示词/占卜状态机 |

---

# Part 1 · 设计 spec

## 1.1 全屏极光（TarotSkyShader）

- 3 条极光带 → 5 条，纵向贯穿：p.y 中心 `0.42 / 0.23 / 0.02 / -0.20 / -0.40`（p.y=0.5 顶部、-0.5 底部），宽度 0.16-0.18 交叠。
- 每条独立 seed/速度（含反向）/频率（4.5-7.5）；底部两条权重降低（0.75 / 0.55），顶部 0.9-1.0。
- 着色器本身全屏 quad，天然无边界；CSS 回落层改为高度 120% / 宽度 180%、left -40%、top -10%，纵向贯穿。
- 保留 60fps、分辨率自适应、contextlost 回落、reduced-motion 单帧。

## 1.2 鱼眼星座天穹（TarotParticles）

- 删除 3×3 分区与生命周期系统，改为 14 个固定天球锚点（az 均匀 + 抖动，radius 0.35-0.85 天球单位）。
- 天球单位：`unit = min(width,height)*0.5`；投影中心 `(width/2, height*0.44)`。
- 鱼眼投影：`d=|p|; f=d*(1+1.2*d²); 屏幕点 = center + p*(f/d)*unit`。中心线性、边缘外扩，偏心直线自然弯成弧。
- 连线：每条边取样 10 段，逐点投影折线（实现曲率）。
- yaw：`yaw = -(tabIndex-1.5)*0.9 + elapsed*0.004`，帧内 lerp 追赶；Tab 切换整片天穹旋转。
- 尺寸：`size = unit*(0.30+rand*0.18)`（比上版整体约 +35%）。
- 常驻 14 组全部绘制（无生命周期），仅按投影中心 ± 1.4*unit 视口范围裁剪离屏项；透明度呼吸 0.8-1.0。
- 双层连线：底层紫 `rgba(160,130,220,0.10)` lw3 + 上层金 `rgba(232,201,106,0.42)` lw1；星点光晕/星芒沿用预渲染 sprite；每组首星加大。
- 星座名仅当投影中心距镜头 < 0.5*unit 时显示。
- 银河/普通星/流星保留原线性视差，不参与 yaw。

## 1.3 首页去框（TarotApp DailyView）

- 删除外层面板 `rounded border bg-[#2d4a3e]/30 p-5`。
- 牌图保留 `rounded-[6px] ring-1 ring-[#c9a227]/40`，阴影改贴身 `0_10px_26px rgba(0,0,0,.55)`，背后加径向星辉层。
- 日期行/牌名/正逆位/关键词/牌义直属排版在星空上，`tarot-reveal` 保留。

## 1.4 解读去框 + 仪式按钮（ReadingView）

- 角色解读：删 `rounded border bg-[#181231]/90 p-4 shadow` 外框与顶部柔光；保留「印」章 + 角色名 + 渐变金线 + Sparkle；正文直接排版，加 `textShadow` 保证星空底可读。
- 按钮：`group relative mx-auto w-[88%] max-w-[420px] px-8 py-3.5`，无完整边框；背景深紫透明渐变；四角 L 纹（2px 金边 span，`rounded-*`，hover 向外平移 4px，`motion-reduce` 关闭位移）；文字金色衬线宽字距，两侧 `◇`；hover 扫光 `.tarot-sheen`（背景渐变位移 keyframes，不移动元素、无需 overflow-hidden）；asking 时文字与整体挂 `tarot-glow` 慢呼吸。
- TAROT_CSS 新增 `.tarot-sheen` + `tarotSheen`；reduced-motion 块加 `.tarot-sheen { animation:none!important; opacity:0!important }`。
- CSS 回落幕帘尺寸改全屏（见 1.1）。

## 1.5 前景散景

- TarotBokeh 透明度 `0.05-0.10` → `0.035-0.07`。

## 1.6 边界与禁止

- 不加依赖；不改数据/存储；写文件 UTF-8 无 BOM；新注释从简。
- shader 保持 WebGL1；性能纪律不变。

## 1.7 验收

1. `vitest run utils/tarot` + `mojibakeGuard` 全绿。
2. `tsc --noEmit` 触碰文件零命中。
3. 触碰文件 FFFD=0 / 无 BOM。
4. `vite build` 通过。
5. 无头 Edge 编译 + 渲染截图：极光覆盖上下全屏、竖向幕帘可见。
6. 全量 vitest。

---

# Part 2 · 执行清单（按序）

## Step 1 TarotSkyShader
5 带参数按 1.1；`aSum` 权重 `[0.9,0.85,1.0,0.75,0.55]`，`col += auroraCol*0.85; alpha += aSum*0.7` 保持。

## Step 2 TarotParticles
按 1.2 重写星座段：`DOME` 常量（def/az/radius/size/phase/speed/rot）+ `project()` + `drawDome()`；删除 zones/fillConstellations/makeConstellation/ConstellationViz.life 逻辑；静态帧（reduce）绘制 yaw=0 的全部天穹。

## Step 3 TarotApp
DailyView 去框按 1.3；CSS 幕帘/大极光带尺寸按 1.1；TAROT_CSS 加 `.tarot-sheen` 与 reduced-motion；顶部极光 CSS 不动。

## Step 4 ReadingView
按 1.4；`CornerMarks` 文件内小组件。

## Step 5 TarotBokeh
alpha 下调。

## Step 6 验证收尾
门禁 + 无头 Edge GLSL 截图 + notes + 全量 + 临时文件清理。
