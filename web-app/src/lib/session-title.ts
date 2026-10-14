export type SessionTitleInput = { messageId: string; content: string; manual?: boolean; done?: boolean }
export const sessionTitleKey = (targetId: string, sessionId: string) => `bibit:session-title:${JSON.stringify([targetId, sessionId])}`
export const sessionTitleRequests = new Map<string, Promise<unknown>>()
export function readSessionTitle(key: string): SessionTitleInput | undefined {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined }
  catch { return undefined }
}
