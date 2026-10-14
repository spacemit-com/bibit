import type { ReactNode } from 'react'

export function FeatureSettingsPage({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <section className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  )
}
