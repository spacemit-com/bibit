export function FeatureEmptyState({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <section aria-live="polite" className="grid place-items-center gap-2 p-8 text-center">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </section>
  )
}
