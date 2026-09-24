import type { LabelHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'text-xs font-medium leading-none text-muted peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
