import {
  buildSpatialIndex,
  thinSkeleton,
  traceContours,
  type Contour,
  type SpatialIndex,
} from '@/lib/contours'

/** 工作画布最长边，兼顾细节与主线程性能 */
export const MAX_EDGE = 1280

export type ProcessedImage = {
  width: number
  height: number
  /** 与参考图 1:1 对齐的原色彩画布 */
  color: HTMLCanvasElement
  contours: Contour[]
  index: SpatialIndex
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

/** 按最长边缩放，保持宽高比 */
export function rasterizeImage(
  img: HTMLImageElement,
  maxSize = MAX_EDGE,
): HTMLCanvasElement {
  const srcW = Math.max(1, img.naturalWidth || img.width)
  const srcH = Math.max(1, img.naturalHeight || img.height)
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))
  const canvas = createCanvas(width, height)
  const ctx = requireCtx(canvas)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

function gaussianBlur5(
  src: Float32Array,
  width: number,
  height: number,
): Float32Array {
  // 可分离 5-tap 近似高斯核
  const kernel = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136]
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k))
        acc += src[row + xx] * kernel[k + 2]
      }
      tmp[row + x] = acc
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k))
        acc += tmp[yy * width + x] * kernel[k + 2]
      }
      out[y * width + x] = acc
    }
  }
  return out
}

/**
 * 提取二值线掩膜：照片用 Sobel 边，线稿再加上深色墨迹。
 * `detail`：0–100，越大保留越弱的边。
 */
export function extractMask(
  color: HTMLCanvasElement,
  detail: number,
): Uint8Array {
  const { width, height } = color
  const ctx = requireCtx(color)
  const { data } = ctx.getImageData(0, 0, width, height)
  const n = width * height
  const gray = new Float32Array(n)

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }

  const blurred = gaussianBlur5(gray, width, height)
  const mag = new Float32Array(n)
  let maxMag = 1
  let meanGray = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -blurred[i - width - 1] +
        blurred[i - width + 1] -
        2 * blurred[i - 1] +
        2 * blurred[i + 1] -
        blurred[i + width - 1] +
        blurred[i + width + 1]
      const gy =
        -blurred[i - width - 1] -
        2 * blurred[i - width] -
        blurred[i - width + 1] +
        blurred[i + width - 1] +
        2 * blurred[i + width] +
        blurred[i + width + 1]
      const m = Math.hypot(gx, gy)
      mag[i] = m
      if (m > maxMag) maxMag = m
    }
  }

  for (let i = 0; i < n; i++) meanGray += blurred[i]
  meanGray /= n

  const looksLikeLineArt = meanGray > 150
  const tNorm = Math.min(100, Math.max(0, detail)) / 100
  const edgeT = maxMag * (0.4 - tNorm * 0.34)
  const inkT = looksLikeLineArt ? 176 : 108 + (1 - tNorm) * 42

  const mark = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const edge = mag[i] >= edgeT
    const ink = blurred[i] < inkT
    // 线稿只用墨迹，避免 Sobel 把每条线描成双边再撕碎骨架
    mark[i] = looksLikeLineArt ? (ink ? 1 : 0) : edge ? 1 : 0
  }
  return mark
}

export async function processSource(
  img: HTMLImageElement,
  detail: number,
): Promise<ProcessedImage> {
  const color = rasterizeImage(img)
  const mask = extractMask(color, detail)
  const skel = thinSkeleton(mask, color.width, color.height)
  const contours = traceContours(skel, color.width, color.height)
  const index = buildSpatialIndex(contours, color.width, color.height)
  return {
    width: color.width,
    height: color.height,
    color,
    contours,
    index,
  }
}
