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
   * - Particles are constrained to spherical shells around a dynamic center.
   * - Radius scales smoothly with distance between two hands only.
   * - Needles are oriented to always point toward the center.
   * - Needles move around the sphere with swimming motion.
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
    const lerpFactor = 0.15

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]

      // Base radius for this particle's shell (inner or outer)
      const shellMultiplier = particle.groupIndex === 0 ? 1 : outerRadiusMultiplier
      const targetRadiusForParticle = effectiveRadius * shellMultiplier

      // Get current position relative to center
      const toParticle = particle.position.clone().sub(center)
      const currentDist = toParticle.length()
      
      // Project to sphere surface
      let toSurface: THREE.Vector3
      if (currentDist > 0.01) {
        toSurface = toParticle.clone().normalize()
      } else {
        // If at center, use stored direction
        toSurface = particle.direction.clone().normalize()
      }
      
      const surfacePos = toSurface.clone().multiplyScalar(targetRadiusForParticle).add(center)
      
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

      // Update velocity for smooth swimming
      particle.velocity.lerp(swimDirection, deltaTime * 3.0)
      
      // Start from surface position and add swimming motion
      particle.position.copy(surfacePos)
      particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
      
      // Re-project to sphere after movement
      const newToParticle = particle.position.clone().sub(center)
      if (newToParticle.lengthSq() > 0.01) {
        newToParticle.normalize().multiplyScalar(targetRadiusForParticle)
        particle.position.copy(newToParticle.add(center))
      }

      // Orient needle so its local +Y axis points back to the center
      const toCenter = center.clone().sub(particle.position).normalize()
      this.tmpQuaternion.setFromUnitVectors(upAxis, toCenter)

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

    // NO HANDS: Animated 3D sphere with fish-like swimming motion
    if (this.handControls.length === 0) {
      const center = new THREE.Vector3(0, 0, 0)
      const sphereRadius = 12
      const shellMultiplier = 1.8
      const swimSpeed = 5.0
      const time = performance.now() * 0.001

      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i]
        
        // Determine which shell this particle belongs to
        const shell = particle.groupIndex === 0 ? 1 : shellMultiplier
        const targetRadius = sphereRadius * shell

        // Get current position relative to center
        const toParticle = particle.position.clone().sub(center)
        const currentDist = toParticle.length()
        
        // Project to sphere surface
        if (currentDist > 0.01) {
          toParticle.normalize()
        } else {
          toParticle.copy(particle.direction).normalize()
        }
        
        const surfacePos = toParticle.clone().multiplyScalar(targetRadius).add(center)
        
        // Create tangential swimming motion (fish swimming around sphere)
        // Use two perpendicular tangent vectors for 3D flow
        const up = new THREE.Vector3(0, 1, 0)
        let tangent1 = new THREE.Vector3()
        tangent1.crossVectors(toParticle, up)
        if (tangent1.lengthSq() < 0.01) {
          tangent1.crossVectors(toParticle, new THREE.Vector3(1, 0, 0))
        }
        tangent1.normalize()
        
        let tangent2 = new THREE.Vector3()
        tangent2.crossVectors(toParticle, tangent1)
        tangent2.normalize()

        // Phase offset for each particle creates wave-like swimming
        const phase = i * 0.01 + time * 0.5
        const swimDirection = tangent1
          .multiplyScalar(Math.cos(phase) * swimSpeed)
          .add(tangent2.multiplyScalar(Math.sin(phase) * swimSpeed))

        // Update velocity for smooth swimming
        particle.velocity.lerp(swimDirection, deltaTime * 3.0)
        
        // Constrain to sphere surface
        particle.position.copy(surfacePos)
        particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
        
        // Re-project to sphere after movement
        const newToParticle = particle.position.clone().sub(center)
        if (newToParticle.lengthSq() > 0.01) {
          newToParticle.normalize().multiplyScalar(targetRadius)
          particle.position.copy(newToParticle.add(center))
        }

        // Orient needle in swimming direction (fish-like)
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

    // HANDS DETECTED: Smooth following with minimum distance swarm algorithm
    const centers: THREE.Vector3[] = []
    this.handControls.forEach(c => centers.push(new THREE.Vector3(c.palm.x, c.palm.y, c.palm.z)))

    // Calculate hand distance to scale sphere radius (similar to cohesive/needleSphere behavior)
    let handDistance = 0
    if (centers.length >= 2) {
      handDistance = centers[0].distanceTo(centers[1])
    } else if (centers.length === 1) {
      handDistance = 20 // Default for single hand
    } else {
      handDistance = 10 // Default for no hands (shouldn't reach here)
    }

    // Scale sphere radius based on hand separation to ensure clear separation
    // When two hands are detected, ensure spheres don't overlap
    let sphereRadius: number
    if (centers.length >= 2) {
      // For two hands: ensure spheres are clearly separated
      // Maximum radius is 1/3 of hand distance to prevent overlap
      const maxRadiusForSeparation = handDistance * 0.33
      // Base radius scales with hand distance, but capped to ensure separation
      const baseRadius = 6
      const radiusHandScale = 0.25 // More conservative scaling
      const dynamicRadius = baseRadius + handDistance * radiusHandScale
      // Use the smaller of dynamic radius or separation limit
      sphereRadius = Math.max(6, Math.min(dynamicRadius, maxRadiusForSeparation))
    } else {
      // Single hand: can use larger radius
      sphereRadius = 12
    }
    
    const shellMultiplier = 1.8
    const swimSpeed = 8.0 // Increased swim speed
    const time = performance.now() * 0.001
    const followSpeed = 0.3 // Significantly increased follow speed for faster formation

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

    // Step 2: Smoothly move particles to their optimal positions with gravitational pull
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]
      const centerIndex = particle.assignedCenterIndex ?? 0
      const center = centers[centerIndex]

      // Use same logic as no-hands: sphere formation with fish-like swimming
      const shell = particle.groupIndex === 0 ? 1 : shellMultiplier
      const targetRadius = sphereRadius * shell

      // Calculate distance to assigned hand center (gravitational force)
      const toCenter = center.clone().sub(particle.position)
      const distToCenter = toCenter.length()
      
      // Gravitational pull: particles swim towards their assigned hand center like fish
      // Stronger pull when far from center, weaker when close (to form sphere shell)
      const gravitationalStrength = 25.0 // Dramatically increased gravitational pull
      const coreRadius = targetRadius * 0.3 // Inner core where repulsion starts
      
      let gravitationalForce = new THREE.Vector3(0, 0, 0)
      if (distToCenter > 0.01) {
        const toCenterNorm = toCenter.clone().normalize()
        
        if (distToCenter > targetRadius) {
          // Outside sphere: very strong pull towards center for fast convergence
          const pullStrength = gravitationalStrength * (1.0 - targetRadius / Math.max(distToCenter, targetRadius))
          gravitationalForce = toCenterNorm.clone().multiplyScalar(pullStrength * 1.5) // Extra boost when outside
        } else if (distToCenter < coreRadius) {
          // Too close to center: push away
          const pushStrength = gravitationalStrength * 0.5 * (1.0 - distToCenter / coreRadius)
          gravitationalForce = toCenterNorm.clone().multiplyScalar(-pushStrength)
        } else {
          // In shell zone: gentle pull to maintain sphere
          const pullStrength = gravitationalStrength * 0.3 * (1.0 - (distToCenter - coreRadius) / (targetRadius - coreRadius))
          gravitationalForce = toCenterNorm.clone().multiplyScalar(pullStrength)
        }
      }
      
      // Apply gravitational force to velocity (fish swimming towards force)
      particle.velocity.add(gravitationalForce.clone().multiplyScalar(deltaTime))
      
      // Calculate optimal position on sphere (minimum distance from current position)
      const toParticle = particle.position.clone().sub(center)
      const currentDist = toParticle.length()
      
      // Get direction vector (maintain relative position on sphere)
      let direction: THREE.Vector3
      if (currentDist > 0.01) {
        direction = toParticle.clone().normalize()
      } else {
        // If at center, use stored direction or random
        direction = particle.direction.clone().normalize()
      }
      
      // Calculate target position on sphere
      const targetPos = direction.clone().multiplyScalar(targetRadius).add(center)
      
      // Smoothly interpolate to target position (prevents sudden jumps)
      if (!particle.targetPosition) {
        particle.targetPosition = targetPos.clone()
      } else {
        // Smoothly update target as center moves
        particle.targetPosition.lerp(targetPos, followSpeed)
      }
      
      // Apply velocity to position (particles swim towards center)
      particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
      
      // Smoothly move particle towards target sphere surface (faster convergence)
      particle.position.lerp(particle.targetPosition, followSpeed * 1.5)
      
      // Ensure we're on sphere surface
      const toCurrent = particle.position.clone().sub(center)
      if (toCurrent.lengthSq() > 0.01) {
        // Only strictly enforce if way off, otherwise let physics do it naturally
        // This allows for more organic "swarming" while still keeping shape
        const dist = toCurrent.length()
        if (Math.abs(dist - targetRadius) > 2.0) {
           toCurrent.normalize().multiplyScalar(targetRadius)
           particle.position.lerp(toCurrent.add(center), 0.1)
        }
      }

      // Create tangential swimming motion (fish swimming around sphere)
      const toSurface = particle.position.clone().sub(center).normalize()
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
      const phase = i * 0.01 + time * 0.5
      const swimDirection = tangent1
        .multiplyScalar(Math.cos(phase) * swimSpeed)
        .add(tangent2.multiplyScalar(Math.sin(phase) * swimSpeed))

      // Add tangential swimming to velocity (fish swimming around sphere)
      particle.velocity.lerp(swimDirection, deltaTime * 4.0) // Quicker response to swim direction
      
      // Apply velocity damping to prevent excessive speed (less damping for faster movement)
      particle.velocity.multiplyScalar(0.96)
      
      // Clamp velocity magnitude (increased max speed)
      const maxSpeed = 25.0
      if (particle.velocity.length() > maxSpeed) {
        particle.velocity.normalize().multiplyScalar(maxSpeed)
      }
      
      // Apply tangential velocity while maintaining sphere
      particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime))
      
      // Re-project to sphere after movement
      const newToSurface = particle.position.clone().sub(center)
      if (newToSurface.lengthSq() > 0.01) {
        // Softer re-projection for organic feel, but still keeps shape
        const dist = newToSurface.length()
        if (Math.abs(dist - targetRadius) > 0.5) {
             newToSurface.normalize().multiplyScalar(targetRadius)
             particle.position.lerp(newToSurface.add(center), 0.2)
             // Update target to match
             particle.targetPosition.copy(particle.position)
        }
      }

      // Orient needle in swimming direction (fish-like)
      const orientationDir = particle.velocity.clone().normalize()
      if (orientationDir.lengthSq() < 0.01) {
        // Fallback: point tangentially
        orientationDir.copy(tangent1)
      }
      this.tmpQuaternion.setFromUnitVectors(upAxis, orientationDir)

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

  setHandControls(handControls: HandControl[]): void {
    this.handControls = handControls
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
