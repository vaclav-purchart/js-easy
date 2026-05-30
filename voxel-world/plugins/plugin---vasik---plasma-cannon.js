/**
 * Voxel World Plugin
 *
 * Plasma Cannon — a big twin-barrel energy turret for your spaceship.
 *
 *   • Equip the Plasma Cannon tool and right-click a surface to place one. It
 *     mounts on top of the clicked block and faces the way you are looking
 *     (nearest cardinal), barrels pointing "forward".
 *   • Right-click the cannon (any tool) to climb into the gunner seat — the
 *     camera snaps behind the barrels. While seated the turret smoothly follows
 *     your view, so the barrels always point where you look.
 *   • HOLD the left mouse button (or Space / F) to charge, release to FIRE. The
 *     longer you hold, the bigger the volley: a tap is 20×50 = 1000 damage, a
 *     full charge is 40×50 = 2000. (The server clamps each hit to 50, so we
 *     stack many hits — this stacks fully on mobs; players have a 500 ms
 *     per-hit invincibility window, so only 50/half-second lands on a player.)
 *   • Press Shift to climb out — the turret eases back to its original facing.
 *
 * Like the rocket engine it is a big custom THREE.js model registered as an
 * `invisible` solid block (the mesh below is the only visual). Four cardinal
 * orientations, one block ID each, so the facing survives in the world's
 * modified-block diff. Twin ribbed barrels with glowing emitters, finned side
 * coolers, a gunner seat, energy coils and cyan hi-tech accents.
 *
 * Hot-reload note: the engine re-runs init() on every script load without
 * unloading the old instance. To avoid stacked "ghost" cannons we stamp a
 * global generation counter; an older generation's ticks/listeners tear
 * themselves down as soon as a newer one loads. (Instances from a *different*
 * filename still linger until a hard page reload, though.)
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, yawObject, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('PlasmaCannon', {
	init(api) {
		// ── Generation guard (defeats hot-reload mesh stacking) ───────────
		// Every load bumps a global counter. This instance's persistent ticks &
		// listeners check isStale() and a dedicated cleanup tick removes them
		// (and their meshes) the moment a newer generation loads.
		const MY_GEN = (window.__PLASMA_CANNON_GEN = (window.__PLASMA_CANNON_GEN || 0) + 1)
		const isStale = () => window.__PLASMA_CANNON_GEN !== MY_GEN

		const _ticks = []                 // persistent tick wrappers (for teardown)
		const _listeners = []             // [target?, type, fn, capture] (for teardown)
		function addTick(fn) {
			const w = (dt) => { if (isStale()) return; fn(dt) }
			_ticks.push(w); api.addTickCallback(w); return w
		}
		function on(type, fn, capture) {
			addEventListener(type, fn, capture)
			_listeners.push([type, fn, capture])
		}

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
		addTick(() => {
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

		addTick(() => {
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
					mesh.userData.homeYaw = mesh.rotation.y   // placed facing — restored on exit
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
		let seat = null            // null when standing; else { key, ex, ey, ez }
		let returning = null       // "x_y_z" of a mesh easing back to its home facing after exit
		const SEAT_EYE = 1.7       // eye height above the cannon block's floor while seated
		const TURN_RESPONSE = 18   // how tightly the barrels follow your view (higher = snappier)
		const RETURN_RESPONSE = 6  // how fast the turret swings back to its facing on exit

		function sitDown(x, y, z, d) {
			seat = { key: `${x}_${y}_${z}`, ex: x + 0.5, ey: y + SEAT_EYE, ez: z + 0.5 }
			returning = null   // cancel any in-progress return on the cannon we just took
			// Face down the barrels. yawObject forward is (-sin,−cos) of its Y
			// rotation, so this yaw points the camera along (dx,dz).
			yawObject.rotation.y = Math.atan2(-d.dx, -d.dz)
			player.flying = false
			showToast('🔫 Gunner seat — HOLD LMB/Space to charge, release to FIRE, Shift to exit')
		}

		function standUp() {
			if (!seat) return
			const [x, y, z] = seat.key.split('_').map(Number)
			returning = seat.key   // ease the turret back to its original facing
			// Step out onto the top of the cannon block so we don't clip the solid turret.
			player.pos.set(x + 0.5, y + 1 + player.height, z + 0.5)
			player.vel.set(0, 0, 0)
			player.onGround = false
			seat = null
			chargeStart = -1   // cancel any in-progress charge so the glow/cooldown reset
			showToast('🚶 Standing')
		}

		// Per-frame: pin the player into the seat, re-sync the camera, and swing the
		// turret. While seated the barrels follow your view; after you exit they ease
		// back to the cannon's placed facing.
		// (The main loop copies player.pos into yawObject BEFORE this tick, so without
		// the re-copy the view lags one frame — same as the captain chair / lift.)
		addTick((dt) => {
			if (seat) {
				if (!ID_SET.has(modified.get(seat.key))) { standUp(); return }   // cannon removed underneath us
				player.pos.set(seat.ex, seat.ey, seat.ez)
				player.vel.set(0, 0, 0)
				player.onGround = true
				yawObject.position.copy(player.pos)

				// Follow the gunner's view. The canonical model fires +Z and the camera's
				// world forward is (-sinθ,-cosθ) for yaw θ, so the barrels point down the
				// line of sight when the mesh yaw is (yaw + π). Ease toward it (frame-rate
				// independent) so it tracks closely with a touch of motorised weight.
				const mesh = cannonMeshes.get(seat.key)
				if (mesh) easeYaw(mesh, yawObject.rotation.y + Math.PI, TURN_RESPONSE, dt)
				return
			}

			if (returning) {
				const mesh = cannonMeshes.get(returning)
				if (!mesh) { returning = null; return }
				const home = mesh.userData.homeYaw ?? 0
				if (easeYaw(mesh, home, RETURN_RESPONSE, dt) < 0.01) { mesh.rotation.y = home; returning = null }
			}
		})

		// Ease an object's Y rotation toward a target along the shortest arc.
		// Returns the (pre-step) absolute angular distance remaining, in radians.
		function easeYaw(mesh, targetYaw, response, dt) {
			let delta = targetYaw - mesh.rotation.y
			delta = Math.atan2(Math.sin(delta), Math.cos(delta))   // shortest angle, wrapped to [-π,π]
			mesh.rotation.y += delta * (1 - Math.exp(-response * dt))
			return Math.abs(delta)
		}

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
		on('mousedown', (e) => {
			if (!seat) return
			if (e.button === 0) { startCharge(); e.preventDefault(); e.stopPropagation() }
		}, true)
		on('mouseup', (e) => {
			if (!seat) return
			if (e.button === 0) { releaseFire(); e.preventDefault(); e.stopPropagation() }
		}, true)
		on('keydown', (e) => {
			if (!seat) return
			if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
				standUp(); e.preventDefault(); e.stopPropagation()
			} else if (e.code === 'Space' || e.code === 'KeyF') {
				startCharge(); e.preventDefault(); e.stopPropagation()
			}
		}, true)
		on('keyup', (e) => {
			if (!seat) return
			if (e.code === 'Space' || e.code === 'KeyF') {
				releaseFire(); e.preventDefault(); e.stopPropagation()
			}
		}, true)

		// ── Right-click a cannon to sit ───────────────────────────────────
		api.registerBlockInteraction([...ID_SET], (ctx) => {
			if (isStale()) return
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
				if (isStale()) return
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

		// ── Teardown when a newer generation loads (clean hot-reload) ──────
		// Runs last so it can see isStale() flip; removes this instance's meshes,
		// ticks and listeners so the replacement instance is the only one alive.
		const cleanupTick = () => {
			if (!isStale()) return
			for (const [, mesh] of cannonMeshes) scene.remove(mesh)
			cannonMeshes.clear()
			for (const [type, fn, capture] of _listeners) removeEventListener(type, fn, capture)
			for (const w of _ticks) api.removeTickCallback(w)
			api.removeTickCallback(cleanupTick)
		}
		api.addTickCallback(cleanupTick)

		console.log('[PlasmaCannon] gen ' + MY_GEN + ' registered ids ' + DIRS.map((d) => d.id).join(','))
		if (MY_GEN > 1) {
			console.warn('[PlasmaCannon] ⚠ generation ' + MY_GEN + ' — earlier instances from this session are still ' +
				'loaded. Pre-guard instances (loaded before this code existed) cannot be torn down from script; ' +
				'do a FULL page reload (not a hot-reload) so only one instance runs. Stacked instances are what ' +
				'cause a "frozen / inverted" ghost cannon on one or more variants.')
		}
	},
})
