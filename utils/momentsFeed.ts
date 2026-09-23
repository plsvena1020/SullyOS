// utils/momentsFeed.ts
// 朋友圈纯函数：封面尺寸门（Task 2）；归一化/去重/映射（Task 3 追加）。
export const MOMENTS_COVER_MAX_BYTES = 1024 * 1024;
export function coverSizeOk(dataUrlLengthBytes: number): boolean {
  return dataUrlLengthBytes <= MOMENTS_COVER_MAX_BYTES;
}
