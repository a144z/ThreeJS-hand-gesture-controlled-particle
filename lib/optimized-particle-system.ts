/**
 * Optimized particle system using THREE.js instanced rendering
 * Features:
 * - GPU-accelerated rendering
 * - Memory-efficient particle storage
 * - Smooth 60fps performance
 * - Configurable behaviors
 */

'use client'

import * as THREE from 'three'

interface HandControl {
  palm: {
    x: number
    y: number
    z: number
  }
}

interface ParticleSystemConfig {
  color: number
  count: number
  size: number
  boundary: number
  viscosity: number
  behavior: 'responsive' | 'cohesive'
  attractionStrength?: number
  interactionRadius?: number
  cohesionStrength?: number
  cohesionRadius?: number
}

export class OptimizedParticleSystem {
  private canvas: HTMLCanvasElement
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private params: ParticleSystemConfig
  
  // Instanced rendering components
  private geometry: THREE.SphereGeometry
  private material: THREE.MeshPhongMaterial
  private mesh: THREE.InstancedMesh
  private matrix: THREE.Matrix4
  
  // Particle data (CPU-side for physics)
  private particles: Array<{
    position: THREE.Vector3
    velocity: THREE.Vector3
  }> = []
  
  private handControls: HandControl[] = []
  private lastTime: number = 0
  private animationId: number | null = null

  constructor(canvasId: string, params: ParticleSystemConfig) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement
    this.params = params

    // Initialize Three.js
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      75,
      this.canvas.clientWidth / this.canvas.clientHeight,
      0.1,
      1000
    )
    this.camera.position.z = 50

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false // Disable for better performance
    })
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // Cap for performance
    this.renderer.setClearColor(0x000000)

    // Create instanced mesh
    this.geometry = new THREE.SphereGeometry(this.params.size, 12, 8)
    this.material = new THREE.MeshPhongMaterial({
      color: this.params.color,
      emissive: this.params.color,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.8
    })

    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.params.count
    )
    this.matrix = new THREE.Matrix4()

    this.initParticles()
    this.addLights()
    this.scene.add(this.mesh)

    this.lastTime = performance.now()
  }

  private initParticles(): void {
    for (let i = 0; i < this.params.count; i++) {
      this.particles.push({
        position: new THREE.Vector3(
          (Math.random() - 0.5) * this.params.boundary * 2,
          (Math.random() - 0.5) * this.params.boundary * 2,
          (Math.random() - 0.5) * this.params.boundary * 2
        ),
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.8
        )
      })
    }
  }

  private addLights(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3)
    const pointLight = new THREE.PointLight(this.params.color, 1, 100)
    pointLight.position.set(20, 20, 20)
    this.scene.add(ambientLight, pointLight)
  }

  update(deltaTime: number): void {
    const totalForce = new THREE.Vector3()

    // Update each particle
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]
      totalForce.set(0, 0, 0)

      if (this.params.behavior === 'responsive') {
        this.handleResponsiveBehavior(particle, totalForce)
      } else {
        this.handleCohesiveBehavior(particle, i, totalForce)
      }

      // Apply forces
      particle.velocity.add(totalForce)
      particle.velocity.multiplyScalar(this.params.viscosity)
      particle.position.add(particle.velocity)

      // Apply boundaries
      this.applyBoundaries(particle)

      // Update instanced mesh
      this.matrix.makeTranslation(particle.position.x, particle.position.y, particle.position.z)
      this.mesh.setMatrixAt(i, this.matrix)
    }

    this.mesh.instanceMatrix.needsUpdate = true
  }

  private handleResponsiveBehavior(
    particle: { position: THREE.Vector3 },
    totalForce: THREE.Vector3
  ): void {
    for (const control of this.handControls) {
      const palmPos = new THREE.Vector3(
        control.palm.x,
        control.palm.y,
        control.palm.z
      )

      const toPalm = palmPos.clone().sub(particle.position)
      const dist = toPalm.length()

      if (dist < this.params.interactionRadius!) {
        const force = toPalm
          .normalize()
          .multiplyScalar(
            this.params.attractionStrength! * (1 - dist / this.params.interactionRadius!)
          )
        totalForce.add(force)
      }
    }

    // Add random motion
    totalForce.add(
      new THREE.Vector3(
        (Math.random() - 0.5) * 0.05,
        (Math.random() - 0.5) * 0.05,
        (Math.random() - 0.5) * 0.05
      )
    )
  }

  private handleCohesiveBehavior(
    particle: { position: THREE.Vector3 },
    index: number,
    totalForce: THREE.Vector3
  ): void {
    // Cohesion towards center
    const toCenter = particle.position.clone().multiplyScalar(-0.01)
    totalForce.add(toCenter)

    // Sample nearby particles (optimization: check every 10th particle)
    const checkStep = 10
    for (let i = 0; i < this.particles.length; i += checkStep) {
      if (i === index) continue

      const other = this.particles[i]
      const dir = other.position.clone().sub(particle.position)
      const dist = dir.length()

      if (dist < this.params.cohesionRadius!) {
        dir
          .normalize()
          .multiplyScalar(
            this.params.cohesionStrength! * (1 - dist / this.params.cohesionRadius!)
          )
        totalForce.add(dir)
      }
    }
  }

  private applyBoundaries(particle: { position: THREE.Vector3; velocity: THREE.Vector3 }): void {
    const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z']
    for (const axis of axes) {
      if (Math.abs(particle.position[axis]) > this.params.boundary) {
        particle.position[axis] = Math.sign(particle.position[axis]) * this.params.boundary
        particle.velocity[axis] *= -0.8
      }
    }
  }

  setHandControls(handControls: HandControl[]): void {
    this.handControls = handControls
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  startAnimation(): void {
    const animate = () => {
      const now = performance.now()
      const deltaTime = (now - this.lastTime) / 1000
      this.lastTime = now

      this.update(deltaTime)
      this.render()

      this.animationId = requestAnimationFrame(animate)
    }

    animate()
  }

  stopAnimation(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  handleResize(): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  dispose(): void {
    this.stopAnimation()
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
    this.renderer.dispose()
  }
}

export class OptimizedLiquidSimulation {
  private systems: OptimizedParticleSystem[]

  constructor() {
    this.systems = [
      new OptimizedParticleSystem('three-canvas1', {
        color: 0x00ffff,
        count: 1000,
        size: 0.4,
        boundary: 25,
        viscosity: 0.85,
        behavior: 'responsive',
        attractionStrength: 1.5,
        interactionRadius: 15
      }),
      new OptimizedParticleSystem('three-canvas2', {
        color: 0xff00ff,
        count: 800,
        size: 0.6,
        boundary: 20,
        viscosity: 0.95,
        behavior: 'cohesive',
        cohesionStrength: 0.3,
        cohesionRadius: 5
      })
    ]

    this.systems.forEach((system) => system.startAnimation())
    window.addEventListener('resize', () => this.handleResize())
  }

  setHandControls(handControls: HandControl[]): void {
    this.systems.forEach((system) => system.setHandControls(handControls))
  }

  private handleResize(): void {
    this.systems.forEach((system) => system.handleResize())
  }

  dispose(): void {
    this.systems.forEach((system) => system.dispose())
  }
}
