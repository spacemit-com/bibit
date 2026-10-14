import { useEffect, useRef, useState } from 'react'

/**
 * Rate-limit how often a rapidly-changing value reaches the renderer.
 *
 * Streaming Markdown still parses the active tail and updates the DOM.
 * A wall-clock bound caps that work regardless of token arrival rate.
 *
 * Always converges — the trailing edge emits the newest value, and disabling
 * throttling passes the live value straight through, so the final content can
 * never be left truncated.
 */
export function useThrottledValue<T>(
  value: T,
  intervalMs: number,
  enabled: boolean
): T {
  const [throttled, setThrottled] = useState(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEmit = useRef(0)

  latest.current = value

  useEffect(() => {
    if (!enabled) return

    const now = Date.now()
    const elapsed = now - lastEmit.current

    if (elapsed >= intervalMs) {
      lastEmit.current = now
      setThrottled(value)
      return
    }

    // A trailing flush is already pending; it will pick up `latest`.
    if (timer.current !== null) return

    timer.current = setTimeout(() => {
      timer.current = null
      lastEmit.current = Date.now()
      setThrottled(latest.current)
    }, intervalMs - elapsed)
  }, [value, intervalMs, enabled])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  // Pass through when disabled so the completed value renders in full
  // immediately, without waiting on a pending interval.
  return enabled ? throttled : value
}
