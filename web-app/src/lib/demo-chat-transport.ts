import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  ChatRequestOptions,
  ChatTransport,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import {
  extractLatestUserMessage,
  isDemoRuntimeEvent,
  type DemoRuntimeEvent,
} from '@/lib/demo-runtime'
import { useDemoRuntimeStore } from '@/stores/demo-runtime-store'

const DEMO_RUNTIME_EVENT = 'demo-runtime-event'

export class DemoChatTransport implements ChatTransport<UIMessage> {
  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message'
      chatId: string
      messageId: string | undefined
      messages: UIMessage[]
      abortSignal: AbortSignal | undefined
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const userMessage = extractLatestUserMessage(options.messages)
    const originWindow = getCurrentWebviewWindow().label
    let activeRunId: string | undefined
    let returnedRunId: string | undefined
    let unlisten: UnlistenFn | undefined
    let expectedSequence = 0
    let accumulated = ''
    let textStarted = false
    let terminal = false
    let cancelRequested = false

    const cleanup = () => {
      options.abortSignal?.removeEventListener('abort', onAbort)
      unlisten?.()
      unlisten = undefined
    }

    const cancelActiveRun = () => {
      if (!activeRunId || cancelRequested || terminal) return
      cancelRequested = true
      void invoke('cancel_demo_runtime', { runId: activeRunId })
    }

    const onAbort = () => cancelActiveRun()

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        const closeWithError = (message: string) => {
          if (terminal) return
          terminal = true
          controller.enqueue({ type: 'error', errorText: message })
          controller.close()
          cleanup()
        }

        const handleEvent = (event: DemoRuntimeEvent) => {
          if (terminal || event.sessionId !== options.chatId) return

          if (event.type === 'run_started') {
            if (activeRunId || event.sequence !== 0) return
            if (returnedRunId && event.runId !== returnedRunId) return
            activeRunId = event.runId
            expectedSequence = 1
            controller.enqueue({ type: 'start', messageId: event.runId })
            controller.enqueue({ type: 'text-start', id: event.runId })
            textStarted = true
            if (options.abortSignal?.aborted) cancelActiveRun()
            return
          }

          if (
            !activeRunId ||
            event.runId !== activeRunId ||
            event.sequence !== expectedSequence
          ) {
            return
          }
          expectedSequence += 1

          if (event.type === 'message_delta') {
            accumulated += event.delta
            controller.enqueue({
              type: 'text-delta',
              id: activeRunId,
              delta: event.delta,
            })
            return
          }

          if (event.type === 'message_completed') {
            if (!accumulated && event.content) {
              accumulated = event.content
              controller.enqueue({
                type: 'text-delta',
                id: activeRunId,
                delta: event.content,
              })
            } else if (accumulated !== event.content) {
              closeWithError('演示 Runtime 返回的流式内容不完整')
              return
            }
            terminal = true
            controller.enqueue({ type: 'text-end', id: activeRunId })
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
            cleanup()
            return
          }

          terminal = true
          if (textStarted) {
            controller.enqueue({ type: 'text-end', id: activeRunId })
          }
          if (event.type === 'run_cancelled') {
            controller.enqueue({ type: 'abort', reason: '已取消' })
          } else {
            controller.enqueue({ type: 'error', errorText: event.message })
          }
          controller.close()
          cleanup()
        }

        try {
          unlisten = await listen(DEMO_RUNTIME_EVENT, ({ payload }) => {
            if (isDemoRuntimeEvent(payload)) handleEvent(payload)
          })
          options.abortSignal?.addEventListener('abort', onAbort, { once: true })
          returnedRunId = await invoke<string>('start_demo_conversation', {
            request: {
              sessionId: options.chatId,
              userMessageId: userMessage.id,
              prompt: userMessage.prompt,
              mode: useDemoRuntimeStore.getState().mode,
            },
            originWindow,
          })
          if (activeRunId && activeRunId !== returnedRunId) {
            closeWithError('演示 Runtime 运行标识不一致')
          }
          if (options.abortSignal?.aborted) cancelActiveRun()
        } catch (error) {
          closeWithError(error instanceof Error ? error.message : String(error))
        }
      },
      cancel: () => {
        cancelActiveRun()
        cleanup()
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }

  updateSystemMessage(systemMessage?: string) {
    void systemMessage
  }

  setOnTokenUsage(
    callback?: (usage: LanguageModelUsage, messageId: string) => void
  ) {
    void callback
  }

  refreshTools() {}

  setContinueFromContent(content: unknown) {
    void content
  }

  async updateRagToolsAvailability(
    hasDocuments: boolean,
    modelSupportsTools: boolean,
    ragFeatureAvailable: boolean
  ) {
    void hasDocuments
    void modelSupportsTools
    void ragFeatureAvailable
  }
}
