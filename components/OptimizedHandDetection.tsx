'use client'

import { useEffect, useRef } from 'react'

interface MediaPipeHandler {
  cleanup(): void
  onHandControls(callback: (controls: any[]) => void): void
  start(video: HTMLVideoElement, canvas: HTMLCanvasElement, label: HTMLElement): Promise<void>
}

interface LiquidSimulation {
  dispose(): void
  setHandControls(controls: any[]): void
}

export default function OptimizedHandDetection() {
  const initialized = useRef(false)
  const mediaPipeRef = useRef<MediaPipeHandler | null>(null)
  const liquidSimRef = useRef<LiquidSimulation | null>(null)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const init = async () => {
      try {
        // Wait for MediaPipe scripts to load
        await waitForMediaPipe()

        // Initialize optimized particle simulation
        const liquidSimModule = await import('@/lib/optimized-particle-system')
        liquidSimRef.current = new liquidSimModule.OptimizedLiquidSimulation()
        ;(window as any).liquidSim = liquidSimRef.current

        // Initialize MediaPipe handler with optimized config
        const mediaPipeModule = await import('@/lib/mediapipe-handler')
        mediaPipeRef.current = new mediaPipeModule.MediaPipeHandler({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.7,
          targetFPS: 30 // Optimized frame rate
        })

        // Subscribe to hand control updates
        mediaPipeRef.current.onHandControls((controls) => {
          if (liquidSimRef.current) {
            liquidSimRef.current.setHandControls(controls)
          }
        })

        // Get DOM elements
        const videoElement = document.getElementById('input-video') as HTMLVideoElement
        const canvasElement = document.getElementById('output') as HTMLCanvasElement
        const gestureLabel = document.getElementById('gesture-label') as HTMLElement

        // Start detection
        await mediaPipeRef.current.start(videoElement, canvasElement, gestureLabel)

        console.log('✅ Hand detection initialized successfully')
      } catch (error) {
        console.error('❌ Initialization failed:', error)
        const gestureLabel = document.getElementById('gesture-label')
        if (gestureLabel) {
          gestureLabel.textContent = `Error: ${(error as Error).message}`
          gestureLabel.style.color = 'red'
        }
      }
    }

    init()

    // Cleanup on unmount
    return () => {
      if (mediaPipeRef.current) {
        mediaPipeRef.current.cleanup()
      }
      if (liquidSimRef.current) {
        liquidSimRef.current.dispose()
      }
    }
  }, [])

  return null // This component doesn't render anything visible
}

async function waitForMediaPipe(): Promise<void> {
  return new Promise((resolve) => {
    if ((window as any).Camera && (window as any).Hands) {
      resolve()
    } else {
      const checkInterval = setInterval(() => {
        if ((window as any).Camera && (window as any).Hands) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 50)
    }
  })
}
