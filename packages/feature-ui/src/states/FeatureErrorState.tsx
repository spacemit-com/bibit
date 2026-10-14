import { Button } from '../components/Button'

export function FeatureErrorState({
  title,
  description,
  onRetry,
}: {
  title: string
  description?: string
  onRetry?: () => void
}) {
  return (
    <section role="alert" aria-live="assertive" className="grid gap-2 p-4">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {onRetry && <Button onClick={onRetry}>Retry</Button>}
    </section>
  )
}
