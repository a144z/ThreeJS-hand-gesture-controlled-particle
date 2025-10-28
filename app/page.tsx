'use client'

import dynamic from 'next/dynamic'

// Import the component lazily
const OptimizedHandDetection = dynamic(
  () => import('@/components/OptimizedHandDetection'),
  { 
    ssr: false
  }
)

export default function Home() {
  return (
    <div className="container">
      <div className="panel">
        <div className="panel-label">Hand Input</div>
        <video id="input-video" autoPlay playsInline muted></video>
        <canvas id="output"></canvas>
        <div id="gesture-label">Waiting for initialization...</div>
        <div id="error-message"></div>
      </div>
      <div className="panel">
        <div className="panel-label">Gesture-Responsive Particles</div>
        <canvas id="three-canvas1"></canvas>
      </div>
      <div className="panel">
        <div className="panel-label">Cohesive Particle Cluster</div>
        <canvas id="three-canvas2"></canvas>
      </div>
      <OptimizedHandDetection />
    </div>
  )
}
