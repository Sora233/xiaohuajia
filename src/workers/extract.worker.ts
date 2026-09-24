import { runExtraction } from '@/lib/extract'

type RequestMessage = {
  buffer: ArrayBuffer
  width: number
  height: number
  detail: number
}

// 用 globalThis，避免和页面的 DOM lib 抢 Worker 类型
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null
  postMessage: (data: unknown) => void
}

scope.onmessage = (event) => {
  const { buffer, width, height, detail } = event.data
  try {
    const rgba = new Uint8ClampedArray(buffer)
    const result = runExtraction(rgba, width, height, detail)
    scope.postMessage({
      ok: true,
      contours: result.contours,
      index: result.index,
      timings: result.timings,
    })
  } catch (err) {
    scope.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : '轮廓提取失败',
    })
  }
}
