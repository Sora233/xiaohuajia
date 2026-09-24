import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-line transition-colors data-[state=checked]:bg-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-paper shadow-sm transition-transform data-[state=checked]:translate-x-[1.1rem]" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
