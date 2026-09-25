import {
  Download,
  Eraser,
  Film,
  ImagePlus,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import type { ChangeEvent, RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

type ToolbarProps = {
  fileRef: RefObject<HTMLInputElement | null>
  hasImage: boolean
  canUndo: boolean
  processing: boolean
  colorMode: boolean
  showRaw: boolean
  onUploadClick: () => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onSample: () => void
  onColorMode: (value: boolean) => void
  onShowRaw: (value: boolean) => void
  onUndo: () => void
  onClear: () => void
  onDownload: () => void
  canExportGif: boolean
  exportingGif: boolean
  onExportGif: () => void
}

export function Toolbar({
  fileRef,
  hasImage,
  canUndo,
  processing,
  colorMode,
  showRaw,
  onUploadClick,
  onFileChange,
  onSample,
  onColorMode,
  onShowRaw,
  onUndo,
  onClear,
  onDownload,
  canExportGif,
  exportingGif,
  onExportGif,
}: ToolbarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line/80 bg-paper/90 p-3 shadow-[0_10px_40px_-24px_rgba(28,25,22,0.45)] backdrop-blur-sm md:p-4">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={onFileChange}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onUploadClick} disabled={processing}>
          <ImagePlus />
          {hasImage ? '更换图片' : '上传图片'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onSample}
          disabled={processing}
          data-testid="load-sample"
        >
          <Sparkles />
          使用示例图
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onUndo}
            disabled={!canUndo}
          >
            <RotateCcw />
            撤销
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onClear}
            disabled={!hasImage}
          >
            <Eraser />
            清空
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={onDownload}
            disabled={!hasImage}
          >
            <Download />
            下载 PNG
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={onExportGif}
            disabled={!canExportGif || exportingGif}
            data-testid="export-gif"
          >
            <Film />
            {exportingGif ? '导出中' : '导出GIF'}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-xl bg-paper-2/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">参考图上色</p>
            <p className="text-[11px] text-muted">关闭则为墨色笔画</p>
          </div>
          <Switch
            checked={colorMode}
            onCheckedChange={onColorMode}
            disabled={!hasImage}
            data-testid="color-mode"
          />
        </label>

        <label className="flex items-center justify-between gap-3 rounded-xl bg-paper-2/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">显示原始笔迹</p>
            <p className="text-[11px] text-muted">半透明对照你的乱笔</p>
          </div>
          <Switch
            checked={showRaw}
            onCheckedChange={onShowRaw}
            disabled={!hasImage}
          />
        </label>
      </div>
    </div>
  )
}
