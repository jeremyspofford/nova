import clsx from 'clsx'

const BASE = 'mb-1 block text-xs text-neutral-500 dark:text-neutral-400'

export function Label({
  className,
  children,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={clsx(BASE, className)} {...rest}>
      {children}
    </label>
  )
}
