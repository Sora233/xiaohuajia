import type { Contour } from '@/lib/contours'
import { INK, PAPER, sampleInkColor } from '@/lib/ink-color'

/**
 * 把提取出的轮廓画成一张完整线稿，给进入画布前的预览和「参考图」用。
 * 传入原图时按参考图上色逐段取色，否则整张都是墨线。
 */
export function renderLineSheet(
  contours: Contour[],
  width: number,
  height: number,
  colorSource?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1.6, Math.min(3.2, canvas.width / 420))

  const colorCtx = colorSource?.getContext('2d', { willReadFrequently: true })
  const colorData =
    colorSource && colorCtx
      ? colorCtx.getImageData(0, 0, colorSource.width, colorSource.height)
      : null

  if (!colorData) {
    ctx.strokeStyle = INK
    for (const contour of contours) strokeInk(ctx, contour)
    return canvas
  }

  for (const contour of contours) strokeColored(ctx, contour, colorData)
  return canvas
}

function strokeInk(ctx: CanvasRenderingContext2D, contour: Contour) {
  const pts = contour.points
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  if (contour.closed) ctx.closePath()
  ctx.stroke()
}

/** 同一颜色的连续点并成一笔，颜色规则与笔画上色一致。 */
function strokeColored(ctx: CanvasRenderingContext2D, contour: Contour, data: ImageData) {
  const pts = contour.points
  if (pts.length < 2) return
  const last = contour.closed ? pts.length : pts.length - 1
  let i = 0
  while (i < last) {
    const from = pts[i]
    const head = pts[(i + 1) % pts.length]
    const color = sampleInkColor(data, head.x, head.y)
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(head.x, head.y)
    let j = i + 1
    while (j < last) {
      const next = pts[(j + 1) % pts.length]
      if (sampleInkColor(data, next.x, next.y) !== color) break
      ctx.lineTo(next.x, next.y)
      j++
    }
    ctx.stroke()
    i = j
  }
}
