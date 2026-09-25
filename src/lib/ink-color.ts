/** 纸色与墨色，画布和参考线稿共用。 */
export const PAPER = '#fffaf3'
export const INK = '#1c1916'

/**
 * 接近白纸的像素仍用墨色，其余取原图像素。
 * 笔画上色和参考图上色走同一条规则。
 */
export function sampleInkColor(data: ImageData | null, x: number, y: number): string {
  if (!data) return INK
  const ix = Math.min(data.width - 1, Math.max(0, Math.round(x)))
  const iy = Math.min(data.height - 1, Math.max(0, Math.round(y)))
  const o = (iy * data.width + ix) * 4
  const r = data.data[o]
  const g = data.data[o + 1]
  const b = data.data[o + 2]
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  if (luma > 228) return INK
  return `rgb(${r},${g},${b})`
}
