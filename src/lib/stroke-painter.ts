import {
  SnapSession,
  type Contour,
  type Point,
  type SpatialIndex,
} from '@/lib/contours'

const PAPER = '#fffaf3'
const INK = '#1c1916'

export type StrokeRecord = {
  snapped: Point[]
  raw: Point[]
  width: number
}

function requireCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持画布')
  return ctx
}

function inkWidth(snapRadius: number) {
  return Math.max(3.1, Math.min(6, 2.8 + snapRadius * 0.045))
}

/**
 * 把用户笔画吸附到参考轮廓上，再当「笔画」画出来（不是揭开窗口）。
 */
export class StrokePainter {
  private result: HTMLCanvasElement | null = null
  private raw: HTMLCanvasElement | null = null
  private resultCtx: CanvasRenderingContext2D | null = null
  private rawCtx: CanvasRenderingContext2D | null = null
  private contours: Contour[] = []
  private index: SpatialIndex | null = null
  private colorData: ImageData | null = null
  private strokes: StrokeRecord[] = []
  private session: SnapSession | null = null
  private live: Point[] | null = null
  private liveRaw: Point[] = []
  private colorMode = false
  private snapRadius = 28
  width = 0
  height = 0

  attach(result: HTMLCanvasElement, raw: HTMLCanvasElement) {
    this.result = result
    this.raw = raw
    this.resultCtx = requireCtx(result)
    this.rawCtx = requireCtx(raw)
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    if (this.result) {
      this.result.width = width
      this.result.height = height
    }
    if (this.raw) {
      this.raw.width = width
      this.raw.height = height
    }
    this.strokes = []
    this.session = null
    this.live = null
    this.liveRaw = []
    this.redraw()
  }

  setDocument(opts: {
    contours: Contour[]
    index: SpatialIndex
    color: HTMLCanvasElement
  }) {
    this.contours = opts.contours
    this.index = opts.index
    const ctx = opts.color.getContext('2d', { willReadFrequently: true })
    this.colorData = ctx
      ? ctx.getImageData(0, 0, opts.color.width, opts.color.height)
      : null
    this.redraw()
  }

  setColorMode(on: boolean) {
    if (this.colorMode === on) return
    this.colorMode = on
    this.redraw()
  }

  setSnapRadius(radius: number) {
    this.snapRadius = radius
  }

  canUndo() {
    return this.strokes.length > 0
  }

  beginStroke(x: number, y: number) {
    if (!this.index) return
    this.session = new SnapSession(this.contours, this.index, this.snapRadius)
    this.session.add(x, y)
    this.live = this.session.live()
    this.liveRaw = this.session.raw.slice()
    this.redraw()
  }

  moveStroke(x: number, y: number) {
    if (!this.session) return
    this.session.add(x, y)
    this.live = this.session.live()
    this.liveRaw = this.session.raw.slice()
    this.redraw()
  }

  endStroke() {
    if (!this.session) return
    const snapped = this.session.finalize()
    const raw = this.session.raw.slice()
    this.session = null
    this.live = null
    this.liveRaw = []
    this.strokes.push({
      snapped: snapped && snapped.length >= 2 ? snapped : [],
      raw,
      width: inkWidth(this.snapRadius),
    })
    this.redraw()
  }

  undo() {
    const last = this.strokes.pop()
    if (!last) return false
    this.redraw()
    return true
  }

  clear() {
    if (this.strokes.length === 0 && !this.session) return
    this.strokes = []
    this.session = null
    this.live = null
    this.liveRaw = []
    this.redraw()
  }

  resetAll() {
    this.strokes = []
    this.session = null
    this.live = null
    this.liveRaw = []
    this.redraw()
  }

  exportPng(): string {
    if (!this.result) return ''
    return this.result.toDataURL('image/png')
  }

  private sampleColor(x: number, y: number): string {
    const data = this.colorData
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

  private paintStroke(
    ctx: CanvasRenderingContext2D,
    pts: Point[],
    width: number,
    colorize: boolean,
  ) {
    if (pts.length < 2) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = width
    if (!colorize) {
      ctx.strokeStyle = INK
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
      return
    }
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = this.sampleColor(pts[i].x, pts[i].y)
      ctx.beginPath()
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
      ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
  }

  private paintRaw(ctx: CanvasRenderingContext2D, pts: Point[]) {
    if (pts.length < 2) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(181, 68, 42, 0.42)'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }

  redraw() {
    const ctx = this.resultCtx
    if (!ctx || !this.result) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, this.width, this.height)
    for (const s of this.strokes) {
      this.paintStroke(ctx, s.snapped, s.width, this.colorMode)
    }
    if (this.live && this.live.length >= 2) {
      this.paintStroke(ctx, this.live, inkWidth(this.snapRadius), this.colorMode)
    }
    ctx.restore()

    const raw = this.rawCtx
    if (!raw || !this.raw) return
    raw.save()
    raw.setTransform(1, 0, 0, 1, 0, 0)
    raw.clearRect(0, 0, this.width, this.height)
    for (const s of this.strokes) this.paintRaw(raw, s.raw)
    if (this.liveRaw.length >= 2) this.paintRaw(raw, this.liveRaw)
    raw.restore()
  }
}

/** 把指针位置映射到画布像素坐标（与参考图 1:1） */
export function pointerToCanvas(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height
  return { x, y }
}
