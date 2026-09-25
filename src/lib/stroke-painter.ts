import type { Contour, SpatialIndex } from '@/lib/contours'
import { INK, PAPER, sampleInkColor } from '@/lib/ink-color'
import { matchFinishedStroke, type StrokeMatch } from '@/lib/match-stroke'
import { arcLength, easeInOutCubic, morphPolyline, slicePolylineByFraction, type Point } from '@/lib/polyline'

/** 先停一下让人看清自己的笔，再在大约 0.8s 内变过去 */
const HOLD_MS = 200
const MORPH_MS = 800
const FADE_MS = 460

type Phase = 'hold' | 'morph' | 'fade' | 'trace' | 'done'

/** 自动完成整段大约这么久，长线多占一点时间。 */
const AUTO_MS = 7000

/**
 * 长线优先，同时靠外的线优先。两项都归一化后相加，避免只按其中一个排。
 * 靠外看的是离画面重心最远的点，这样绕着主体的外轮廓会排在五官前面。
 */
function orderContours(contours: Contour[]): Contour[] {
  const usable = contours.filter((contour) => contour.points.length >= 2)
  if (usable.length === 0) return []
  let sx = 0
  let sy = 0
  let count = 0
  const lengths = usable.map((contour) => arcLength(contour.points))
  for (const contour of usable) {
    for (const point of contour.points) {
      sx += point.x
      sy += point.y
      count++
    }
  }
  const cx = count ? sx / count : 0
  const cy = count ? sy / count : 0
  let maxLen = 1
  let maxReach = 1
  const reaches = usable.map((contour, index) => {
    let far = 0
    for (const point of contour.points) {
      const dist = Math.hypot(point.x - cx, point.y - cy)
      if (dist > far) far = dist
    }
    if (lengths[index] > maxLen) maxLen = lengths[index]
    if (far > maxReach) maxReach = far
    return far
  })
  return usable
    .map((contour, index) => ({
      contour,
      score: lengths[index] / maxLen + reaches[index] / maxReach,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.contour)
}

export type ReplayPiece = {
  source: Point[]
  target: Point[]
}

export type ReplayStroke = {
  width: number
  pieces: ReplayPiece[]
}

export type ReplayMark = {
  lines: Point[][]
  width: number
  hints?: Point[][]
}

type StrokeRecord = {
  raw: Point[]
  pieces: StrokeMatch[]
  display: Point[][]
  width: number
  opacity: number
  phase: Phase
  elapsed: number
  holdMs: number
  duration: number
  /** 轮廓换过之后，旧笔画不再占用新的目标线 */
  epoch: number
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
 * 绘制时原样保留用户笔迹；抬笔后匹配参考轮廓，再把这一笔变形过去。
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
  private liveRaw: Point[] = []
  private colorMode = true
  private snapRadius = 36
  /** 每次换轮廓就加一，避免旧下标误占新线 */
  private epoch = 0
  /** 仅供本地核对最近一笔匹配了几段目标线 */
  debugMatchCount = 0
  private animFrame = 0
  private lastNow = 0
  private autoQueue: Contour[] = []
  private autoDurations: number[] = []
  private autoOnDone: (() => void) | null = null
  width = 0
  height = 0

  attach(result: HTMLCanvasElement, raw: HTMLCanvasElement) {
    this.result = result
    this.raw = raw
    this.resultCtx = requireCtx(result)
    this.rawCtx = requireCtx(raw)
  }

  dispose() {
    this.stopAnim()
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
    this.liveRaw = []
    this.finishAuto(true)
    this.stopAnim()
    this.redraw()
  }

  setDocument(opts: {
    contours: Contour[]
    index: SpatialIndex
    color: HTMLCanvasElement
  }) {
    this.contours = opts.contours
    this.index = opts.index
    this.epoch++
    const ctx = opts.color.getContext('2d', { willReadFrequently: true })
    this.colorData = ctx ? ctx.getImageData(0, 0, opts.color.width, opts.color.height) : null
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
    this.liveRaw = [{ x, y }]
    this.redraw()
  }

  moveStroke(x: number, y: number) {
    if (!this.index || this.liveRaw.length === 0) return
    const last = this.liveRaw[this.liveRaw.length - 1]
    if (last && Math.hypot(last.x - x, last.y - y) < 0.8) return
    this.liveRaw.push({ x, y })
    this.redraw()
  }

  endStroke() {
    if (this.liveRaw.length === 0) return
    const raw = this.liveRaw.slice()
    this.liveRaw = []
    const width = inkWidth(this.snapRadius)
    if (raw.length < 2 || !this.index) {
      this.redraw()
      return
    }

    const taken = this.strokes.flatMap((stroke) =>
      stroke.epoch === this.epoch
        ? stroke.pieces
            .filter((piece) => piece.spans.length > 0)
            .map((piece) => ({ contourId: piece.contourId, spans: piece.spans }))
        : [],
    )
    const matched = matchFinishedStroke(raw, this.contours, this.index, this.snapRadius, taken)
    this.debugMatchCount = matched?.length ?? 0
    if (!matched) {
      this.strokes.push({
        raw,
        pieces: [],
        display: [raw],
        width,
        opacity: 1,
        phase: 'fade',
        elapsed: 0,
        holdMs: 0,
        duration: FADE_MS,
        epoch: this.epoch,
      })
    } else {
      this.strokes.push({
        raw,
        pieces: matched,
        display: matched.map((p) => p.source),
        width,
        opacity: 1,
        phase: 'hold',
        elapsed: 0,
        holdMs: HOLD_MS,
        duration: MORPH_MS,
        epoch: this.epoch,
      })
    }
    this.ensureAnim()
    this.redraw()
  }

  undo() {
    const last = this.strokes.pop()
    if (!last) return false
    if (!this.strokes.some((s) => s.phase !== 'done')) this.stopAnim()
    this.redraw()
    return true
  }

  clear() {
    const auto = this.autoQueue.length > 0 || this.autoOnDone !== null
    if (this.strokes.length === 0 && this.liveRaw.length === 0 && !auto) return
    this.strokes = []
    this.liveRaw = []
    this.finishAuto(true)
    this.stopAnim()
    this.redraw()
  }

  /** 按长到短、外到内的综合顺序，把还没画过的轮廓描出来。 */
  startAutoDraw(onDone: () => void): boolean {
    if (this.autoOnDone || this.autoQueue.length > 0) return false
    const taken = new Set(
      this.strokes
        .filter((stroke) => stroke.epoch === this.epoch)
        .flatMap((stroke) => stroke.pieces.map((piece) => piece.contourId)),
    )
    const ordered = orderContours(this.contours).filter((contour) => {
      if (taken.has(contour.id)) return false
      return contour.points.length >= 2 && arcLength(contour.points) >= 2
    })
    if (ordered.length === 0) return false
    const lengths = ordered.map((contour) => arcLength(contour.points))
    const sum = lengths.reduce((total, len) => total + len, 0) || 1
    let durations = lengths.map((len) => Math.max(16, (AUTO_MS * len) / sum))
    const planned = durations.reduce((total, len) => total + len, 0)
    if (planned > AUTO_MS) {
      const scale = AUTO_MS / planned
      durations = durations.map((len) => Math.max(12, len * scale))
    }
    this.autoQueue = ordered
    this.autoDurations = durations
    this.autoOnDone = onDone
    this.pumpAuto()
    return this.autoOnDone !== null
  }

  resetAll() {
    this.strokes = []
    this.liveRaw = []
    this.finishAuto(true)
    this.stopAnim()
    this.redraw()
  }

  exportPng(): string {
    if (!this.result) return ''
    return this.result.toDataURL('image/png')
  }

  /** 至少有一笔对上了参考轮廓。对不上、只会淡出的笔不算。 */
  hasReplay() {
    return this.strokes.some((stroke) => stroke.pieces.length > 0)
  }

  /**
   * 按作画顺序交出有效笔画的源和目标。
   * 拷贝顶点，导出过程中撤销或清空也不会把这一帧改掉。
   */
  replayStrokes(): ReplayStroke[] {
    const out: ReplayStroke[] = []
    for (const stroke of this.strokes) {
      if (stroke.pieces.length === 0) continue
      out.push({
        width: stroke.width,
        pieces: stroke.pieces.map((piece) => ({
          source: piece.source.map((p) => ({ x: p.x, y: p.y })),
          target: piece.target.map((p) => ({ x: p.x, y: p.y })),
        })),
      })
    }
    return out
  }

  /** 把一组笔画画进任意画布，不碰正在作画的那张。 */
  paintReplay(ctx: CanvasRenderingContext2D, marks: ReplayMark[]) {
    for (const mark of marks) {
      if (mark.hints) {
        for (const hint of mark.hints) this.paintTargetHint(ctx, hint, mark.width)
      }
      for (const line of mark.lines) this.paintStroke(ctx, line, mark.width, this.colorMode)
    }
  }

  private finishAuto(notify: boolean) {
    this.autoQueue = []
    this.autoDurations = []
    const done = this.autoOnDone
    this.autoOnDone = null
    if (notify) done?.()
  }

  private pumpAuto() {
    const width = inkWidth(this.snapRadius)
    while (this.autoQueue.length > 0) {
      const contour = this.autoQueue.shift()
      const duration = this.autoDurations.shift() ?? 40
      if (!contour || contour.points.length < 2) continue
      const pts = contour.points.map((point) => ({ x: point.x, y: point.y }))
      this.strokes.push({
        raw: pts,
        pieces: [
          {
            source: pts,
            target: pts,
            contourId: contour.id,
            spans: [[0, pts.length - 1]],
          },
        ],
        display: [[{ x: pts[0].x, y: pts[0].y }]],
        width,
        opacity: 1,
        phase: 'trace',
        elapsed: 0,
        holdMs: 0,
        duration,
        epoch: this.epoch,
      })
      this.ensureAnim()
      return
    }
    this.finishAuto(true)
  }

  private ensureAnim() {
    if (this.animFrame) return
    this.lastNow = 0
    this.animFrame = requestAnimationFrame(this.tick)
  }

  private stopAnim() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame)
    this.animFrame = 0
    this.lastNow = 0
  }

  private tick = (now: number) => {
    const dt = this.lastNow ? Math.min(40, now - this.lastNow) : 16
    this.lastNow = now
    let busy = false
    let pump = false
    for (const s of this.strokes) {
      if (s.phase === 'done') continue
      busy = true
      s.elapsed += dt
      if (s.phase === 'hold') {
        if (s.elapsed >= s.holdMs) {
          s.phase = 'morph'
          s.elapsed = 0
        }
      } else if (s.phase === 'morph') {
        const t = Math.min(1, s.elapsed / s.duration)
        const eased = easeInOutCubic(t)
        s.display = s.pieces.map((p) => morphPolyline(p.source, p.target, eased))
        s.opacity = 1
        if (t >= 1) {
          s.phase = 'done'
          s.display = s.pieces.map((p) => p.target.map((pt) => ({ ...pt })))
        }
      } else if (s.phase === 'trace') {
        const t = Math.min(1, s.elapsed / Math.max(1, s.duration))
        s.display = [slicePolylineByFraction(s.raw, 0, t)]
        if (t >= 1) {
          s.phase = 'done'
          s.display = [s.raw.map((point) => ({ x: point.x, y: point.y }))]
          pump = true
        }
      } else if (s.phase === 'fade') {
        const t = Math.min(1, s.elapsed / s.duration)
        s.opacity = 1 - easeInOutCubic(t)
        if (t >= 1) {
          s.phase = 'done'
          s.opacity = 0
          s.display = []
        }
      }
    }
    if (pump) this.pumpAuto()
    if (this.autoQueue.length > 0 || this.strokes.some((s) => s.phase === 'trace')) busy = true
    this.redraw()
    if (busy) this.animFrame = requestAnimationFrame(this.tick)
    else {
      this.animFrame = 0
      this.lastNow = 0
    }
  }

  private sampleColor(x: number, y: number): string {
    return sampleInkColor(this.colorData, x, y)
  }

  private paintStroke(
    ctx: CanvasRenderingContext2D,
    pts: Point[],
    width: number,
    colorize: boolean,
  ) {
    if (pts.length === 1) {
      ctx.fillStyle = colorize ? this.sampleColor(pts[0].x, pts[0].y) : INK
      ctx.beginPath()
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
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

  /** 抬笔后短暂标出将对上的那条参考线 */
  private paintTargetHint(ctx: CanvasRenderingContext2D, pts: Point[], width: number) {
    if (pts.length < 2) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(181, 68, 42, 0.36)'
    ctx.lineWidth = width + 4.5
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
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

  private syncPhaseAttr() {
    if (!this.result) return
    const live = this.liveRaw.length > 0
    const holding = this.strokes.some((s) => s.phase === 'hold')
    const morphing = this.strokes.some((s) => s.phase === 'morph')
    const fading = this.strokes.some((s) => s.phase === 'fade')
    this.result.dataset.phase = live
      ? 'drawing'
      : morphing
        ? 'morph'
        : holding
          ? 'hold'
          : fading
            ? 'fade'
            : 'idle'
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
      if (s.opacity <= 0.01 || s.display.length === 0) continue
      ctx.save()
      ctx.globalAlpha = s.opacity
      if (s.phase === 'hold' || s.phase === 'morph') {
        for (const piece of s.pieces) this.paintTargetHint(ctx, piece.target, s.width)
      }
      for (const pts of s.display) this.paintStroke(ctx, pts, s.width, this.colorMode)
      ctx.restore()
    }
    if (this.liveRaw.length) {
      this.paintStroke(ctx, this.liveRaw, inkWidth(this.snapRadius), this.colorMode)
    }
    ctx.restore()
    this.syncPhaseAttr()

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
