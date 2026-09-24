import sampleSvg from '@/assets/sample-reference.svg?raw'

/** 内联示例图，file:// 单文件构建也能用，不必再请求外部资源 */
export const SAMPLE_IMAGE_SRC =
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sampleSvg)
