import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEffect, useMemo, useRef, useState } from 'react'

const DRAG_THRESHOLD = 4

// 单击与双击共用同一串指针事件：第一次点击不能立刻弹浮窗，否则双击会先弹出浮窗、
// 再被 open_main_window 内部隐藏，看起来闪一下。等待窗口取系统双击时长的下限。
const DOUBLE_TAP_MS = 250

// 悬浮球活在一个整屏透明 webview 里（见 src-tauri/src/voice_overlay.rs）：SpacemiT K3 实测
// WebKit 在这个平台上合成一帧要 ~16ms（整屏 buffer 每帧分配/释放，PowerVR 的 defer-free
// 线程还要为释放页清零），所以任何常驻 60fps 动画都等于常态烧掉约半个到一整个核——
// 主线程被占满，主窗口的流式正文就只能一格一格往外跳。
// 因此球的动效一律改成「事件驱动的有限帧」：节拍之间完全不出帧，一拍只出十几帧。
const IDLE_BEAT_MS = 12_000
const LOOK_EVERY_BEATS = 3
const THINKING_STEP_MS = 250
const THINKING_STEPS = 8

// 视线目标循环。空串 = 居中（base 规则没有 transform）。
const LOOK_CYCLE = ['', 'is-look-top-left', 'is-look-right'] as const

// 点阵眼睛按层级分组（每只眼共 24 点，Y 轴以 y=119.5 为中心上下对称）
const EYE_TIERS = {
  // 第 3 行：中心基准线（闭眼时保留成 4 点细缝线）
  center: [
    [80.5, 119.5],
    [89.5, 119.5],
    [98.5, 119.5],
    [107.5, 119.5],
  ],
  // 第 2 行 (y=110.5) 和第 4 行 (y=128.5)：内层
  inner: [
    [80.5, 110.5],
    [89.5, 110.5],
    [98.5, 110.5],
    [107.5, 110.5],
    [80.5, 128.5],
    [89.5, 128.5],
    [98.5, 128.5],
    [107.5, 128.5],
  ],
  // 第 1 行 (y=101.5) 和第 5 行 (y=137.5)：次外层
  mid: [
    [80.5, 101.5],
    [89.5, 101.5],
    [98.5, 101.5],
    [107.5, 101.5],
    [80.5, 137.5],
    [89.5, 137.5],
    [98.5, 137.5],
    [107.5, 137.5],
  ],
  // 第 0 行 (y=92.5) 和第 6 行 (y=146.5)：最外层
  outer: [
    [89.5, 92.5],
    [98.5, 92.5],
    [89.5, 146.5],
    [98.5, 146.5],
  ],
} as const

function renderEyeDots(offsetX = 0, side: 'left' | 'right') {
  return (
    <>
      <g className="voice-ball-tier-center">
        {EYE_TIERS.center.map(([x, y], i) => (
          <ellipse key={`${side}-c-${i}`} cx={x + offsetX} cy={y} rx="3.49" ry="3.5" fill="#7BFF47" />
        ))}
      </g>
      <g className="voice-ball-tier-inner">
        {EYE_TIERS.inner.map(([x, y], i) => (
          <ellipse key={`${side}-i-${i}`} cx={x + offsetX} cy={y} rx="3.49" ry="3.5" fill="#7BFF47" />
        ))}
      </g>
      <g className="voice-ball-tier-mid">
        {EYE_TIERS.mid.map(([x, y], i) => (
          <ellipse key={`${side}-m-${i}`} cx={x + offsetX} cy={y} rx="3.49" ry="3.5" fill="#7BFF47" />
        ))}
      </g>
      <g className="voice-ball-tier-outer">
        {EYE_TIERS.outer.map(([x, y], i) => (
          <ellipse key={`${side}-o-${i}`} cx={x + offsetX} cy={y} rx="3.49" ry="3.5" fill="#7BFF47" />
        ))}
      </g>
    </>
  )
}

// 语音输入音波：4 列点阵柱（每列 3 点宽，Y 轴以 y=128 中心线对称展开）
const WAVE_BARS = [
  { id: 'b1', x: [51.5, 60.5, 69.5], maxTier: 3 }, // 第 1 柱：5~7 行 (max tier 3)
  { id: 'b2', x: [96.5, 105.5, 114.5], maxTier: 5 }, // 第 2 柱：最高峰 11 行 (max tier 5)
  { id: 'b3', x: [141.5, 150.5, 159.5], maxTier: 2 }, // 第 3 柱：矮柱 3~5 行 (max tier 2)
  { id: 'b4', x: [186.5, 195.5, 204.5], maxTier: 4 }, // 第 4 柱：次高峰 7~9 行 (max tier 4)
] as const

const WAVE_TIER_Y: readonly (readonly number[])[] = [
  [128], // Tier 0: 中心行（1点高，必亮）
  [119, 137], // Tier 1: 上下各 1 行（3点高）
  [110, 146], // Tier 2: 上下各 2 行（5点高）
  [101, 155], // Tier 3: 上下各 3 行（7点高）
  [92, 164], // Tier 4: 上下各 4 行（9点高）
  [83, 173], // Tier 5: 上下各 5 行（11点高）
]

// 借鉴 LiveKit 的人声包络公式（自然元音辅音起伏 + 说话短暂停顿断句）
// 静音或断句停顿期间：全为 0（即 4 根柱子均保持仅 1 行基准小圆点）
function getSimulatedLevels(time: number): [number, number, number, number] {
  const pauseGate = Math.sin(time * 0.9)
  if (pauseGate < -0.25) {
    // 停顿断句 / 静音无声：全部回落到 0，每一条都只有 1 行圆点
    return [0, 0, 0, 0]
  }

  const envelope = (pauseGate + 0.25) / 1.25
  const pulse = Math.abs(Math.sin(time * 3.2))
  const energy = envelope * (0.2 + 0.8 * pulse)

  const f1 = Math.sin(time * 4.1) * 0.5 + 0.5
  const f2 = Math.sin(time * 5.0 + 1.0) * 0.5 + 0.5
  const f3 = Math.cos(time * 3.7 + 2.0) * 0.5 + 0.5
  const f4 = Math.sin(time * 4.6 + 0.5) * 0.5 + 0.5

  return [
    Math.min(3, Math.max(0, Math.round(f1 * 3.4 * energy))),
    Math.min(5, Math.max(0, Math.round(f2 * 5.4 * energy))),
    Math.min(2, Math.max(0, Math.round(f3 * 2.4 * energy))),
    Math.min(4, Math.max(0, Math.round(f4 * 4.4 * energy))),
  ]
}

function renderWaveBar(bar: (typeof WAVE_BARS)[number], activeTier: number) {
  const tiers: React.ReactNode[] = []
  for (let t = 0; t <= bar.maxTier; t++) {
    const isLit = t <= activeTier
    const yArr = WAVE_TIER_Y[t]
    tiers.push(
      <g
        key={`tier-${t}`}
        className={`voice-ball-wave-tier voice-ball-wave-tier-${t}`}
        style={{ opacity: isLit ? 1 : 0 }}
      >
        {yArr.flatMap((y) =>
          bar.x.map((x) => (
            <ellipse key={`dot-${bar.id}-${t}-${x}-${y}`} cx={x} cy={y} rx="3.49" ry="3.5" fill="#7BFF47" />
          ))
        )}
      </g>
    )
  }
  return (
    <g key={bar.id} className={`voice-ball-wave-bar ${bar.id}`}>
      {tiers}
    </g>
  )
}

const showVoiceOverlay = () => {
  void invoke('show_voice_overlay').catch((error) => {
    console.error('无法打开语音输入弹窗', error)
  })
}

const openMainWindow = () => {
  void invoke('open_main_window').catch((error) => {
    console.error('无法打开主窗口', error)
  })
}

export type VoiceBallMode = 'idle' | 'listening' | 'thinking'

export interface VoiceBallProps {
  mode?: VoiceBallMode
  isThinking?: boolean
  isListening?: boolean
  levels?: [number, number, number, number]
  embedded?: boolean
  onActivate?: () => void
  label?: string
}

export function VoiceBall({
  mode: modeProp,
  isThinking: isThinkingProp = false,
  isListening: isListeningProp = false,
  levels: levelsProp,
  embedded = false,
  onActivate,
  label,
}: VoiceBallProps = {}) {
  const { t } = useTranslation()
  const ballLabel = label ?? t('chat:openVoiceInput')
  const appWindow = useMemo(() => {
    try {
      return getCurrentWebviewWindow()
    } catch {
      return null
    }
  }, [])

  // 全屏透明窗口方案：球在窗口内用 CSS transform 定位，窗口本身不动。
  // 拖动收尾统一走 finishDrag()：实测 WebKit 松手时投递的是 pointercancel 而非 pointerup，
  // 位移必须存在 ref 里，取消路径才拿得到整段拖动距离。
  const pressPoint = useRef<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const dragDelta = useRef({ x: 0, y: 0 })
  const pendingSingleTap = useRef<number | null>(null)
  const lastTapAt = useRef(0)
  const [ballTransform, setBallTransform] = useState({ x: 0, y: 0 })
  // 落点是后端持久化的 margin；默认值与 Rust 侧 VoiceBallPreference::default 一致。
  const ballMarginsRef = useRef({ right: 16, bottom: 16 })
  const [ballMargins, setBallMargins] = useState(ballMarginsRef.current)
  const [surfaceVisible, setSurfaceVisible] = useState(true)
  const applyMargins = (right: number, bottom: number) => {
    ballMarginsRef.current = { right, bottom }
    setBallMargins({ right, bottom })
  }
  const [isThinking, setIsThinking] = useState(isThinkingProp)
  const [isListening, setIsListening] = useState(isListeningProp)
  const [simLevels, setSimLevels] = useState<[number, number, number, number]>([0, 0, 0, 0])
  // 待机节拍：只用来触发有限动画，值本身没有视觉含义。
  const [blinkNonce, setBlinkNonce] = useState(1)
  const [lookClass, setLookClass] = useState<string>('')
  const [ringStep, setRingStep] = useState(0)

  useEffect(() => {
    setIsThinking(isThinkingProp)
  }, [isThinkingProp])

  useEffect(() => {
    setIsListening(isListeningProp)
  }, [isListeningProp])

  const effectiveMode: VoiceBallMode = useMemo(() => {
    if (modeProp) return modeProp
    if (isListening) return 'listening'
    if (isThinking) return 'thinking'
    return 'idle'
  }, [modeProp, isListening, isThinking])

  // 仅在录音态未传入外部音频电平时开启轻量拟真模拟（~18fps，空闲待机时 0 CPU）
  useEffect(() => {
    if (effectiveMode !== 'listening' || levelsProp) return

    let time = 0
    const interval = setInterval(() => {
      time += 0.12
      setSimLevels(getSimulatedLevels(time))
    }, 55)

    return () => clearInterval(interval)
  }, [effectiveMode, levelsProp])

  const currentLevels = levelsProp ?? simLevels

  // 待机：每拍眨一次眼，每 LOOK_EVERY_BEATS 拍挪一次视线。拍与拍之间不出帧。
  useEffect(() => {
    if (effectiveMode !== 'idle') return

    let beat = 0
    const timer = setInterval(() => {
      beat += 1
      if (beat % LOOK_EVERY_BEATS === 0) {
        setLookClass(LOOK_CYCLE[(beat / LOOK_EVERY_BEATS) % LOOK_CYCLE.length])
      }
      setBlinkNonce((value) => value + 1)
    }, IDLE_BEAT_MS)

    return () => clearInterval(timer)
  }, [effectiveMode])

  // 思考：描边离散步进旋转。不用 CSS infinite——那会以 60fps 一直推着合成器出帧。
  useEffect(() => {
    if (effectiveMode !== 'thinking') return

    setRingStep(0)
    const timer = setInterval(() => {
      setRingStep((step) => (step + 1) % THINKING_STEPS)
    }, THINKING_STEP_MS)

    return () => clearInterval(timer)
  }, [effectiveMode])

  useEffect(() => {
    let unlistenThinking: (() => void) | undefined
    let unlistenListening: (() => void) | undefined

    if (typeof appWindow?.listen === 'function') {
      void appWindow
        .listen<{ thinking: boolean }>('voice-ball:set-thinking', (event) => {
          if (typeof event.payload?.thinking === 'boolean') {
            setIsThinking(event.payload.thinking)
          }
        })
        .then((fn) => {
          unlistenThinking = fn
        })
        .catch(() => {})

      void appWindow
        .listen<{ listening: boolean }>('voice-ball:set-listening', (event) => {
          if (typeof event.payload?.listening === 'boolean') {
            setIsListening(event.payload.listening)
          }
        })
        .then((fn) => {
          unlistenListening = fn
        })
        .catch(() => {})
    }

    const handleCustomThinking = (e: Event) => {
      const custom = e as CustomEvent<{ thinking?: boolean }>
      if (typeof custom.detail?.thinking === 'boolean') {
        setIsThinking(custom.detail.thinking)
      }
    }
    const handleCustomListening = (e: Event) => {
      const custom = e as CustomEvent<{ listening?: boolean }>
      if (typeof custom.detail?.listening === 'boolean') {
        setIsListening(custom.detail.listening)
      }
    }
    window.addEventListener('voice-ball-thinking', handleCustomThinking)
    window.addEventListener('voice-ball-listening', handleCustomListening)

    return () => {
      unlistenThinking?.()
      unlistenListening?.()
      window.removeEventListener('voice-ball-thinking', handleCustomThinking)
      window.removeEventListener('voice-ball-listening', handleCustomListening)
    }
  }, [appWindow])

  useEffect(() => {
    if (embedded) return
    // 后端会在浮窗被拖走后把球挪到新位置（球跟浮窗走），球窗口是常驻的、挂载时只读一次，
    // 所以要听后端推过来的落点。
    let unlistenMargins: (() => void) | undefined
    void invoke<[number, number]>('get_voice_ball_position')
      .then(([right, bottom]) => applyMargins(right, bottom))
      .catch((error: unknown) => console.error('无法读取悬浮球位置', error))
    if (typeof appWindow?.listen === 'function') {
      void appWindow
        .listen<{ rightMargin?: number; bottomMargin?: number }>(
          'voice-ball:set-margins',
          (event) => {
            const { rightMargin, bottomMargin } = event.payload ?? {}
            if (typeof rightMargin === 'number' && typeof bottomMargin === 'number') {
              applyMargins(rightMargin, bottomMargin)
            }
          }
        )
        .then((fn) => {
          unlistenMargins = fn
        })
        .catch(() => {})
    }
    return () => unlistenMargins?.()
  }, [appWindow, embedded])

  useEffect(() => {
    if (embedded || typeof appWindow?.listen !== 'function') return
    let disposed = false
    const unlisteners: Array<() => void> = []
    const frames = new Set<number>()
    const hidden = () => {
      setSurfaceVisible(false)
      frames.add(requestAnimationFrame(() => {
        frames.add(requestAnimationFrame(() => {
          frames.clear()
          if (!disposed) void invoke('voice_ball_blanked').catch(console.error)
        }))
      }))
    }
    const shown = ({ payload }: { payload: { rightMargin: number; bottomMargin: number } }) => {
      if (typeof payload?.rightMargin !== 'number' || typeof payload?.bottomMargin !== 'number') return
      applyMargins(payload.rightMargin, payload.bottomMargin)
      setSurfaceVisible(true)
    }
    void appWindow.listen('voice-ball-hidden', hidden)
      .then(fn => disposed ? fn() : unlisteners.push(fn))
      .catch(console.error)
    void appWindow.listen<{ rightMargin: number; bottomMargin: number }>('voice-ball-shown', shown)
      .then(fn => disposed ? fn() : unlisteners.push(fn))
      .catch(console.error)
    return () => {
      disposed = true
      unlisteners.forEach(fn => fn())
      frames.forEach(cancelAnimationFrame)
    }
  }, [appWindow, embedded])

  const activate = onActivate ?? showVoiceOverlay

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    pressPoint.current = { x: event.clientX, y: event.clientY }
    dragging.current = false
    dragDelta.current = { x: 0, y: 0 }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (embedded) return
    const origin = pressPoint.current
    if (!origin) return
    const dx = event.clientX - origin.x
    const dy = event.clientY - origin.y
    if (!dragging.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragging.current = true
    // 本地更新 CSS transform，零 IPC 往返
    dragDelta.current = { x: dx, y: dy }
    setBallTransform(dragDelta.current)
  }

  // 拖动收尾：pointerup 与 pointercancel 共用。
  // 取消不再丢弃位移——否则球会弹回原处且位置不落盘（SpacemiT K3 实测复现）。
  const finishDrag = () => {
    const delta = dragDelta.current
    const wasDragging = dragging.current
    dragDelta.current = { x: 0, y: 0 }
    pressPoint.current = null
    dragging.current = false
    setBallTransform({ x: 0, y: 0 })
    if (!wasDragging) return
    // 拖动结束：把累计位移折算回 margin。先就地落位（margin 生效与 transform 归零在同一批渲染里，球不跳），
    // 再异步落盘：落盘失败只是下次启动回到旧位置，不会当场回弹。
    const base = ballMarginsRef.current
    const nextRight = Math.max(0, Math.round(base.right - delta.x))
    const nextBottom = Math.max(0, Math.round(base.bottom - delta.y))
    applyMargins(nextRight, nextBottom)
    void invoke('update_voice_ball_position', { rightMargin: nextRight, bottomMargin: nextBottom })
      .catch((error: unknown) => console.error('无法保存悬浮球位置', error))
  }

  const cancelPendingSingleTap = () => {
    if (pendingSingleTap.current === null) return
    window.clearTimeout(pendingSingleTap.current)
    pendingSingleTap.current = null
  }

  // 卸载（窗口销毁/热重载）时别把延迟的单击动作留成孤儿定时器。
  useEffect(
    () => () => {
      if (pendingSingleTap.current !== null) {
        window.clearTimeout(pendingSingleTap.current)
        pendingSingleTap.current = null
      }
    },
    []
  )

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const wasDragging = dragging.current
    finishDrag()
    if (wasDragging) {
      // 拖动过就不算点击，也不要把拖动前那次点击的时间戳留给下一击。
      cancelPendingSingleTap()
      lastTapAt.current = 0
      return
    }
    if (embedded) {
      activate()
      return
    }
    const now = Date.now()
    if (now - lastTapAt.current <= DOUBLE_TAP_MS) {
      cancelPendingSingleTap()
      lastTapAt.current = 0
      openMainWindow()
      return
    }
    cancelPendingSingleTap()
    lastTapAt.current = now
    pendingSingleTap.current = window.setTimeout(() => {
      pendingSingleTap.current = null
      lastTapAt.current = 0
      activate()
    }, DOUBLE_TAP_MS)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    cancelPendingSingleTap()
    lastTapAt.current = 0
    activate()
  }

  return (
    <button
      type="button"
      style={embedded ? { width: '100%', height: '100%', cursor: 'pointer' } : undefined}
      aria-label={ballLabel}
      title={ballLabel}
      data-thinking={effectiveMode === 'thinking' ? 'true' : 'false'}
      data-listening={effectiveMode === 'listening' ? 'true' : 'false'}
      data-mode={effectiveMode}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={finishDrag}
      onKeyDown={handleKeyDown}
      // 焦点环只画在球本体上（见下面 frame 的 group-focus-visible）：
      // 独立球窗的触发器是不可见的整屏盒子，把环画在它身上就会出现在屏幕左上角。
      // 内嵌（浮窗 composer）时触发器本身就是可见控件，而且它的圆角裁剪会把球的环裁掉，
      // 所以那种情况环仍留在触发器上。
      className={`voice-ball-trigger group ${embedded ? 'h-full w-full focus-visible:ring-2 focus-visible:ring-[#7bff47]' : ''} touch-none select-none border-0 p-0 focus-visible:outline-none`}
    >
      <div
        className={`voice-ball-frame ${embedded ? '' : 'rounded-full group-focus-visible:ring-2 group-focus-visible:ring-[#7bff47]'}`}
        // 独立球窗口：窗口本身不动，球用绝对定位 + margin 定位。
        // 内嵌（浮窗 composer）：按槽位铺满，写死 96px 会溢出到输入框和发送按钮上。
        style={
          embedded
            ? { width: '100%', height: '100%' }
            : {
                position: 'absolute',
                width: '96px',
                height: '96px',
                right: `${ballMargins.right}px`,
                bottom: `${ballMargins.bottom}px`,
                transform: `translate(${ballTransform.x}px, ${ballTransform.y}px)`,
                willChange: 'transform',
                ...(!surfaceVisible ? { display: 'none' } : {}),
              }
        }
      >
        {/* 黑盘由 .voice-ball-frame 的伪元素绘制（见 index.css）：不单独提升合成层，
            球心那块浮窗白底就是被带 will-change 的黑盘层漏绘出来的。 */}
        <svg
          viewBox="0 0 256 256"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="voice-ball-svg h-full w-full pointer-events-none select-none"
        >
        <defs>
          <linearGradient
            id="voice-ball-gradient"
            x1="286"
            y1="321"
            x2="-10.0392"
            y2="55.7177"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#7BFF47" />
            <stop offset="1" stopColor="white" />
          </linearGradient>
        </defs>

        {/* 绿白渐变描边：思考态显示并旋转 */}
        <g
          className={`voice-ball-ring ${effectiveMode === 'thinking' ? 'is-thinking' : ''}`}
          data-testid="voice-ball-ring"
          style={
            effectiveMode === 'thinking'
              ? { transform: `rotate(${(ringStep * 360) / THINKING_STEPS}deg)` }
              : undefined
          }
        >
          <circle
            cx="128"
            cy="128"
            r="120"
            stroke="url(#voice-ball-gradient)"
            strokeWidth="16"
            fill="none"
          />
        </g>

        {/* 待机态：动效点阵眼睛（与录音音波态严格互斥） */}
        {effectiveMode === 'idle' && (
          <g
            className={`voice-ball-eyes ${lookClass}`}
            data-testid="voice-ball-eyes"
          >
            {/* key 变化 = 点阵层重新挂载 = 眨眼动画重放一次；不做常驻动画。 */}
            <g key={blinkNonce}>
              <g className="voice-ball-eye-left">{renderEyeDots(0, 'left')}</g>
              <g className="voice-ball-eye-right">{renderEyeDots(67, 'right')}</g>
            </g>
          </g>
        )}

        {/* 语音输入录音态：4 列点阵跳动音波（高度由数据驱动，绝无断层） */}
        {effectiveMode === 'listening' && (
          <g className="voice-ball-waves is-active" data-testid="voice-ball-waves">
            {WAVE_BARS.map((bar, i) => renderWaveBar(bar, currentLevels[i]))}
          </g>
        )}
      </svg>
      </div>
    </button>
  )
}
