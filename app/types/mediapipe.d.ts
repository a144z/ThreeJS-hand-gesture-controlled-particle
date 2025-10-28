// Type definitions for MediaPipe global objects

declare global {
  interface Window {
    Camera: any
    Hands: any
    HAND_CONNECTIONS: any
    drawingUtils: any
    liquidSim: LiquidSimulation | undefined
  }
}

export interface LiquidSimulation {
  setHandControls(controls: Array<{ palm: { x: number; y: number; z: number } }>): void
}
