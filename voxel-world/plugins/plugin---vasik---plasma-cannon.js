/**
 * Voxel World Plugin
 *
 * Plasma Cannon — a big twin-barrel energy turret for your spaceship.
 *
 *   • Equip the Plasma Cannon tool and right-click a surface to place one. It
 *     mounts on top of the clicked block and faces the way you are looking
 *     (nearest cardinal), barrels pointing "forward".
 *   • Right-click the cannon (any tool) to climb into the gunner seat — the
 *     camera snaps behind the barrels and you can aim by looking around.
 *   • While seated, FIRE with the left mouse button (or Space / F). Each shot
 *     launches twin plasma bolts down the camera's line of sight and deals
 *     1000 damage on impact (the server anti-cheat clamps every hit to 50, so
 *     it still one-shots any mob and two-shots a 100-HP player).
 *   • Press Shift to climb out.
 *
 * Like the rocket engine it is a big custom THREE.js model registered as an
 * `invisible` solid block (the mesh below is the only visual). Four cardinal
 * orientations, one block ID each, so the facing survives in the world's
 * modified-block diff. Twin ribbed barrels with glowing emitters, finned side
 * coolers, a gunner seat, energy coils and cyan hi-tech accents. Firing,
 * sitting and the plasma bolts are purely client-side; only the damage hit
 * messages are networked (reusing the bow's `ranged_hit_*` path).
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, yawObject, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('PlasmaCannon', {
	init(api) {
		// One block ID per cardinal facing — (dx,dz) is the direction the barrels
		// point; the gunner seat sits on the opposite side.
		const DIRS = [
			{ dx:  0, dz:  1 },   // fire +Z (canonical)
			{ dx:  1, dz:  0 },   // fire +X
			{ dx:  0, dz: -1 },   // fire -Z
			{ dx: -1, dz:  0 },   // fire -X
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function dirKey(dx, dz) { return dx + ',' + dz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [dirKey(d.dx, d.dz), d.id]))

		// ── Register the four cannon block types ──────────────────────────
		// invisible → no chunk mesh (custom mesh below); solid (not passable) so
		// you can't walk through it and can stand on it.
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Plasma Cannon',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Materials ─────────────────────────────────────────────────────
		// Hull metals are shared & static. The glow/emitter/plasma materials are
		// shared too, but their intensity/opacity is animated globally each tick
		// (with a fire-flash boost) — cheap even with a cluster of cannons.
		const hullMat    = new THREE.MeshLambertMaterial({ color: 0x23282f })   // dark gunmetal
		const panelMat   = new THREE.MeshLambertMaterial({ color: 0x3a444f })   // hull panels
		const trimMat    = new THREE.MeshLambertMaterial({ color: 0x59636e })   // bright trim
		const barrelMat  = new THREE.MeshLambertMaterial({ color: 0x2a2f36 })   // barrel steel
		const coolerMat  = new THREE.MeshLambertMaterial({ color: 0x6b7785 })   // aluminium fins
		const cushionMat = new THREE.MeshLambertMaterial({ color: 0x33414f })   // gunner seat
		const glowMat    = new THREE.MeshLambertMaterial({ color: 0x06323b, emissive: 0x00e5ff, emissiveIntensity: 1.2 })
		const coilMat    = new THREE.MeshLambertMaterial({ color: 0x07313a, emissive: 0x18d6ff, emissiveIntensity: 1.4 })
		const emitterMat = new THREE.MeshLambertMaterial({ color: 0x0a2a33, emissive: 0x33eaff, emissiveIntensity: 1.6 })
		const muzzleMat  = new THREE.MeshBasicMaterial({ color: 0x9becff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })

		// ── Canonical geometry, barrels firing +Z; feet at y=0 ────────────
		// Authored in unit space then SCALE'd up so the turret is clearly bigger
		// than one block (the placed cell stays 1×1×1 for collision). Centred on
		// the cell in XZ so a Y rotation reorients it.
		const SCALE = 1.85
		const parts = []
		function box(w, h, d, x, y, z, mat) {
			const g = new THREE.BoxGeometry(w * SCALE, h * SCALE, d * SCALE)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}
		function cylY(rt, rb, h, x, y, z, mat, open) {
			const g = new THREE.CylinderGeometry(rt * SCALE, rb * SCALE, h * SCALE, 18, 1, !!open)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}
		function cylZ(rt, rb, h, x, y, z, mat, open) {
			const g = new THREE.CylinderGeometry(rt * SCALE, rb * SCALE, h * SCALE, 18, 1, !!open)
			g.rotateX(Math.PI / 2)   // Y-up cylinder → lies along Z (forward)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}
		function ringZ(r, tube, x, y, z, mat) {   // torus hole faces along Z (around a barrel)
			const g = new THREE.TorusGeometry(r * SCALE, tube * SCALE, 8, 22)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}
		function ringY(r, tube, x, y, z, mat) {   // torus lies flat (turret base ring)
			const g = new THREE.TorusGeometry(r * SCALE, tube * SCALE, 8, 26); g.rotateX(Math.PI / 2)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}
		function sphere(r, x, y, z, mat) {
			const g = new THREE.SphereGeometry(r * SCALE, 14, 12)
			g.translate(x * SCALE, y * SCALE, z * SCALE); parts.push([g, mat])
		}

		// Mount base + rotating turret ring.
		box(1.5, 0.16, 1.5, 0, 0.08, 0, hullMat)
		box(1.18, 0.06, 1.18, 0, 0.18, 0, panelMat)
		ringY(0.5, 0.06, 0, 0.22, 0, trimMat)

		// Main turret housing (slab + sloped upper deck).
		box(1.0, 0.5, 1.2, 0, 0.45, -0.05, hullMat)
		box(0.86, 0.3, 0.86, 0, 0.82, -0.18, panelMat)
		box(1.04, 0.05, 1.22, 0, 0.56, -0.05, glowMat)        // glowing waistline seam
		box(0.1, 0.46, 0.86, -0.5, 0.45, -0.05, glowMat)      // left side light strip
		box(0.1, 0.46, 0.86,  0.5, 0.45, -0.05, glowMat)      // right side light strip

		// Gunner seat at the back (-Z).
		box(0.52, 0.12, 0.52, 0, 0.64, -0.7, cushionMat)
		box(0.54, 0.03, 0.54, 0, 0.71, -0.7, glowMat)         // seat seam glow
		box(0.5, 0.62, 0.12, 0, 0.98, -0.92, cushionMat)      // backrest
		box(0.46, 0.16, 0.1, 0, 1.34, -0.92, trimMat)         // headrest
		for (const sx of [-1, 1]) box(0.1, 0.08, 0.4, sx * 0.3, 0.78, -0.62, trimMat)  // armrests

		// Twin barrels (forward +Z) with rib rings + glowing emitters.
		for (const sx of [-1, 1]) {
			const bx = sx * 0.3
			cylZ(0.16, 0.16, 1.8, bx, 0.66, 0.95, barrelMat)          // barrel body
			ringZ(0.18, 0.03, bx, 0.66, 0.45, trimMat)                // breech ring
			ringZ(0.17, 0.025, bx, 0.66, 0.85, coilMat)               // energy coil
			ringZ(0.17, 0.025, bx, 0.66, 1.15, coilMat)               // energy coil
			ringZ(0.17, 0.025, bx, 0.66, 1.45, coilMat)               // energy coil
			cylZ(0.2, 0.16, 0.22, bx, 0.66, 1.85, emitterMat)         // flared emitter shroud
			ringZ(0.21, 0.04, bx, 0.66, 1.92, glowMat)                // emitter rim
			sphere(0.1, bx, 0.66, 1.96, emitterMat)                   // glowing muzzle core
			sphere(0.24, bx, 0.66, 1.98, muzzleMat)                   // charge/fire flash (opacity animated)
		}

		// Finned side coolers (X sides) — heat-exchanger look + coolant glow.
		for (const sx of [-1, 1]) {
			const cx = sx * 0.62
			cylZ(0.14, 0.14, 1.0, cx, 0.5, 0.2, coolerMat)            // cooler core
			for (let i = 0; i < 7; i++) ringZ(0.24, 0.03, cx, 0.5, -0.25 + i * 0.16, coolerMat)  // cooling fins
			cylZ(0.05, 0.05, 1.0, cx, 0.5, 0.2, coilMat)             // glowing coolant line
		}

		// Targeting scope / sensor mast on top.
		box(0.22, 0.12, 0.34, 0, 1.04, 0.18, trimMat)
		sphere(0.08, 0, 1.05, 0.36, glowMat)                          // glowing lens
		cylY(0.02, 0.02, 0.4, 0.34, 1.18, -0.2, trimMat)              // antenna
		sphere(0.04, 0.34, 1.4, -0.2, glowMat)                        // antenna tip light

		// Central energy core (peeks out the front of the housing).
		sphere(0.16, 0, 0.6, 0.4, coilMat)

		// Build one template Group per facing (cheap clones at placement time).
		const templates = new Map()
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const [g, mat] of parts) grp.add(new THREE.Mesh(g, mat))
			grp.rotation.y = Math.atan2(d.dx, d.dz)   // +Z canonical → (dx,dz)
			templates.set(dirKey(d.dx, d.dz), grp)
		}

		// ── Charge / fire state (read by the glow tick & the input handlers) ──
		const COOLDOWN_MS = 350    // brief recovery before you can recharge
		const MAX_CHARGE_MS = 1800 // hold this long for a full 2000-damage volley
		const MIN_BULLETS = 20     // a tap fires 20×50 = 1000 damage ("one big bullet")
		const MAX_BULLETS = 40     // full charge fires 40×50 = 2000 damage
		const BULLET_DAMAGE = 50   // server clamps every hit to 50 — so we stack hits
		const PLASMA_SPEED = 78    // blocks / second
		const MAX_RANGE = 96       // blocks
		let chargeStart = -1       // performance.now() while charging; -1 = idle
		let cooldownUntil = 0
		let fireFlashUntil = 0

		// ── Fire-flash / charge-glow / idle-glow animation (shared materials) ──
		api.addTickCallback(() => {
			const t = performance.now()
			const boost = t < fireFlashUntil ? (fireFlashUntil - t) / 260 : 0   // 1→0 ramp after a shot
			const charge = chargeStart > 0 ? Math.min((t - chargeStart) / MAX_CHARGE_MS, 1) : 0
			const pulse = 0.5 + 0.3 * Math.sin(t / 320) + 0.2 * Math.sin(t / 90 + 0.7)
			// While charging, a fast flicker on top of the buildup sells the energy spool-up.
			const spool = charge * (0.7 + 0.3 * Math.sin(t / 28))
			glowMat.emissiveIntensity    = 1.0 + 0.4 * pulse + boost * 1.5 + charge * 1.5
			coilMat.emissiveIntensity    = 1.1 + 0.5 * pulse + boost * 2.5 + spool * 3.0
			emitterMat.emissiveIntensity = 1.2 + 0.5 * pulse + boost * 4.0 + spool * 4.5
			muzzleMat.opacity            = boost * 0.9 + spool * 0.6
		})

		// ── Sync THREE.js meshes to placed cannon blocks ──────────────────
		const cannonMeshes = new Map()   // "x_y_z" → mesh
		let _scanKeys = new Set()
		const _visibleKeys = new Set()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE

		api.addTickCallback(() => {
			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (ID_SET.has(v)) _scanKeys.add(k)
			}

			_visibleKeys.clear()
			for (const k of _scanKeys) {
				const [x, y, z] = k.split('_').map(Number)
				if (Math.abs(x - player.pos.x) > CULL_DIST || Math.abs(z - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)

				if (!cannonMeshes.has(k)) {
					const d = ID_TO_DIR.get(modified.get(k))
					const mesh = templates.get(dirKey(d.dx, d.dz)).clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					scene.add(mesh)
					cannonMeshes.set(k, mesh)
				}
			}

			// Remove meshes for cannons mined or left render distance.
			for (const [k, mesh] of cannonMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					cannonMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Sitting state & override ──────────────────────────────────────
		// null when standing; otherwise { key, ex, ey, ez }.
		let seat = null
		const SEAT_EYE = 1.7   // eye height above the cannon block's floor while seated (scales with the bigger turret)

		function sitDown(x, y, z, d) {
			seat = { key: `${x}_${y}_${z}`, ex: x + 0.5, ey: y + SEAT_EYE, ez: z + 0.5 }
			// Face down the barrels. yawObject forward is (-sin,−cos) of its Y
			// rotation, so this yaw points the camera along (dx,dz).
			yawObject.rotation.y = Math.atan2(-d.dx, -d.dz)
			player.flying = false
			showToast('🔫 Gunner seat — HOLD LMB/Space to charge, release to FIRE, Shift to exit')
		}

		function standUp() {
			if (!seat) return
			const [x, y, z] = seat.key.split('_').map(Number)
			// Step out onto the top of the cannon block so we don't clip the solid turret.
			player.pos.set(x + 0.5, y + 1 + player.height, z + 0.5)
			player.vel.set(0, 0, 0)
			player.onGround = false
			seat = null
			chargeStart = -1   // cancel any in-progress charge so the glow/cooldown reset
			showToast('🚶 Standing')
		}

		// Per-frame override: pin the player into the seat, re-sync the camera, and
		// slowly swing the turret to track where the gunner is looking.
		// (The main loop copies player.pos into yawObject BEFORE this tick, so
		// without the re-copy the view lags one frame — same as the captain chair / lift.)
		const TURN_RATE = 1.5   // rad/s — the turret follows the view "slowly"
		const _camDirTmp = new THREE.Vector3()   // hoisted: no alloc in the per-frame tick
		api.addTickCallback((dt) => {
			if (!seat) return
			if (!ID_SET.has(modified.get(seat.key))) { standUp(); return }   // cannon removed underneath us
			player.pos.set(seat.ex, seat.ey, seat.ez)
			player.vel.set(0, 0, 0)
			player.onGround = true
			yawObject.position.copy(player.pos)

			// Swing the seated cannon's barrels toward where the gunner is actually
			// looking. The canonical model fires +Z, so aiming its rotation.y at
			// atan2(forward.x, forward.z) of the real camera forward points the barrels
			// down the line of sight (same vector firing uses). Step toward it at
			// TURN_RATE for a heavy, motorised feel rather than snapping.
			const mesh = cannonMeshes.get(seat.key)
			if (mesh) {
				camera.getWorldDirection(_camDirTmp)
				const targetYaw = Math.atan2(_camDirTmp.x, _camDirTmp.z)
				let delta = targetYaw - mesh.rotation.y
				delta = Math.atan2(Math.sin(delta), Math.cos(delta))   // shortest angle, wrapped to [-π,π]
				const step = TURN_RATE * dt
				mesh.rotation.y += Math.max(-step, Math.min(step, delta))
			}
		})

		// ── Plasma bolt visuals + firing ──────────────────────────────────
		function makeBolt(sizeMul) {
			const g = new THREE.Group()
			const coreMat = new THREE.MeshBasicMaterial({ color: 0xeafdff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
			const glow1Mat = new THREE.MeshBasicMaterial({ color: 0x49e8ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
			const core = new THREE.Mesh(new THREE.SphereGeometry(0.16 * sizeMul, 12, 10), coreMat)
			const glow = new THREE.Mesh(new THREE.SphereGeometry(0.34 * sizeMul, 12, 10), glow1Mat)
			glow.scale.z = 2.4   // stretch into the direction of travel (oriented per-bolt below)
			g.add(core); g.add(glow)
			return g
		}

		function disposeObj(obj) {
			obj.traverse((o) => {
				o.geometry?.dispose()
				if (o.material) [].concat(o.material).forEach((m) => m.dispose())
			})
		}

		function spawnImpact(pos, sizeMul) {
			const mat = new THREE.MeshBasicMaterial({ color: 0x8fefff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
			const flash = new THREE.Mesh(new THREE.SphereGeometry(0.25 * sizeMul, 14, 12), mat)
			flash.position.copy(pos)
			scene.add(flash)
			const born = performance.now()
			function tick() {
				const age = (performance.now() - born) / 280
				if (age >= 1) { scene.remove(flash); disposeObj(flash); api.removeTickCallback(tick); return }
				flash.scale.setScalar(1 + age * 6)
				mat.opacity = 0.85 * (1 - age)
			}
			api.addTickCallback(tick)
		}

		function launchBolt(startPos, dir, targetPos, sizeMul) {
			const bolt = makeBolt(sizeMul)
			const forward = dir.clone().normalize()
			bolt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward)  // stretch axis (+Z) → travel dir
			bolt.position.copy(startPos)
			scene.add(bolt)
			const total = startPos.distanceTo(targetPos)
			let traveled = 0
			function tick(dt) {
				traveled += PLASMA_SPEED * dt
				if (traveled >= total) {
					scene.remove(bolt); disposeObj(bolt); api.removeTickCallback(tick)
					spawnImpact(targetPos, sizeMul)
					return
				}
				bolt.position.copy(startPos).addScaledVector(forward, traveled)
			}
			api.addTickCallback(tick)
		}

		// Begin charging (button down). Auto-repeat keydowns are ignored.
		function startCharge() {
			if (!seat) return
			if (chargeStart > 0) return
			if (performance.now() < cooldownUntil) return
			chargeStart = performance.now()
		}

		// Release (button up) → fire the volley. Hold time → bullet count → damage.
		// Each "bullet" deals 50 (the server's per-hit cap); we fire a tight burst so
		// it reads as one fat plasma slug. 20 bullets = 1000 dmg, 40 = 2000 dmg.
		function releaseFire() {
			if (chargeStart < 0) return
			const held = performance.now() - chargeStart
			chargeStart = -1
			if (!seat) return

			const now = performance.now()
			cooldownUntil = now + COOLDOWN_MS
			fireFlashUntil = now + 260

			const frac = Math.min(held / MAX_CHARGE_MS, 1)
			const bullets = Math.round(MIN_BULLETS + (MAX_BULLETS - MIN_BULLETS) * frac)
			const totalDmg = bullets * BULLET_DAMAGE
			const sizeMul = 1 + frac   // a fuller charge = a beefier-looking slug

			const camDir = new THREE.Vector3()
			camera.getWorldDirection(camDir)
			const eye = camera.getWorldPosition(new THREE.Vector3())
			const right = camDir.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()

			const hit = api.shootRay(MAX_RANGE)
			const targetPos = hit ? hit.point.clone() : eye.clone().addScaledVector(camDir, MAX_RANGE)

			// Stack the damage: many 50-point hits sent in one tight burst. On mobs the
			// server has no per-hit cooldown so this sums to `totalDmg`; on players the
			// 500ms invincibility window caps the applied total at 50 per half-second.
			if (hit && hit.type === 'mob') {
				for (let i = 0; i < bullets; i++) api.netSend({ type: 'ranged_hit_mob', mobId: hit.id, damage: BULLET_DAMAGE })
			} else if (hit && hit.type === 'player') {
				for (let i = 0; i < bullets; i++) api.netSend({ type: 'ranged_hit_player', targetId: hit.id, damage: BULLET_DAMAGE })
			}

			// Twin bolts from each barrel tip toward the target (one visible slug per barrel).
			const base = eye.clone().addScaledVector(camDir, 2.4).addScaledVector(new THREE.Vector3(0, 1, 0), -0.3)
			for (const sx of [-1, 1]) {
				const start = base.clone().addScaledVector(right, sx * 0.3 * SCALE)
				launchBolt(start, targetPos.clone().sub(start), targetPos, sizeMul)
			}
			showToast(`⚡ PLASMA — ${totalDmg} dmg (${bullets}×${BULLET_DAMAGE})`)
		}

		// ── Input: hold to charge & fire while seated, Shift to stand ─────
		// Capture phase so we win before the game's mining (mousedown) and the
		// fly/sink Shift handling, and only while actually seated.
		addEventListener('mousedown', (e) => {
			if (!seat) return
			if (e.button === 0) { startCharge(); e.preventDefault(); e.stopPropagation() }
		}, true)
		addEventListener('mouseup', (e) => {
			if (!seat) return
			if (e.button === 0) { releaseFire(); e.preventDefault(); e.stopPropagation() }
		}, true)

		addEventListener('keydown', (e) => {
			if (!seat) return
			if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
				standUp(); e.preventDefault(); e.stopPropagation()
			} else if (e.code === 'Space' || e.code === 'KeyF') {
				startCharge(); e.preventDefault(); e.stopPropagation()
			}
		}, true)
		addEventListener('keyup', (e) => {
			if (!seat) return
			if (e.code === 'Space' || e.code === 'KeyF') {
				releaseFire(); e.preventDefault(); e.stopPropagation()
			}
		}, true)

		// ── Right-click a cannon to sit ───────────────────────────────────
		api.registerBlockInteraction([...ID_SET], (ctx) => {
			const f = ctx.facing
			if (!f || !ID_SET.has(f.type)) return
			if (seat) return   // already seated
			sitDown(f.x, f.y, f.z, ID_TO_DIR.get(f.type))
		})

		// ── Plasma Cannon tool: place a cannon facing the player ──────────
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// turret housing
			ctx.fillStyle = '#23282f'
			ctx.fillRect(3 * s, 8 * s, 10 * s, 6 * s)
			ctx.fillStyle = '#3a444f'
			ctx.fillRect(5 * s, 6 * s, 6 * s, 3 * s)
			// twin barrels
			ctx.fillStyle = '#2a2f36'
			ctx.fillRect(5 * s, 1 * s, 2 * s, 7 * s)
			ctx.fillRect(9 * s, 1 * s, 2 * s, 7 * s)
			// glowing emitters + accents
			ctx.fillStyle = '#33eaff'
			ctx.fillRect(5 * s, 1 * s, 2 * s, 1 * s)
			ctx.fillRect(9 * s, 1 * s, 2 * s, 1 * s)
			ctx.fillStyle = '#00e5ff'
			ctx.fillRect(3 * s, 11 * s, 10 * s, 1 * s)
			// finned coolers
			ctx.fillStyle = '#6b7785'
			ctx.fillRect(1 * s, 8 * s, 2 * s, 5 * s)
			ctx.fillRect(13 * s, 8 * s, 2 * s, 5 * s)
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Plasma Cannon',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (ID_SET.has(f.type)) return   // right-clicking a cannon sits instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Face the cannon the way the player looks (nearest cardinal).
				const dir = new THREE.Vector3()
				camera.getWorldDirection(dir)
				let dx = 0, dz = 0
				if (Math.abs(dir.x) >= Math.abs(dir.z)) dx = Math.sign(dir.x) || 1
				else dz = Math.sign(dir.z) || 1

				ctx.setBlock(bx, by, bz, KEY_TO_ID.get(dirKey(dx, dz)))
			},
		})

		console.log('[PlasmaCannon] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
