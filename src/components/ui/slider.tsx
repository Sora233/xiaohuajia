import * as SliderPrimitive from '@radix-ui/react-slider'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

function Slider({
  className,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-line">
        <SliderPrimitive.Range className="absolute h-full bg-ink" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border border-line bg-paper shadow-sm ring-cinnabar/30 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2" />
    </SliderPrimitive.Root>
  )
}

export { Slider }
