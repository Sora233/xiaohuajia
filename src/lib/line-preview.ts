import type { Contour } from '@/lib/contours'

/** 把提取出的轮廓画成一张完整线稿，给进入画布前的预览和「参考图」用。 */
export function renderLineSheet(
  contours: Contour[],
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  ctx.fillStyle = '#fffaf3'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#1c1916'
  ctx.lineWidth = Math.max(1.6, Math.min(3.2, canvas.width / 420))

  for (const contour of contours) {
    const pts = contour.points
    if (pts.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    if (contour.closed) ctx.closePath()
    ctx.stroke()
  }
  return canvas
}
