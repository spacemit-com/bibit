/**
 * A reference to something the host knows how to resolve. Features pass these
 * instead of host routes, ids or paths, so a Feature never has to understand
 * another Feature's internals to hand it a piece of context.
 */
export interface FeatureResourceRefV1 {
  namespace: string
  type: string
  id: string
}

export type FeatureHostActionErrorCodeV1 =
  | 'NOT_GRANTED'
  | 'UNSUPPORTED'
  | 'INVALID_INPUT'
  | 'FAILED'

export interface FeatureHostActionErrorV1 {
  code: FeatureHostActionErrorCodeV1
  message: string
  retryable?: boolean
}

/**
 * Every host action answers with the same three outcomes, so a Feature can tell
 * a user cancellation from a refusal or a host failure instead of guessing from
 * a rejection reason alone.
 */
export type FeatureHostActionResultV1 =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'rejected'; error: FeatureHostActionErrorV1 }

/**
 * Actions a Feature may ask the host to perform outside its own surface.
 * Adding one means adding an entry here and a host implementation; the host
 * rejects any action it does not know, so a Feature cannot reach for something
 * that was never agreed on.
 */
export interface FeatureHostActionRegistryV1 {
  /**
   * Open a new conversation, optionally bound to a target such as an expert.
   * Creating a new conversation is the whole point of the action, so the host
   * is never free to interpret this as reusing an existing one.
   */
  'conversation.create': {
    input: {
      target?: FeatureResourceRefV1
    }
  }
  /**
   * Open a new conversation with content already staged for the user: an
   * optional expert, optional temporary skills, and optional draft text.
   *
   * Two things this action guarantees, so a Feature never has to guess:
   * it always creates a new conversation, and it never sends anything. The
   * staged draft waits in the input box until the user edits and sends it.
   */
  'conversation.compose': {
    input: {
      target?: FeatureResourceRefV1
      skills?: FeatureResourceRefV1[]
      prompt?: string
    }
  }
}
