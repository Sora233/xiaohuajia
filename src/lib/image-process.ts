import type { Contour, SpatialIndex } from '@/lib/contours'
import type { ExtractionTimings } from '@/lib/extract'

/** 工作画布最长边。上传的大图先缩到这里，再提取轮廓。 */
export const MAX_EDGE = 1280

export type ProcessedImage = {
  width: number
  height: number
  /** 与参考图 1:1 对齐的原色彩画布 */
  color: HTMLCanvasElement
  contours: Contour[]
  index: SpatialIndex
  timings: ExtractionTimings & { raster: number; worker: number }
}

/** 后一次提取取消了前一次 */
export class ProcessingCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'ProcessingCancelled'
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function requireCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持画布')
  return ctx
}

/** 把文件或 URL 读成 HTMLImageElement */
export function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片无法加载，请换一张再试'))
    img.src = src
  })
}

function fittedSize(srcW: number, srcH: number, maxSize: number) {
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH))
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  }
}

/**
 * 按最长边缩放。优先用 createImageBitmap，把解码和缩放让出主线程。
 * 尺寸只看图片本身，不乘 devicePixelRatio。
 */
export async function rasterizeImage(
  img: HTMLImageElement,
  maxSize = MAX_EDGE,
): Promise<HTMLCanvasElement> {
  const srcW = Math.max(1, img.naturalWidth || img.width)
  const srcH = Math.max(1, img.naturalHeight || img.height)
  const { width, height } = fittedSize(srcW, srcH, maxSize)
  const canvas = createCanvas(width, height)
  const ctx = requireCtx(canvas)
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(img, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      })
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
      return canvas
    } catch {
      // 个别浏览器不接受 resize 选项，退回同步绘制
    }
  }
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

type WorkerResponse = {
  ok: boolean
  contours?: Contour[]
  index?: SpatialIndex
  timings?: ExtractionTimings
  error?: string
}

let activeWorker: Worker | null = null
let activeReject: ((err: Error) => void) | null = null

function spawnWorker(
  buffer: ArrayBuffer,
  width: number,
  height: number,
  detail: number,
): Promise<{ contours: Contour[]; index: SpatialIndex; timings: ExtractionTimings }> {
  activeWorker?.terminate()
  activeReject?.(new ProcessingCancelled())
  activeReject = null

  // Vite 会按 base（GitHub Pages 的 /xiaohuajia/）改写这个 URL
  const worker = new Worker(new URL('../workers/extract.worker.ts', import.meta.url), {
    type: 'module',
  })
  activeWorker = worker

  return new Promise((resolve, reject) => {
    activeReject = reject
    const timer = window.setTimeout(() => {
      if (activeWorker === worker) {
        worker.terminate()
        activeWorker = null
        activeReject = null
      }
      reject(new Error('处理超时'))
    }, 20000)

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      window.clearTimeout(timer)
      if (activeWorker === worker) {
        activeWorker = null
        activeReject = null
      }
      worker.terminate()
      const data = event.data
      if (!data.ok || !data.contours || !data.index || !data.timings) {
        reject(new Error(data.error || '轮廓提取失败'))
        return
      }
      resolve({ contours: data.contours, index: data.index, timings: data.timings })
    }
    worker.onerror = () => {
      window.clearTimeout(timer)
      if (activeWorker === worker) {
        activeWorker = null
        activeReject = null
      }
      reject(new Error('轮廓提取失败'))
    }
    worker.postMessage({ buffer, width, height, detail }, [buffer])
  })
}

function logTimings(
  width: number,
  height: number,
  raster: number,
  workerMs: number,
  timings: ExtractionTimings,
) {
  const detail = timings.traceDetail
  const traceText = detail
    ? `边${detail.edges} 路径${detail.paths} 轮廓${detail.contours} ` +
      `去碎${detail.removeSmall} 方块${detail.collapse} 毛刺${detail.prune} ` +
      `抽链${detail.atomic} 穿叉${detail.link} 补缺${detail.bridge} 平滑${detail.polish}`
    : ''
  console.info(
    `[小画家] 处理 ${width}x${height} 合计${Math.round(raster + workerMs)}ms ` +
      `栅格${Math.round(raster)} 掩膜${Math.round(timings.mask)} 细化${Math.round(timings.thin)} ` +
      `描线${Math.round(timings.trace)} 索引${Math.round(timings.index)} ${traceText}`,
  )
}

/** 缩放在页面里做，细化与描线放到 Worker，避免卡住界面。 */
export async function processSource(
  img: HTMLImageElement,
  detail: number,
): Promise<ProcessedImage> {
  const t0 = performance.now()
  const color = await rasterizeImage(img)
  const raster = performance.now() - t0
  const { width, height } = color
  const pixels = requireCtx(color).getImageData(0, 0, width, height)
  const copy = new Uint8ClampedArray(pixels.data)
  const tWorker = performance.now()
  const extracted = await spawnWorker(copy.buffer, width, height, detail)
  const workerMs = performance.now() - tWorker
  logTimings(width, height, raster, workerMs, extracted.timings)
  return {
    width,
    height,
    color,
    contours: extracted.contours,
    index: extracted.index,
    timings: { ...extracted.timings, raster, worker: workerMs },
  }
}
