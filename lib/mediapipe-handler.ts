/**
 * Optimized MediaPipe integration with lifecycle management
 * Features:
 * - Proper resource cleanup
 * - Throttled processing
 * - Memory-efficient hand tracking
 * - Error recovery
 */

interface Vector3Like {
  x: number
  y: number
  z: number
}

interface HandControl {
  /**
   * Approximate palm center in simulation coordinates
   */
  palm: Vector3Like
  /**
   * Fingertip positions for this hand in simulation coordinates.
   * Ordered as: [thumb, index, middle, ring, pinky]
   */
  fingers: Vector3Like[]
  /**
   * Index of this hand in the current frame (0 or 1)
   */
  handIndex: number
}

interface MediaPipeResults {
  image: HTMLCanvasElement | HTMLVideoElement
  multiHandLandmarks: any[][]
  multiHandedness: Array<{ index: number }>
}

interface HandDetectionConfig {
  maxNumHands?: number
  modelComplexity?: 0 | 1
  minDetectionConfidence?: number
  minTrackingConfidence?: number
  targetFPS?: number
}

export class MediaPipeHandler {
  private hands: any = null
  private camera: any = null
  private videoElement: HTMLVideoElement | null = null
  private canvasElement: HTMLCanvasElement | null = null
  private canvasCtx: CanvasRenderingContext2D | null = null
  private gestureLabel: HTMLElement | null = null
  
  private lastFrameTime = 0
  private frameThrottle: number = 1000 / 30 // 30 FPS default
  private isProcessing = false
  private config: Required<HandDetectionConfig>
  private handControlsCallback?: (controls: HandControl[]) => void
  private duplicateVideoCleanupInterval: number | null = null

  constructor(config: HandDetectionConfig = {}) {
    this.config = {
      maxNumHands: config.maxNumHands ?? 2,
      modelComplexity: config.modelComplexity ?? 1,
      minDetectionConfidence: config.minDetectionConfidence ?? 0.7,
      minTrackingConfidence: config.minTrackingConfidence ?? 0.7,
      targetFPS: config.targetFPS ?? 30
    }
    this.frameThrottle = 1000 / this.config.targetFPS
  }

  /**
   * Initialize MediaPipe Hands with optimized settings
   */
  private async initializeMediaPipe(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const Hands = (window as any).Hands
        if (!Hands) {
          reject(new Error('MediaPipe Hands not loaded'))
          return
        }

        this.hands = new Hands({
          locateFile: (file: string) => 
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        })

        this.hands.setOptions({
          maxNumHands: this.config.maxNumHands,
          modelComplexity: this.config.modelComplexity,
          minDetectionConfidence: this.config.minDetectionConfidence,
          minTrackingConfidence: this.config.minTrackingConfidence
        })

        this.hands.onResults((results: MediaPipeResults) => {
          if (!this.isProcessing) {
            this.processResults(results)
          }
        })

        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Process hand detection results with throttling
   */
  private processResults(results: MediaPipeResults): void {
    const now = performance.now()
    if (now - this.lastFrameTime < this.frameThrottle) {
      return
    }
    this.lastFrameTime = now

    this.isProcessing = true

    try {
      // Clear and draw base image
      if (this.canvasCtx && this.canvasElement) {
        this.canvasCtx.save()
        this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height)
        this.canvasCtx.drawImage(
          results.image,
          0,
          0,
          this.canvasElement.width,
          this.canvasElement.height
        )
      }

      const handControls: HandControl[] = []

      // Process detected hands
      if (results.multiHandLandmarks?.length > 0) {
        for (let index = 0; index < results.multiHandLandmarks.length; index++) {
          const handLandmarks = results.multiHandLandmarks[index]
          
          // Calculate palm center (optimized landmarks)
          const keyPoints = [0, 5, 9, 13, 17]
          const palmX = keyPoints.reduce((sum, idx) => sum + handLandmarks[idx].x, 0) / keyPoints.length
          const palmY = keyPoints.reduce((sum, idx) => sum + handLandmarks[idx].y, 0) / keyPoints.length
          const palmZ = keyPoints.reduce((sum, idx) => sum + handLandmarks[idx].z, 0) / keyPoints.length
          
          // Fingertips: thumb, index, middle, ring, pinky
          const fingertipIndices = [4, 8, 12, 16, 20]
          const fingers: Vector3Like[] = fingertipIndices
            .map((tipIndex) => handLandmarks[tipIndex])
            .filter((landmark) => Boolean(landmark))
            .map((landmark) => ({
              x: (landmark.x - 0.5) * 50,
              y: (landmark.y - 0.5) * 50,
              z: landmark.z * 50
            }))

          handControls.push({
            palm: {
              x: (palmX - 0.5) * 50,
              y: (palmY - 0.5) * 50,
              z: palmZ * 50
            },
            fingers,
            handIndex: index
          })

          // Draw landmarks (optimized rendering)
          this.drawHandLandmarks(handLandmarks, index)
        }

        // Update UI
        if (this.gestureLabel) {
          this.gestureLabel.textContent = `${results.multiHandLandmarks.length} hand(s) detected`
          this.gestureLabel.style.color = 'lime'
        }
      } else {
        if (this.gestureLabel) {
          this.gestureLabel.textContent = 'No hands detected'
          this.gestureLabel.style.color = 'yellow'
        }
      }

      // Notify listeners
      if (this.handControlsCallback) {
        this.handControlsCallback(handControls)
      }
    } finally {
      if (this.canvasCtx) {
        this.canvasCtx.restore()
      }
      this.isProcessing = false
    }
  }

  /**
   * Optimized hand landmark rendering
   */
  private drawHandLandmarks(handLandmarks: any[], index: number): void {
    if (!this.canvasCtx || !this.canvasElement) return

    const color = index === 0 ? '#FF0000' : '#00FF00'
    this.canvasCtx.fillStyle = color
    this.canvasCtx.strokeStyle = color
    this.canvasCtx.lineWidth = 2

    // Draw key points only (optimization)
    const keyIndices = [0, 4, 8, 12, 16, 20, 5, 9, 13, 17]
    for (const idx of keyIndices) {
      const landmark = handLandmarks[idx]
      if (landmark) {
        const x = landmark.x * this.canvasElement.width
        const y = landmark.y * this.canvasElement.height
        this.canvasCtx.beginPath()
        this.canvasCtx.arc(x, y, 3, 0, 2 * Math.PI)
        this.canvasCtx.fill()
      }
    }

    // Draw connections if available
    const connections = (window as any).HAND_CONNECTIONS
    if (connections) {
      for (const [startIdx, endIdx] of connections) {
        const start = handLandmarks[startIdx]
        const end = handLandmarks[endIdx]
        if (start && end) {
          this.canvasCtx.beginPath()
          this.canvasCtx.moveTo(
            start.x * this.canvasElement.width,
            start.y * this.canvasElement.height
          )
          this.canvasCtx.lineTo(
            end.x * this.canvasElement.width,
            end.y * this.canvasElement.height
          )
          this.canvasCtx.stroke()
        }
      }
    }
  }

  /**
   * Clean up any duplicate video elements (especially on mobile)
   */
  private cleanupDuplicateVideos(): void {
    if (!this.videoElement) return
    
    const allVideos = document.querySelectorAll('video')
    allVideos.forEach((video) => {
      // Keep only our main video element, hide/remove any others
      if (video.id !== 'input-video' && video !== this.videoElement) {
        // Hide and remove duplicate videos
        video.style.display = 'none'
        video.style.visibility = 'hidden'
        video.style.opacity = '0'
        video.style.position = 'absolute'
        video.style.pointerEvents = 'none'
        video.style.zIndex = '-1'
        
        // Try to remove if it's not in use
        try {
          const videoParent = video.parentElement
          const mainVideoParent = this.videoElement?.parentElement
          if (videoParent && mainVideoParent && videoParent !== mainVideoParent) {
            video.remove()
          }
        } catch (e) {
          // Ignore errors when removing
        }
      }
    })
  }

  /**
   * Start hand detection
   */
  async start(
    videoElement: HTMLVideoElement,
    canvasElement: HTMLCanvasElement,
    gestureLabel: HTMLElement
  ): Promise<void> {
    this.videoElement = videoElement
    this.canvasElement = canvasElement
    this.canvasCtx = canvasElement.getContext('2d')
    this.gestureLabel = gestureLabel

    try {
      // Initialize MediaPipe
      await this.initializeMediaPipe()

      // Start video stream
      this.videoElement.muted = true
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      })

      this.videoElement.srcObject = stream
      await this.videoElement.play()

      // Set canvas dimensions
      this.canvasElement.width = this.videoElement.videoWidth
      this.canvasElement.height = this.videoElement.videoHeight

      // Start camera processing
      const Camera = (window as any).Camera
      
      // Prevent MediaPipe from creating duplicate video elements
      // Use the existing video element directly
      this.camera = new Camera(this.videoElement, {
        onFrame: async () => {
          if (this.hands && !this.isProcessing && this.videoElement) {
            await this.hands.send({ image: this.videoElement })
          }
        },
        width: this.videoElement.videoWidth,
        height: this.videoElement.videoHeight
      })

      await this.camera.start()
      
      // Clean up duplicate videos immediately and periodically
      this.cleanupDuplicateVideos()
      setTimeout(() => this.cleanupDuplicateVideos(), 100)
      setTimeout(() => this.cleanupDuplicateVideos(), 500)
      
      // Set up periodic cleanup (especially important on mobile)
      this.duplicateVideoCleanupInterval = window.setInterval(() => {
        this.cleanupDuplicateVideos()
      }, 2000) // Check every 2 seconds
    } catch (error) {
      console.error('MediaPipe initialization failed:', error)
      if (this.gestureLabel) {
        this.gestureLabel.textContent = `Error: ${(error as Error).message}`
        this.gestureLabel.style.color = 'red'
      }
      throw error
    }
  }

  /**
   * Subscribe to hand control updates
   */
  onHandControls(callback: (controls: HandControl[]) => void): void {
    this.handControlsCallback = callback
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HandDetectionConfig>): void {
    Object.assign(this.config, config)
    this.frameThrottle = 1000 / this.config.targetFPS
    
    if (this.hands) {
      this.hands.setOptions({
        maxNumHands: this.config.maxNumHands,
        modelComplexity: this.config.modelComplexity,
        minDetectionConfidence: this.config.minDetectionConfidence,
        minTrackingConfidence: this.config.minTrackingConfidence
      })
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Clear duplicate video cleanup interval
    if (this.duplicateVideoCleanupInterval !== null) {
      clearInterval(this.duplicateVideoCleanupInterval)
      this.duplicateVideoCleanupInterval = null
    }
    
    if (this.camera) {
      try {
        this.camera.stop()
      } catch (e) {
        console.warn('Error stopping camera:', e)
      }
    }
    
    if (this.hands) {
      try {
        this.hands.close()
      } catch (e) {
        console.warn('Error closing hands:', e)
      }
    }

    if (this.videoElement?.srcObject) {
      const stream = this.videoElement.srcObject as MediaStream
      stream.getTracks().forEach(track => track.stop())
    }

    // Final cleanup of duplicate videos
    this.cleanupDuplicateVideos()

    this.hands = null
    this.camera = null
    this.videoElement = null
    this.canvasElement = null
    this.canvasCtx = null
    this.gestureLabel = null
    this.handControlsCallback = undefined
  }
}

export type { HandControl }
