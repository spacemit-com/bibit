import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useReducer, type ReactNode } from 'react'

/**
 * Message rows for the conversation list.
 *
 * ``useSessionFeed.loadOlder`` merges each older page into the same feed, so the
 * rendered row count grows without bound while the user pages back through a
 * long session. Past ``VIRTUALIZE_MIN_ITEMS`` only the rows around the viewport
 * are mounted.
 *
 * Below the threshold the rows stay plain flex children: ordinary sessions hold
 * a few dozen rows, and jsdom has no layout at all, so virtualizing there would
 * only make route tests see an empty list.
 */
const VIRTUALIZE_MIN_ITEMS = 200
/** Row height spans one line to a whole reasoning card; this is only the seed. */
const ROW_ESTIMATE_PX = 180
const OVERSCAN_ROWS = 6

export type VirtualMessageListProps = {
  count: number
  /**
   * The scroll container that owns the rows. It is read through a getter and
   * only while virtualizing, so a caller whose scroller is absent (unit tests
   * render the conversation without one) never has to provide it.
   */
  getScrollElement: () => HTMLElement | null
  getKey: (index: number) => string
  renderRow: (index: number) => ReactNode
}

export const VirtualMessageList = ({
  count,
  getScrollElement,
  getKey,
  renderRow,
}: VirtualMessageListProps) => {
  const enabled = count >= VIRTUALIZE_MIN_ITEMS
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  const virtualizer = useVirtualizer({
    enabled,
    count,
    getScrollElement,
    estimateSize: () => ROW_ESTIMATE_PX,
    // The default reads `offsetHeight`; `getBoundingClientRect` is the same box
    // and stays measurable where layout is only simulated. Same as the model
    // list in `routes/hub`.
    measureElement: element => element.getBoundingClientRect().height,
    getItemKey: getKey,
    overscan: OVERSCAN_ROWS,
  })

  // The virtualizer reads the scroll element while rendering, but the element
  // is owned by the conversation and only attached once the surrounding commit
  // is done. Without this second pass a long conversation paints an empty
  // placeholder until something unrelated re-renders it.
  // `useLayoutEffect`：容器是祖先在它自己的 layout effect 里交付的，等 passive effect
  // 再补渲染就晚了一帧，首帧会按估算高度画出空白列表再跳一次。
  useLayoutEffect(() => {
    if (enabled) rerender()
  }, [enabled])

  if (!enabled) {
    return <>{Array.from({ length: count }, (_, index) => renderRow(index))}</>
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: virtualizer.getTotalSize(),
      }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          // Rows are absolutely positioned, so they carry the column gap
          // themselves: `pb-2` spaces the rows, `gap-y-2` the parts inside one.
          className="flex flex-col gap-y-2 pb-2"
          data-index={item.index}
          key={item.key}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${item.start}px)`,
          }}
        >
          {renderRow(item.index)}
        </div>
      ))}
    </div>
  )
}

VirtualMessageList.displayName = 'VirtualMessageList'
