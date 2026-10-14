declare module 'tar' {
  export function c(options: Record<string, unknown>, files: string[]): Promise<void>
  export function x(options: Record<string, unknown>): Promise<void>
}
