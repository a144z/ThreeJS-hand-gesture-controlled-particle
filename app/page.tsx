'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'

// Import the component lazily with no SSR
const OptimizedHandDetection = dynamic(
  () => import('@/components/OptimizedHandDetection'),
  { 
    ssr: false,
    loading: () => null
  }
)

type TabType = 'responsive' | 'cohesive' | 'needle' | 'swarm'

const tabLabels: Record<TabType, string> = {
  responsive: 'Gesture-Responsive Particles',
  cohesive: 'Cohesive Particle Cluster',
  needle: 'Needle Sphere Mode',
  swarm: 'Needle Swarm (Bird Algorithm)'
}

export default function Home() {
  // Strictly only render the heavy interactive elements on the client
  const [isClient, setIsClient] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('responsive')

  useEffect(() => {
    setIsClient(true)
  }, [])

  // Server-side / Initial render: Return a lightweight static skeleton
  // This prevents hydration mismatches by ensuring the server HTML matches the initial client HTML
  if (!isClient) {
    return (
      <div className="app-container">
        <div className="tabs-header">
          <button className="tab-btn" disabled suppressHydrationWarning>Responsive</button>
          <button className="tab-btn" disabled suppressHydrationWarning>Cohesive</button>
          <button className="tab-btn" disabled suppressHydrationWarning>Needle Sphere</button>
          <button className="tab-btn" disabled suppressHydrationWarning>Needle Swarm</button>
        </div>
        <div className="content-grid">
          <div className="panel input-panel">
            <div className="panel-label" suppressHydrationWarning>Hand Input</div>
            <video id="input-video" autoPlay playsInline muted suppressHydrationWarning></video>
            <canvas id="output" suppressHydrationWarning></canvas>
            <div id="gesture-label" suppressHydrationWarning>Waiting for initialization...</div>
            <div id="error-message" suppressHydrationWarning></div>
          </div>
          <div className="panel effect-panel">
            <div className="panel-label" suppressHydrationWarning>{tabLabels[activeTab]}</div>
            <canvas
              id="three-canvas1"
              suppressHydrationWarning
              className="effect-canvas"
            ></canvas>
            <canvas
              id="three-canvas2"
              suppressHydrationWarning
              className="effect-canvas"
            ></canvas>
            <canvas
              id="three-canvas-needle"
              suppressHydrationWarning
              className="effect-canvas"
            ></canvas>
            <canvas
              id="three-canvas-swarm"
              suppressHydrationWarning
              className="effect-canvas"
            ></canvas>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      <div className="tabs-header">
        <button
          className={`tab-btn ${activeTab === 'responsive' ? 'active' : ''}`}
          onClick={() => setActiveTab('responsive')}
          aria-pressed={activeTab === 'responsive'}
        >
          Responsive
        </button>
        <button
          className={`tab-btn ${activeTab === 'cohesive' ? 'active' : ''}`}
          onClick={() => setActiveTab('cohesive')}
          aria-pressed={activeTab === 'cohesive'}
        >
          Cohesive
        </button>
        <button
          className={`tab-btn ${activeTab === 'needle' ? 'active' : ''}`}
          onClick={() => setActiveTab('needle')}
          aria-pressed={activeTab === 'needle'}
        >
          Needle Sphere
        </button>
        <button
          className={`tab-btn ${activeTab === 'swarm' ? 'active' : ''}`}
          onClick={() => setActiveTab('swarm')}
          aria-pressed={activeTab === 'swarm'}
        >
          Needle Swarm
        </button>
      </div>

      <div className="content-grid">
        <div className="panel input-panel">
          <div className="panel-label">Hand Input</div>
          <video id="input-video" autoPlay playsInline muted suppressHydrationWarning></video>
          <canvas id="output" suppressHydrationWarning></canvas>
          <div id="gesture-label" suppressHydrationWarning>Waiting for initialization...</div>
          <div id="error-message" suppressHydrationWarning></div>
        </div>

        <div className="panel effect-panel">
          <div className="panel-label" suppressHydrationWarning>{tabLabels[activeTab]}</div>
          <canvas
            id="three-canvas1"
            suppressHydrationWarning
            className={`effect-canvas ${activeTab === 'responsive' ? 'active' : ''}`}
          ></canvas>
          <canvas
            id="three-canvas2"
            suppressHydrationWarning
            className={`effect-canvas ${activeTab === 'cohesive' ? 'active' : ''}`}
          ></canvas>
          <canvas
            id="three-canvas-needle"
            suppressHydrationWarning
            className={`effect-canvas ${activeTab === 'needle' ? 'active' : ''}`}
          ></canvas>
          <canvas
            id="three-canvas-swarm"
            suppressHydrationWarning
            className={`effect-canvas ${activeTab === 'swarm' ? 'active' : ''}`}
          ></canvas>
        </div>
      </div>

      {isClient && <OptimizedHandDetection />}
    </div>
  )
}
