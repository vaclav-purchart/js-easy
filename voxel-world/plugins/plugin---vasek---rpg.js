/**
 * Voxel World Plugin
 * RPG Launcher — fire guided rockets that home onto the nearest mob or player
 * and explode on impact with an area-of-effect blast.
 *
 * Controls:  Right-click / Place button fires a rocket (800 ms cooldown).
 * Targeting: locks onto the nearest visible mob or player within 90° of the
 *            camera direction; flies straight if nothing is in range.
 * Explosion: 3.5-block AoE radius, 50 damage per target.
 */

/* global VoxelWorld, THREE, mobs, remotePlayers */

VoxelWorld.registerPlugin('RPGLauncher', {
	init(api) {

		const ROCKET_SPEED      = 22      // blocks per second
		const ROCKET_TURN_LERP  = 2.0     // homing factor per second (larger = sharper)
		const ROCKET_MAX_DIST   = 96      // blocks before self-destruct
		const LOCK_HALF_ANGLE   = 0.707   // cos(45°) — acquisition cone half-angle
		const EXPLODE_RADIUS    = 3.5     // AoE blast radius in blocks
		const EXPLODE_DAMAGE    = 50      // damage per target (server clamps to 50)
		const FIRE_COOLDOWN_MS  = 800
		const TRAIL_INTERVAL_MS = 45

		let lastFireMs = -Infinity
		// Capture once from first onRightClick; stable reference to module getBlock
		let _getBlock = null

		// ── Shared geometry / materials (never disposed) ──────────────────

		const _bodyGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.55, 6)
		_bodyGeo.rotateX(Math.PI / 2)     // align body axis with local +Z
		const _noseGeo = new THREE.ConeGeometry(0.09, 0.18, 6)
		_noseGeo.rotateX(Math.PI / 2)     // point nose along local +Z
		const _trailGeo = new THREE.SphereGeometry(0.07, 4, 4)

		const _bodyMat = new THREE.MeshBasicMaterial({ color: 0x999999 })
		const _noseMat = new THREE.MeshBasicMaterial({ color: 0xcc3300 })

		// ── Active state ──────────────────────────────────────────────────

		// { mesh, dir, target, distTraveled, lastTrailMs, explode }
		const _rockets     = []
		// live trail particles
		const _trailMeshes = []
		// recycled trail particles (pool)
		const _trailPool   = []

		const TRAIL_COLORS = [0xffaa00, 0xff7700, 0xff3300, 0xdd1100]

		// ── Helpers ───────────────────────────────────────────────────────

		function _makeRocketMesh() {
			const g    = new THREE.Group()
			const body = new THREE.Mesh(_bodyGeo, _bodyMat)
			const nose = new THREE.Mesh(_noseGeo, _noseMat)
			nose.position.z = 0.36
			g.add(body)
			g.add(nose)
			return g
		}

		function _getTrailParticle(color) {
			const p = _trailPool.pop() ??
				new THREE.Mesh(_trailGeo, new THREE.MeshBasicMaterial({ transparent: true }))
			p.material.color.setHex(color)
			p.material.opacity = 1
			p.scale.setScalar(1)
			p.userData.age = 0
			return p
		}

		// Returns { type:'mob'|'player', id } of nearest target in the
		// acquisition cone, or null if nothing is visible in range.
		function _findTarget() {
			const cam    = api.camera
			const camPos = new THREE.Vector3()
			cam.getWorldPosition(camPos)     // camera.position is local (0,0,0); need world
			const camFwd = new THREE.Vector3()
			cam.getWorldDirection(camFwd)

			let best = null, bestDist = ROCKET_MAX_DIST

			for (const [id, mob] of mobs) {
				if (!mob.model?.visible) continue
				if ((mob.data?.hp ?? 1) <= 0) continue
				const delta = mob.model.position.clone().sub(camPos)
				const dist  = delta.length()
				if (dist >= bestDist) continue
				if (delta.normalize().dot(camFwd) < LOCK_HALF_ANGLE) continue
				bestDist = dist
				best = { type: 'mob', id }
			}
			for (const [id, rp] of remotePlayers) {
				if (!rp.model) continue
				if ((rp.data?.hp ?? 1) <= 0) continue
				const delta = rp.model.position.clone().sub(camPos)
				const dist  = delta.length()
				if (dist >= bestDist) continue
				if (delta.normalize().dot(camFwd) < LOCK_HALF_ANGLE) continue
				bestDist = dist
				best = { type: 'player', id }
			}
			return best
		}

		// Returns the current world-space aim point for a live target, or null.
		function _getTargetPos(target) {
			if (!target) return null
			if (target.type === 'mob') {
				const mob = mobs.get(target.id)
				if (!mob?.model) return null
				return mob.model.position.clone().setY(mob.model.position.y + 0.6)
			}
			const rp = remotePlayers.get(target.id)
			if (!rp?.model) return null
			return rp.model.position.clone().setY(rp.model.position.y + 0.9)
		}

		function _spawnExplosion(pos) {
			// Outer blast sphere
			const blastMat  = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.85 })
			const blastMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), blastMat)
			blastMesh.position.copy(pos)
			// Inner flash sphere
			const flashMat  = new THREE.MeshBasicMaterial({ color: 0xffffaa, transparent: true, opacity: 0.95 })
			const flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 5), flashMat)
			flashMesh.position.copy(pos)
			api.scene.add(blastMesh)
			api.scene.add(flashMesh)

			let t = 0
			const DUR          = 0.48
			const BLAST_SCALE  = EXPLODE_RADIUS * 2.1

			function tickBlast(dt) {
				t += dt
				if (t >= DUR) {
					api.scene.remove(blastMesh)
					api.scene.remove(flashMesh)
					blastMesh.geometry.dispose()
					flashMesh.geometry.dispose()
					blastMat.dispose()
					flashMat.dispose()
					api.removeTickCallback(tickBlast)
					return
				}
				const frac = t / DUR
				blastMesh.scale.setScalar(0.3 + frac * BLAST_SCALE)
				blastMat.opacity = 0.85 * (1 - frac * frac)
				flashMesh.scale.setScalar(1 + frac * 4)
				flashMat.opacity = 0.95 * Math.max(0, 1 - frac * 3.5)
			}
			api.addTickCallback(tickBlast)

			// AoE damage — use ranged_hit_* (50-block limit) not hit_* (4-block limit)
			for (const [id, mob] of mobs) {
				if (!mob.model) continue
				if (pos.distanceTo(mob.model.position) <= EXPLODE_RADIUS)
					api.netSend({ type: 'ranged_hit_mob', mobId: id, damage: EXPLODE_DAMAGE })
			}
			for (const [id, rp] of remotePlayers) {
				if (!rp.model) continue
				if (pos.distanceTo(rp.model.position) <= EXPLODE_RADIUS)
					api.netSend({ type: 'ranged_hit_player', targetId: id, damage: EXPLODE_DAMAGE })
			}
		}

		// Scratch vectors — reused every tick, never shared across async calls
		const _toTarget = new THREE.Vector3()
		const _fwd      = new THREE.Vector3(0, 0, 1)  // rocket default facing

		// ── Per-frame tick ────────────────────────────────────────────────

		api.addTickCallback(function tickRPG(dt) {
			const now = performance.now()

			for (let i = _rockets.length - 1; i >= 0; i--) {
				const r = _rockets[i]

				// Homing: steer toward live target
				const tPos = _getTargetPos(r.target)
				if (tPos) {
					_toTarget.copy(tPos).sub(r.mesh.position)
					const dist = _toTarget.length()
					if (dist < 1.0) {
						r.explode = true
					} else {
						_toTarget.normalize()
						r.dir.lerp(_toTarget, Math.min(ROCKET_TURN_LERP * dt, 0.4)).normalize()
					}
				} else {
					r.target = null   // target gone; fly straight
				}

				// Advance
				const step = ROCKET_SPEED * dt
				r.mesh.position.addScaledVector(r.dir, step)
				r.distTraveled += step

				// Orient mesh along travel direction
				r.mesh.quaternion.setFromUnitVectors(_fwd, r.dir)

				// Trail particle
				if (now - r.lastTrailMs >= TRAIL_INTERVAL_MS) {
					r.lastTrailMs = now
					const p = _getTrailParticle(TRAIL_COLORS[now >> 4 & 3])
					p.position.copy(r.mesh.position).addScaledVector(r.dir, -0.3)
					api.scene.add(p)
					_trailMeshes.push(p)
				}

				// Block collision via captured getBlock — skip first 2 blocks so the
				// rocket clears the player and any block they're aiming at up close
				if (!r.explode && r.distTraveled >= 2.0 && _getBlock) {
					const bx = Math.round(r.mesh.position.x)
					const by = Math.round(r.mesh.position.y)
					const bz = Math.round(r.mesh.position.z)
					if (_getBlock(bx, by, bz) !== null) r.explode = true
				}

				if (r.explode || r.distTraveled >= ROCKET_MAX_DIST) {
					api.scene.remove(r.mesh)
					if (r.explode) _spawnExplosion(r.mesh.position.clone())
					_rockets.splice(i, 1)
				}
			}

			// Fade + shrink trail particles
			for (let i = _trailMeshes.length - 1; i >= 0; i--) {
				const p = _trailMeshes[i]
				p.userData.age += dt
				const life = 1 - p.userData.age * 4.5
				if (life <= 0) {
					api.scene.remove(p)
					p.material.opacity = 1
					_trailPool.push(p)
					_trailMeshes.splice(i, 1)
				} else {
					p.material.opacity = life
					p.scale.setScalar(life * 0.85 + 0.1)
				}
			}
		})

		// ── Icon draw (16×16 pixel art) ───────────────────────────────────

		function drawIcon(ctx, W, H) {
			ctx.fillStyle = '#111'
			ctx.fillRect(0, 0, W, H)

			// Exhaust glow at breech
			ctx.fillStyle = 'rgba(255, 160, 0, 0.85)'
			ctx.beginPath()
			ctx.arc(3, H / 2, 2.8, 0, Math.PI * 2)
			ctx.fill()

			// Launcher tube — lower rail
			ctx.strokeStyle = '#666'
			ctx.lineWidth = 3
			ctx.beginPath(); ctx.moveTo(2, H / 2 + 2); ctx.lineTo(W - 5, H / 2 + 2); ctx.stroke()
			// upper rail
			ctx.strokeStyle = '#bbb'
			ctx.lineWidth = 2.5
			ctx.beginPath(); ctx.moveTo(2, H / 2 - 2); ctx.lineTo(W - 5, H / 2 - 2); ctx.stroke()

			// Rocket nose
			ctx.fillStyle = '#cc3300'
			ctx.beginPath()
			ctx.moveTo(W, H / 2)
			ctx.lineTo(W - 5, H / 2 - 2.5)
			ctx.lineTo(W - 5, H / 2 + 2.5)
			ctx.closePath()
			ctx.fill()

			// Rocket body inside tube
			ctx.fillStyle = '#888'
			ctx.fillRect(W - 10, H / 2 - 1.5, 5, 3)

			// Grip
			ctx.strokeStyle = '#555'
			ctx.lineWidth = 1.5
			ctx.beginPath(); ctx.moveTo(7, H / 2 + 2); ctx.lineTo(7, H - 1); ctx.stroke()
		}

		// ── Tool registration ─────────────────────────────────────────────

		api.registerTool({
			name: 'RPG',
			draw: drawIcon,
			damage: 0,
			onRightClick(ctx) {
				_getBlock = ctx.getBlock    // capture stable reference to module getBlock

				console.log('onRightClick')

				const now = performance.now()
				if (now - lastFireMs < FIRE_COOLDOWN_MS) return
				lastFireMs = now

				const dir = new THREE.Vector3()
				api.camera.getWorldDirection(dir)

				// Spawn rocket 1.3 blocks in front of camera so it clears the player
				// getWorldPosition needed — camera.position is local (0,0,0) inside yaw rig
				const origin = new THREE.Vector3()
				api.camera.getWorldPosition(origin)
				origin.addScaledVector(dir, 1.3)
				origin.y -= 0.15

				const mesh = _makeRocketMesh()
				mesh.position.copy(origin)
				api.scene.add(mesh)

				_rockets.push({
					mesh,
					dir:          dir.clone(),
					target:       _findTarget(),
					distTraveled: 0,
					lastTrailMs:  0,
					explode:      false,
				})
			},
		})
	},
})
