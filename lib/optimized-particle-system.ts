/**
 * Optimized particle system using THREE.js instanced rendering
 * Features:
 * - GPU-accelerated rendering
 * - Memory-efficient particle storage
 * - Smooth 60fps performance
 * - Configurable behaviors including wuxia-style needle sphere mode
 */

'use client'

import * as THREE from 'three'
import type { HandControl } from '@/lib/mediapipe-handler'

interface ParticleSystemConfig {
  color: number
  count: number
  size: number
  boundary: number
  viscosity: number
  behavior: 'responsive' | 'cohesive' | 'needleSphere' | 'needleSwarm'
  /**
   * Rendering geometry for instances
   * - 'sphere': default particle blobs
   * - 'needle': elongated spikes used in needleSphere mode
   */
  geometry?: 'sphere' | 'needle'
  attractionStrength?: number
  interactionRadius?: number
  cohesionStrength?: number
  cohesionRadius?: number
  /**
   * Needle-sphere specific configuration
   */
  baseRadius?: number
  radiusHandScale?: number
  outerRadiusMultiplier?: number
  needleLength?: number
}

export class OptimizedParticleSystem {
  private canvas: HTMLCanvasElement
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private params: ParticleSystemConfig

  // Instanced rendering components
  private geometry: THREE.BufferGeometry
  private material: THREE.MeshPhongMaterial
  private mesh: THREE.InstancedMesh
  private matrix: THREE.Matrix4
  private tmpQuaternion: THREE.Quaternion
  private tmpScale: THREE.Vector3

  // Particle data (CPU-side for physics)
  private particles: Array<{
    position: THREE.Vector3
    velocity: THREE.Vector3
    /**
     * Fixed direction on the unit sphere used in needleSphere mode.
     * Represents the ray from the center through this particle.
     */
    direction: THREE.Vector3
    /**
     * Group index for multi-shell effects (e.g. inner/outer spheres).
     */
    groupIndex: number
    /**
     * Assigned center index for swarm mode (to prevent sudden reassignments)
     */
    assignedCenterIndex?: number
    /**
     * Target position on sphere (for smooth following)
     */
    targetPosition?: THREE.Vector3
  }> = []

  private handControls: HandControl[] = []
  private lastTime: number = 0
  private animationId: number | null = null
  
  // Meditation skeletons - one per hand center
  private skeletons: THREE.Group[] = []
  private skeletonMaterial: THREE.MeshPhongMaterial

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
    // Better 3D camera angle for swarm mode
    if (params.behavior === 'needleSwarm') {
      this.camera.position.set(40, 30, 50)
      this.camera.lookAt(0, 0, 0)
    } else if (params.behavior === 'needleSphere') {
      // Zoom out further to show the whole sphere, especially when hands are far apart
      this.camera.position.set(50, 40, 70)
      this.camera.lookAt(0, 0, 0)
    } else {
      this.camera.position.z = 50
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false // Disable for better performance
    })
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000)

    // Create instanced mesh
    const geometryType = this.params.geometry ?? 'sphere'
    if (geometryType === 'needle') {
      this.geometry = this.createSwordGeometry()
    } else {
      this.geometry = new THREE.SphereGeometry(this.params.size, 12, 8)
    }

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
    this.tmpQuaternion = new THREE.Quaternion()
    this.tmpScale = new THREE.Vector3(1, 1, 1)

    this.initParticles()
    this.addLights()
    this.scene.add(this.mesh)

    // Create skeleton material
    this.skeletonMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x444444,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.7
    })

    this.lastTime = performance.now()
  }

  private createSwordGeometry(): THREE.BufferGeometry {
    // Scale factor to match visible size
    const s = (this.params.size || 0.5) * 1.2

    // 1. Handle (Cylinder)
    const handleGeo = new THREE.CylinderGeometry(0.12 * s, 0.15 * s, 1.5 * s, 8)
    handleGeo.translate(0, -0.75 * s, 0)

    // 2. Guard (Box)
    const guardGeo = new THREE.BoxGeometry(1.4 * s, 0.2 * s, 0.3 * s)
    guardGeo.translate(0, 0, 0)

    // 3. Blade (Tapered flattened cylinder - Diamond profile)
    const bladeLen = 6.0 * s
    const bladeGeo = new THREE.CylinderGeometry(0.02 * s, 0.35 * s, bladeLen, 4)
    // Rotate to align diamond shape flat
    bladeGeo.rotateY(Math.PI / 4)
    bladeGeo.scale(1, 1, 0.15) // Flatten
    bladeGeo.translate(0, bladeLen / 2, 0)

    return this.mergeGeometries([handleGeo, guardGeo, bladeGeo])
  }

  private mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const mergedGeometry = new THREE.BufferGeometry()
    
    let totalVertices = 0
    let totalIndices = 0
    
    geometries.forEach(geo => {
      totalVertices += geo.attributes.position.count
      if (geo.index) totalIndices += geo.index.count
    })

    const positionArray = new Float32Array(totalVertices * 3)
    const normalArray = new Float32Array(totalVertices * 3)
    const indexArray = totalIndices > 0 ? new Uint32Array(totalIndices) : null

    let vertexOffset = 0
    let indexOffset = 0

    geometries.forEach(geo => {
      const pos = geo.attributes.position
      const norm = geo.attributes.normal
      const index = geo.index

      positionArray.set(pos.array, vertexOffset * 3)
      if (norm) normalArray.set(norm.array, vertexOffset * 3)

      if (index && indexArray) {
        for (let i = 0; i < index.count; i++) {
          indexArray[indexOffset + i] = index.getX(i) + vertexOffset
        }
        indexOffset += index.count
      }

      vertexOffset += pos.count
      geo.dispose()
    })

    mergedGeometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3))
    mergedGeometry.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3))
    
    if (indexArray) {
      mergedGeometry.setIndex(new THREE.BufferAttribute(indexArray, 1))
    }

    return mergedGeometry
  }

  private initParticles(): void {
    for (let i = 0; i < this.params.count; i++) {
      const position = new THREE.Vector3(
        (Math.random() - 0.5) * this.params.boundary * 2,
        (Math.random() - 0.5) * this.params.boundary * 2,
        (Math.random() - 0.5) * this.params.boundary * 2
      )
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.8
      )

      // Random direction on unit sphere for needleSphere mode
      const direction = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize()

      const groupIndex = i % 2 // two shells by default

      this.particles.push({
        position,
        velocity,
        direction,
        groupIndex,
        assignedCenterIndex: undefined,
        targetPosition: undefined
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
    // Update skeletons to match current hand positions
    this.updateSkeletons()
    
    if (this.params.behavior === 'needleSphere') {
      this.updateNeedleSphere(deltaTime)
      return
    }

    if (this.params.behavior === 'needleSwarm') {
      this.updateNeedleSwarm(deltaTime)
      return
    }

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

  /**
   * Needle sphere with smooth distance-based control:
   * - Particles are ALWAYS constrained to perfect spherical shells around a dynamic center.
   * - Radius scales smoothly with distance between two hands only.
   * - Needles are oriented to always point toward the center.
   * - Needles move around the sphere with swimming motion.
   * - STRICT sphere constraint ensures perfect sphere formation at all times.
   */
  private updateNeedleSphere(deltaTime: number): void {
    const center = new THREE.Vector3(0, 0, 0)

    // Compute dynamic center and hand distance - ONLY based on palm positions
    let handDistance = 0

    if (this.handControls.length === 2) {
      const palmA = new THREE.Vector3(
        this.handControls[0].palm.x,
        this.handControls[0].palm.y,
        this.handControls[0].palm.z
      )
      const palmB = new THREE.Vector3(
        this.handControls[1].palm.x,
        this.handControls[1].palm.y,
        this.handControls[1].palm.z
      )
      center.addVectors(palmA, palmB).multiplyScalar(0.5)
      handDistance = palmA.distanceTo(palmB)
    } else if (this.handControls.length === 1) {
      const palm = this.handControls[0].palm
      center.set(palm.x, palm.y, palm.z)
      handDistance = 15 // Default distance for single hand
    } else {
      center.set(0, 0, 0)
      handDistance = 10 // Default distance for no hands
    }

    // Smooth radius calculation based ONLY on hand distance
    const baseRadius = this.params.baseRadius ?? 8
    const radiusHandScale = this.params.radiusHandScale ?? 1.2
    const outerRadiusMultiplier = this.params.outerRadiusMultiplier ?? 1.8
    
    // Smooth interpolation to prevent sudden jumps
    const targetRadius = baseRadius + handDistance * radiusHandScale
    const effectiveRadius = targetRadius

    const upAxis = new THREE.Vector3(0, 1, 0)
    const needleLength = this.params.needleLength ?? this.params.size * 4
    this.tmpScale.set(1, needleLength, 1)

    // Swimming motion parameters
    const swimSpeed = 4.0
    const time = performance.now() * 0.001
    const sphereConstraintStrength = 1.0 // Strong constraint to always maintain sphere

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]

      // Base radius for this particle's shell (inner or outer)
      const shellMultiplier = particle.groupIndex === 0 ? 1 : outerRadiusMultiplier
      const targetRadiusForParticle = effectiveRadius * shellMultiplier

      // Get current position relative to center
      const toParticle = particle.position.clone().sub(center)
      const currentDist = toParticle.length()
      
      // ALWAYS ensure particle is on sphere surface - strict constraint
      let toSurface: THREE.Vector3
      if (currentDist > 0.01) {
        toSurface = toParticle.clone().normalize()
      } else {
        // If at center, use stored direction
        toSurface = particle.direction.clone().normalize()
      }
      
      // STRICT: Always project to exact sphere surface first
      const surfacePos = toSurface.clone().multiplyScalar(targetRadiusForParticle).add(center)
      particle.position.copy(surfacePos) // Start from exact sphere position
      
      // Create tangential swimming motion (needles swimming around sphere)
      // Use two perpendicular tangent vectors for 3D flow
      const up = new THREE.Vector3(0, 1, 0)
      let tangent1 = new THREE.Vector3()
      tangent1.crossVectors(toSurface, up)
      if (tangent1.lengthSq() < 0.01) {
        tangent1.crossVectors(toSurface, new THREE.Vector3(1, 0, 0))
      }
      tangent1.normalize()
      
      let tangent2 = new THREE.Vector3()
      tangent2.crossVectors(toSurface, tangent1)
      tangent2.normalize()

      // Phase offset for each particle creates wave-like swimming
      const phase = i * 0.01 + time * 0.4
      const swimDirection = tangent1
        .multiplyScalar(Math.cos(phase) * swimSpeed)
        .add(tangent2.multiplyScalar(Math.sin(phase) * swimSpeed))

      // Update velocity for smooth swimming (only tangential component)
      // Remove any radial component from velocity to maintain sphere
      const currentRadial = toSurface.clone().multiplyScalar(
        particle.velocity.clone().dot(toSurface)
      )
      const tangentialVelocity = particle.velocity.clone().sub(currentRadial)
      const desiredTangentialVelocity = swimDirection
      
      // Blend tangential velocities
      tangentialVelocity.lerp(desiredTangentialVelocity, deltaTime * 3.0)
      
      // Update velocity (only tangential, no radial component)
      particle.velocity.copy(tangentialVelocity)
      
      // Move particle along sphere surface using tangential velocity
      particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
      
      // STRICT: Always re-project to exact sphere surface after movement
      // This ensures perfect sphere formation no matter what
      const newToParticle = particle.position.clone().sub(center)
      if (newToParticle.lengthSq() > 0.0001) {
        // Normalize and scale to exact radius
        newToParticle.normalize().multiplyScalar(targetRadiusForParticle)
        particle.position.copy(newToParticle.add(center))
      } else {
        // Fallback: use stored direction if too close to center
        const fallbackPos = particle.direction.clone()
          .normalize()
          .multiplyScalar(targetRadiusForParticle)
          .add(center)
        particle.position.copy(fallbackPos)
      }
      
      // Update stored direction to match current position (for future reference)
      const updatedDirection = particle.position.clone().sub(center)
      if (updatedDirection.lengthSq() > 0.0001) {
        particle.direction.copy(updatedDirection.normalize())
      }

      // Orient needle so its local +Y axis points back to the center
      const toCenter = center.clone().sub(particle.position)
      if (toCenter.lengthSq() > 0.0001) {
        toCenter.normalize()
        this.tmpQuaternion.setFromUnitVectors(upAxis, toCenter)
      } else {
        // Fallback orientation
        this.tmpQuaternion.identity()
      }

      this.matrix.compose(particle.position, this.tmpQuaternion, this.tmpScale)
      this.mesh.setMatrixAt(i, this.matrix)
    }

    this.mesh.instanceMatrix.needsUpdate = true
  }

  /**
   * Hybrid Swarm Logic:
   * - When NO hands: Fish-like swimming motion in 3D sphere formation
   * - When hands detected: Needles flow around hands with gravitational force in 3D
   */
  private updateNeedleSwarm(deltaTime: number): void {
    const upAxis = new THREE.Vector3(0, 1, 0)
    this.tmpScale.set(1, this.params.needleLength ?? 3.5, 1)

    // NO HANDS: Form perfect sphere with swarming motion around center
    if (this.handControls.length === 0) {
      const center = new THREE.Vector3(0, 0, 0)
      const sphereRadius = 12
      const shellMultiplier = 1.8
      const swimSpeed = 5.0
      const time = performance.now() * 0.001
      const sphereFormationSpeed = 0.4 // Fast sphere formation

      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i]
        
        // Determine which shell this particle belongs to
        const shell = particle.groupIndex === 0 ? 1 : shellMultiplier
        const targetRadius = sphereRadius * shell

        // Get current position relative to center
        const toParticle = particle.position.clone().sub(center)
        const currentDist = toParticle.length()
        
        // STRICT: Always project to exact sphere surface first
        let toSurface: THREE.Vector3
        if (currentDist > 0.01) {
          toSurface = toParticle.clone().normalize()
        } else {
          // If at center, use stored direction
          toSurface = particle.direction.clone().normalize()
        }
        
        // Calculate target position on sphere
        const surfacePos = toSurface.clone().multiplyScalar(targetRadius).add(center)
        
        // Fast convergence to sphere: quickly move particles to sphere surface
        if (Math.abs(currentDist - targetRadius) > 0.5) {
          particle.position.lerp(surfacePos, sphereFormationSpeed)
        } else {
          particle.position.copy(surfacePos)
        }
        
        // Update stored direction
        const updatedToSurface = particle.position.clone().sub(center)
        if (updatedToSurface.lengthSq() > 0.0001) {
          particle.direction.copy(updatedToSurface.normalize())
        }
        
        // Create tangential swimming motion (swarm rotating around sphere)
        // Use two perpendicular tangent vectors for 3D flow
        const up = new THREE.Vector3(0, 1, 0)
        let tangent1 = new THREE.Vector3()
        tangent1.crossVectors(toSurface, up)
        if (tangent1.lengthSq() < 0.01) {
          tangent1.crossVectors(toSurface, new THREE.Vector3(1, 0, 0))
        }
        tangent1.normalize()
        
        let tangent2 = new THREE.Vector3()
        tangent2.crossVectors(toSurface, tangent1)
        tangent2.normalize()

        // Phase offset for each particle creates wave-like swarming
        const phase = i * 0.01 + time * 0.5
        const swimDirection = tangent1
          .multiplyScalar(Math.cos(phase) * swimSpeed)
          .add(tangent2.multiplyScalar(Math.sin(phase) * swimSpeed))

        // Update velocity for smooth swarming (only tangential component)
        // Remove any radial component to maintain sphere
        const currentRadial = toSurface.clone().multiplyScalar(
          particle.velocity.clone().dot(toSurface)
        )
        const tangentialVelocity = particle.velocity.clone().sub(currentRadial)
        
        // Blend tangential velocities
        tangentialVelocity.lerp(swimDirection, deltaTime * 3.0)
        particle.velocity.copy(tangentialVelocity)
        
        // Move particle along sphere surface
        particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
        
        // STRICT: Always re-project to exact sphere surface after movement
        const newToParticle = particle.position.clone().sub(center)
        if (newToParticle.lengthSq() > 0.0001) {
          newToParticle.normalize().multiplyScalar(targetRadius)
          particle.position.copy(newToParticle.add(center))
        } else {
          // Fallback: use stored direction
          const fallbackPos = particle.direction.clone()
            .normalize()
            .multiplyScalar(targetRadius)
            .add(center)
          particle.position.copy(fallbackPos)
        }

        // Orient needle in swarming direction
        const direction = particle.velocity.clone().normalize()
        if (direction.lengthSq() < 0.01) {
          // Fallback: point tangentially
          direction.copy(tangent1)
        }
        this.tmpQuaternion.setFromUnitVectors(upAxis, direction)

        this.matrix.compose(particle.position, this.tmpQuaternion, this.tmpScale)
        this.mesh.setMatrixAt(i, this.matrix)
      }

      this.mesh.instanceMatrix.needsUpdate = true
      return
    }

    // HANDS DETECTED: Same sphere shape as no-hands, but centered on each hand
    const centers: THREE.Vector3[] = []
    this.handControls.forEach(c => centers.push(new THREE.Vector3(c.palm.x, c.palm.y, c.palm.z)))

    // Use SAME sphere radius as no-hands case for consistent shape
    const sphereRadius = 12 // Same as no-hands case
    const shellMultiplier = 1.8 // Same as no-hands case
    const swimSpeed = 5.0 // Same as no-hands case
    const time = performance.now() * 0.001
    const sphereFormationSpeed = 0.4 // Same as no-hands case

    // Step 1: Stable assignment using minimum distance algorithm
    // Only reassign if significantly closer to another center (prevents sudden jumps)
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]
      
      // If not assigned yet, or if current center is invalid, find nearest
      if (particle.assignedCenterIndex === undefined || 
          particle.assignedCenterIndex >= centers.length) {
        let nearestIndex = 0
        let minDist = Infinity
        
        for (let j = 0; j < centers.length; j++) {
          const d = particle.position.distanceTo(centers[j])
          if (d < minDist) {
            minDist = d
            nearestIndex = j
          }
        }
        particle.assignedCenterIndex = nearestIndex
      } else {
        // Check if another center is significantly closer (threshold prevents jitter)
        const currentCenter = centers[particle.assignedCenterIndex]
        const currentDist = particle.position.distanceTo(currentCenter)
        
        let shouldReassign = false
        let newIndex = particle.assignedCenterIndex
        
        for (let j = 0; j < centers.length; j++) {
          if (j === particle.assignedCenterIndex) continue
          const d = particle.position.distanceTo(centers[j])
          // Only reassign if new center is significantly closer (20% threshold)
          if (d < currentDist * 0.8) {
            shouldReassign = true
            newIndex = j
            break
          }
        }
        
        if (shouldReassign) {
          particle.assignedCenterIndex = newIndex
        }
      }
    }

    // Step 2: Use SAME sphere formation logic as no-hands case for consistent shape
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]
      const centerIndex = particle.assignedCenterIndex ?? 0
      const center = centers[centerIndex]

      // Use SAME logic as no-hands: same sphere radius, same shell multiplier
      const shell = particle.groupIndex === 0 ? 1 : shellMultiplier
      const targetRadius = sphereRadius * shell

      // Get current position relative to center
      const toParticle = particle.position.clone().sub(center)
      const currentDist = toParticle.length()
      
      // STRICT: Always project to exact sphere surface first (same as no-hands)
      let toSurface: THREE.Vector3
      if (currentDist > 0.01) {
        toSurface = toParticle.clone().normalize()
      } else {
        // If at center, use stored direction
        toSurface = particle.direction.clone().normalize()
      }
      
      // Calculate target position on sphere
      const surfacePos = toSurface.clone().multiplyScalar(targetRadius).add(center)
      
      // Fast convergence to sphere: quickly move particles to sphere surface (same as no-hands)
      if (Math.abs(currentDist - targetRadius) > 0.5) {
        particle.position.lerp(surfacePos, sphereFormationSpeed)
      } else {
        particle.position.copy(surfacePos)
      }
      
      // Update stored direction
      const updatedToSurface = particle.position.clone().sub(center)
      if (updatedToSurface.lengthSq() > 0.0001) {
        particle.direction.copy(updatedToSurface.normalize())
      }
      
      // Create tangential swimming motion (swarm rotating around sphere) - SAME as no-hands
      // Use two perpendicular tangent vectors for 3D flow
      const up = new THREE.Vector3(0, 1, 0)
      let tangent1 = new THREE.Vector3()
      tangent1.crossVectors(toSurface, up)
      if (tangent1.lengthSq() < 0.01) {
        tangent1.crossVectors(toSurface, new THREE.Vector3(1, 0, 0))
      }
      tangent1.normalize()
      
      let tangent2 = new THREE.Vector3()
      tangent2.crossVectors(toSurface, tangent1)
      tangent2.normalize()

      // Phase offset for each particle creates wave-like swarming (same as no-hands)
      const phase = i * 0.01 + time * 0.5
      const swimDirection = tangent1
        .multiplyScalar(Math.cos(phase) * swimSpeed)
        .add(tangent2.multiplyScalar(Math.sin(phase) * swimSpeed))

      // Update velocity for smooth swarming (only tangential component) - SAME as no-hands
      // Remove any radial component to maintain sphere
      const currentRadial = toSurface.clone().multiplyScalar(
        particle.velocity.clone().dot(toSurface)
      )
      const tangentialVelocity = particle.velocity.clone().sub(currentRadial)
      
      // Blend tangential velocities
      tangentialVelocity.lerp(swimDirection, deltaTime * 3.0)
      particle.velocity.copy(tangentialVelocity)
      
      // Move particle along sphere surface
      particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
      
      // STRICT: Always re-project to exact sphere surface after movement (SAME as no-hands)
      const newToParticle = particle.position.clone().sub(center)
      if (newToParticle.lengthSq() > 0.0001) {
        newToParticle.normalize().multiplyScalar(targetRadius)
        particle.position.copy(newToParticle.add(center))
      } else {
        // Fallback: use stored direction
        const fallbackPos = particle.direction.clone()
          .normalize()
          .multiplyScalar(targetRadius)
          .add(center)
        particle.position.copy(fallbackPos)
      }

      // Orient needle in swarming direction (same as no-hands)
      const direction = particle.velocity.clone().normalize()
      if (direction.lengthSq() < 0.01) {
        // Fallback: point tangentially
        direction.copy(tangent1)
      }
      this.tmpQuaternion.setFromUnitVectors(upAxis, direction)

      this.matrix.compose(particle.position, this.tmpQuaternion, this.tmpScale)
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

      if (dist < (this.params.interactionRadius ?? 0)) {
        const force = toPalm
          .normalize()
          .multiplyScalar(
            (this.params.attractionStrength ?? 0) *
              (1 - dist / (this.params.interactionRadius ?? 1))
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

      if (dist < (this.params.cohesionRadius ?? 0)) {
        dir
          .normalize()
          .multiplyScalar(
            (this.params.cohesionStrength ?? 0) *
              (1 - dist / (this.params.cohesionRadius ?? 1))
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

  /**
   * Creates a meditation skeleton in a seated lotus position
   */
  private createMeditationSkeleton(): THREE.Group {
    const skeleton = new THREE.Group()
    const scale = 3.0 // Overall skeleton scale
    
    // Joint size
    const jointSize = 0.3 * scale
    const boneRadius = 0.08 * scale
    
    // Helper function to create a joint (sphere)
    const createJoint = (x: number, y: number, z: number) => {
      const joint = new THREE.Mesh(
        new THREE.SphereGeometry(jointSize, 8, 6),
        this.skeletonMaterial
      )
      joint.position.set(x * scale, y * scale, z * scale)
      return joint
    }
    
    // Helper function to create a bone (cylinder)
    const createBone = (from: THREE.Vector3, to: THREE.Vector3) => {
      const direction = to.clone().sub(from)
      const length = direction.length()
      const bone = new THREE.Mesh(
        new THREE.CylinderGeometry(boneRadius, boneRadius, length, 8),
        this.skeletonMaterial
      )
      bone.position.copy(from.clone().add(to).multiplyScalar(0.5))
      bone.lookAt(to)
      bone.rotateX(Math.PI / 2) // Rotate to align with direction
      return bone
    }
    
    // Meditation pose: seated, legs crossed, hands on knees
    // Head
    const head = createJoint(0, 4.5, 0)
    skeleton.add(head)
    
    // Neck
    const neck = createJoint(0, 3.8, 0)
    skeleton.add(neck)
    skeleton.add(createBone(head.position, neck.position))
    
    // Torso (spine)
    const chest = createJoint(0, 3.0, 0)
    const waist = createJoint(0, 1.5, 0)
    const pelvis = createJoint(0, 0.5, 0)
    skeleton.add(chest, waist, pelvis)
    skeleton.add(createBone(neck.position, chest.position))
    skeleton.add(createBone(chest.position, waist.position))
    skeleton.add(createBone(waist.position, pelvis.position))
    
    // Left shoulder and arm (meditation pose: hand on knee)
    const leftShoulder = createJoint(-0.8, 2.8, 0)
    const leftElbow = createJoint(-1.2, 1.8, 0.3)
    const leftWrist = createJoint(-1.0, 0.8, 0.5)
    const leftHand = createJoint(-0.9, 0.5, 0.6)
    skeleton.add(leftShoulder, leftElbow, leftWrist, leftHand)
    skeleton.add(createBone(chest.position, leftShoulder.position))
    skeleton.add(createBone(leftShoulder.position, leftElbow.position))
    skeleton.add(createBone(leftElbow.position, leftWrist.position))
    skeleton.add(createBone(leftWrist.position, leftHand.position))
    
    // Right shoulder and arm (meditation pose: hand on knee)
    const rightShoulder = createJoint(0.8, 2.8, 0)
    const rightElbow = createJoint(1.2, 1.8, 0.3)
    const rightWrist = createJoint(1.0, 0.8, 0.5)
    const rightHand = createJoint(0.9, 0.5, 0.6)
    skeleton.add(rightShoulder, rightElbow, rightWrist, rightHand)
    skeleton.add(createBone(chest.position, rightShoulder.position))
    skeleton.add(createBone(rightShoulder.position, rightElbow.position))
    skeleton.add(createBone(rightElbow.position, rightWrist.position))
    skeleton.add(createBone(rightWrist.position, rightHand.position))
    
    // Left leg (crossed in meditation pose - lotus position)
    // Left leg goes under, foot rests on right thigh
    const leftHip = createJoint(-0.3, 0.2, 0)
    const leftKnee = createJoint(-0.2, -0.2, 0.4) // Knee pulled in and forward
    const leftAnkle = createJoint(0.3, 0.1, 0.5) // Ankle crosses to right side
    const leftFoot = createJoint(0.5, 0.3, 0.4) // Foot rests on right thigh
    skeleton.add(leftHip, leftKnee, leftAnkle, leftFoot)
    skeleton.add(createBone(pelvis.position, leftHip.position))
    skeleton.add(createBone(leftHip.position, leftKnee.position))
    skeleton.add(createBone(leftKnee.position, leftAnkle.position))
    skeleton.add(createBone(leftAnkle.position, leftFoot.position))
    
    // Right leg (crossed in meditation pose - lotus position)
    // Right leg goes over, foot rests on left thigh
    const rightHip = createJoint(0.3, 0.2, 0)
    const rightKnee = createJoint(0.4, 0.0, 0.3) // Knee pulled in and up
    const rightAnkle = createJoint(0.2, 0.4, 0.2) // Ankle crosses to left side, higher
    const rightFoot = createJoint(-0.3, 0.5, 0.1) // Foot rests on left thigh (higher)
    skeleton.add(rightHip, rightKnee, rightAnkle, rightFoot)
    skeleton.add(createBone(pelvis.position, rightHip.position))
    skeleton.add(createBone(rightHip.position, rightKnee.position))
    skeleton.add(createBone(rightKnee.position, rightAnkle.position))
    skeleton.add(createBone(rightAnkle.position, rightFoot.position))
    
    return skeleton
  }
  
  /**
   * Updates meditation skeletons to match hand centers
   */
  private updateSkeletons(): void {
    // Only show skeletons for needleSwarm behavior
    if (this.params.behavior !== 'needleSwarm') {
      // Remove all skeletons if not in swarm mode
      this.skeletons.forEach(skeleton => {
        this.scene.remove(skeleton)
        skeleton.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
          }
        })
      })
      this.skeletons = []
      return
    }
    
    const centers: THREE.Vector3[] = []
    this.handControls.forEach(c => {
      centers.push(new THREE.Vector3(c.palm.x, c.palm.y, c.palm.z))
    })
    
    // Remove excess skeletons if we have fewer hands
    while (this.skeletons.length > centers.length) {
      const skeleton = this.skeletons.pop()
      if (skeleton) {
        this.scene.remove(skeleton)
        skeleton.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
          }
        })
      }
    }
    
    // Add skeletons if we have more hands
    while (this.skeletons.length < centers.length) {
      const skeleton = this.createMeditationSkeleton()
      this.skeletons.push(skeleton)
      this.scene.add(skeleton)
    }
    
    // Update skeleton positions to match hand centers
    for (let i = 0; i < centers.length; i++) {
      const skeleton = this.skeletons[i]
      const center = centers[i]
      
      // Position skeleton at hand center
      // Skeleton's pelvis is at y=1.5 in local coords, so offset to center it
      skeleton.position.set(center.x, center.y - 1.5, center.z)
      
      // Optional: Rotate skeleton to face forward (can be adjusted)
      skeleton.rotation.y = 0
    }
  }

  setHandControls(handControls: HandControl[]): void {
    this.handControls = handControls
    this.updateSkeletons()
  }

  render(): void {
    // Rotate camera slowly for swarm mode to see 3D effect
    if (this.params.behavior === 'needleSwarm') {
      const time = performance.now() * 0.0005 // Slow rotation
      const radius = 60
      const height = 30
      this.camera.position.x = Math.cos(time) * radius
      this.camera.position.z = Math.sin(time) * radius
      this.camera.position.y = height
      this.camera.lookAt(0, 0, 0)
    }
    
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
    
    // Dispose skeletons
    this.skeletons.forEach(skeleton => {
      this.scene.remove(skeleton)
      skeleton.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
        }
      })
    })
    this.skeletons = []
    
    this.geometry.dispose()
    this.material.dispose()
    this.skeletonMaterial.dispose()
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
        geometry: 'sphere',
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
        geometry: 'sphere',
        cohesionStrength: 0.3,
        cohesionRadius: 5
      }),
      // Needle mode: wuxia-style double-sphere of needles controlled by both hands
      new OptimizedParticleSystem('three-canvas-needle', {
        color: 0xffff66,
        count: 2000,
        size: 0.5,
        boundary: 60, // Increased boundary for larger range
        viscosity: 0.9,
        behavior: 'needleSphere',
        geometry: 'needle',
        baseRadius: 8, // Lower base for more range
        radiusHandScale: 1.2, // Increased for much larger separation range
        outerRadiusMultiplier: 1.9,
        needleLength: 4
      }),
      // Needle swarm mode: bird swarm algorithm with boids behavior
      new OptimizedParticleSystem('three-canvas-swarm', {
        color: 0x00ff88,
        count: 1500,
        size: 0.4,
        boundary: 30,
        viscosity: 0.88,
        behavior: 'needleSwarm',
        geometry: 'needle',
        needleLength: 3.5
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
