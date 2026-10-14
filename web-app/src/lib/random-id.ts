// Same contract as the AI SDK's `generateId` (re-exported from
// @ai-sdk/provider-utils): 16 chars drawn from [0-9A-Za-z].
// Kept local because importing `ai` for one string generator pulled the whole
// SDK (plus zod, @ai-sdk/* and @opentelemetry/api) into the main window's
// first-paint chunk, and it must be parsed before the shell can render.
const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export const generateId = (size = 16): string => {
  const chars = new Array<string>(size)
  for (let i = 0; i < size; i++) {
    chars[i] = ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return chars.join('')
}
