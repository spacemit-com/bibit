/* eslint-disable @typescript-eslint/no-explicit-any */
import { useRef } from 'react'
import {
  motion,
  useAnimationFrame,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
} from 'motion/react'

export const MovingBorder = ({
  children,
  duration = 3000,
  rx,
  ry,
  active = true,
}: {
  children: React.ReactNode
  duration?: number
  rx?: string
  ry?: string
  active?: boolean
  [key: string]: any
}) => {
  const pathRef = useRef<SVGRectElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const reduceMotion = useReducedMotion()

  useAnimationFrame((time) => {
    // 空闲或用户要求减少动态时不做几何计算；组件保持挂载，避免显隐时重新挂载动画。
    if (!active || reduceMotion) return
    const path = pathRef.current
    // WebKit 无法计算 display:none 下百分比 SVG 的路径几何。
    if (!path?.getClientRects().length) return
    try {
      const length = path.getTotalLength()
      if (!length || duration <= 0) return
      const point = path.getPointAtLength((time * length / duration) % length)
      x.set(point.x)
      y.set(point.y)
    } catch (error) {
      // 显隐切换时路径可能暂时没有有效几何，下一帧重试。
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error
    }
  })

  const transform = useMotionTemplate`translateX(${x}px) translateY(${y}px) translateX(-50%) translateY(-50%)`

  return (
    <>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
        className="absolute h-full w-full"
        width="100%"
        height="100%"
      >
        <rect
          fill="none"
          width="100%"
          height="100%"
          rx={rx}
          ry={ry}
          ref={pathRef}
        />
      </svg>
      <motion.div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'inline-block',
          transform,
        }}
      >
        {children}
      </motion.div>
    </>
  )
}
