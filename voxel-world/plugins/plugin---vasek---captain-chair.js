/**
 * Voxel World Plugin
 *
 * Captain Chair — a futuristic cockpit seat for your rocket.
 *
 *   • Equip the Captain Chair tool and right-click a surface to place a chair.
 *     It faces the direction you are looking (nearest cardinal), so the captain
 *     looks "forward" out of the seat.
 *   • Right-click a chair (with any tool) to sit down — the camera snaps into
 *     the seat facing forward and movement is locked to the cabin.
 *   • Press Shift to stand up again and move freely.
 *
 * The chair is a custom THREE.js mesh: a dark-metal pedestal, a reclined
 * cushioned seat + headrest, armrests and glowing cyan accents. It is registered
 * as an `invisible` block (no chunk geometry — the mesh below is the visual) and
 * stays solid for collision so you can also stand on top of it.
 *
 * Four orientations, one block ID each, so the facing survives in the world's
 * modified-block diff like any other block. Sitting is a purely client-side
 * camera/physics override — nothing extra is networked.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, yawObject, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('CaptainChair', {
	init(api) {
		// One block ID per cardinal facing — (dx,dz) is the direction the seated
		// captain looks; the backrest sits on the opposite side.
		const DIRS = [
			{ dx:  0, dz:  1 },   // look +Z
			{ dx:  1, dz:  0 },   // look +X
			{ dx:  0, dz: -1 },   // look -Z
			{ dx: -1, dz:  0 },   // look -X
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function dirKey(dx, dz) { return dx + ',' + dz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [dirKey(d.dx, d.dz), d.id]))

		// ── Register the four chair block types ───────────────────────────
		// invisible → no chunk mesh (custom mesh below); solid (not passable) so
		// the player can't walk through it and can stand on its top.
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Captain Chair',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Materials (shared across every instance — never disposed on cull) ──
		const metalMat   = new THREE.MeshLambertMaterial({ color: 0x2b3038 })
		const trimMat    = new THREE.MeshLambertMaterial({ color: 0x4a5560 })
		const cushionMat = new THREE.MeshLambertMaterial({ color: 0x33414f })
		const glowMat    = new THREE.MeshLambertMaterial({ color: 0x06323b, emissive: 0x00d8ff, emissiveIntensity: 1.4 })

		// ── Canonical chair geometry, captain looking +Z (backrest at -Z) ─────
		// Centred on the cell in XZ so a Y rotation reorients it; feet at y=0.
		// Each piece is [geometry, material]; the template clones share them.
		const parts = []
		function box(w, h, d, x, y, z, mat) {
			const g = new THREE.BoxGeometry(w, h, d)
			g.translate(x, y, z)
			parts.push([g, mat])
		}
		function cyl(rt, rb, h, x, y, z, mat) {
			const g = new THREE.CylinderGeometry(rt, rb, h, 12)
			g.translate(x, y, z)
			parts.push([g, mat])
		}

		// Pedestal: flared base + central stem.
		cyl(0.30, 0.38, 0.14, 0, 0.07, 0, metalMat)
		cyl(0.11, 0.11, 0.36, 0, 0.32, 0, trimMat)
		cyl(0.34, 0.30, 0.06, 0, 0.50, 0, metalMat)   // swivel hub under the seat

		// Seat cushion (slightly toward the front for thigh support).
		box(0.72, 0.16, 0.66, 0, 0.60, 0.02, cushionMat)
		box(0.74, 0.04, 0.68, 0, 0.69, 0.02, glowMat)  // glowing seam around the seat top

		// Backrest (gentle recline) + headrest.
		const back = new THREE.BoxGeometry(0.72, 0.78, 0.14)
		back.translate(0, 1.04, -0.30)
		parts.push([back, cushionMat])
		box(0.46, 0.20, 0.13, 0, 1.50, -0.30, trimMat)        // headrest
		box(0.10, 0.74, 0.04, -0.35, 1.04, -0.27, glowMat)    // left backrest light strip
		box(0.10, 0.74, 0.04,  0.35, 1.04, -0.27, glowMat)    // right backrest light strip

		// Armrests with glowing front tips.
		for (const sx of [-1, 1]) {
			box(0.12, 0.10, 0.52, sx * 0.36, 0.84, 0.05, metalMat)
			box(0.14, 0.08, 0.12, sx * 0.36, 0.86, 0.32, glowMat)
		}

		// Right-armrest control console — the futuristic captain touch.
		// Tilt first (about the geometry origin), THEN move it into place.
		const console3d = new THREE.BoxGeometry(0.20, 0.05, 0.22)
		console3d.rotateX(-0.35)
		console3d.translate(0.36, 0.92, 0.30)
		parts.push([console3d, glowMat])

		// Build one template Group per facing (cheap clones at placement time).
		const templates = new Map()
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const [g, mat] of parts) grp.add(new THREE.Mesh(g, mat))
			grp.rotation.y = Math.atan2(d.dx, d.dz)   // +Z canonical → (dx,dz)
			templates.set(dirKey(d.dx, d.dz), grp)
		}

		// ── Sync THREE.js meshes to placed chair blocks ───────────────────
		const chairMeshes = new Map()   // "x_y_z" → mesh
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

				if (!chairMeshes.has(k)) {
					const d = ID_TO_DIR.get(modified.get(k))
					const mesh = templates.get(dirKey(d.dx, d.dz)).clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					scene.add(mesh)
					chairMeshes.set(k, mesh)
				}
			}

			// Remove meshes for chairs mined or left render distance.
			for (const [k, mesh] of chairMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					chairMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Sitting state & override ───────────────────────────────────────
		// null when standing; otherwise { key, ex, ey, ez } (the seat eye pose).
		let seat = null
		const SEAT_EYE = 1.18   // eye height above the chair block's floor while seated

		function sitDown(x, y, z, d) {
			seat = { key: `${x}_${y}_${z}`, ex: x + 0.5, ey: y + SEAT_EYE, ez: z + 0.5 }
			// Face forward out of the seat. yawObject forward is (-sin,−cos) of its
			// Y rotation, so this yaw points the camera along (dx,dz).
			yawObject.rotation.y = Math.atan2(-d.dx, -d.dz)
			player.flying = false
			showToast('🪑 Seated — press Shift to stand')
		}

		function standUp() {
			if (!seat) return
			const [x, y, z] = seat.key.split('_').map(Number)
			// Step out onto the top of the chair block so we don't clip the solid seat.
			player.pos.set(x + 0.5, y + 1 + player.height, z + 0.5)
			player.vel.set(0, 0, 0)
			player.onGround = false
			seat = null
			showToast('🚶 Standing')
		}

		// Per-frame override: pin the player into the seat, kill velocity, and
		// re-sync the camera (the main loop copied player.pos into yawObject BEFORE
		// this tick, so without this the view lags one frame — same as the lift).
		api.addTickCallback(() => {
			if (!seat) return
			// Stand up automatically if the chair was removed underneath us.
			if (!ID_SET.has(modified.get(seat.key))) { standUp(); return }
			player.pos.set(seat.ex, seat.ey, seat.ez)
			player.vel.set(0, 0, 0)
			player.onGround = true
			yawObject.position.copy(player.pos)
		})

		// Shift stands the captain up. Capture-phase so it wins before the
		// fly/sink Shift handling, and only while actually seated.
		addEventListener('keydown', (e) => {
			if (!seat) return
			if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
				standUp()
				e.preventDefault()
				e.stopPropagation()
			}
		}, true)

		// ── Right-click a chair to sit ────────────────────────────────────
		api.registerBlockInteraction([...ID_SET], (ctx) => {
			const f = ctx.facing
			if (!f || !ID_SET.has(f.type)) return
			if (seat) return   // already seated
			sitDown(f.x, f.y, f.z, ID_TO_DIR.get(f.type))
		})

		// ── Captain Chair tool: place a chair facing the player ───────────
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// backrest
			ctx.fillStyle = '#33414f'
			ctx.fillRect(5 * s, 2 * s, 6 * s, 8 * s)
			// seat
			ctx.fillRect(4 * s, 9 * s, 8 * s, 3 * s)
			// pedestal
			ctx.fillStyle = '#2b3038'
			ctx.fillRect(7 * s, 12 * s, 2 * s, 3 * s)
			ctx.fillRect(5 * s, 14 * s, 6 * s, 2 * s)
			// glowing accents
			ctx.fillStyle = '#00d8ff'
			ctx.fillRect(5 * s, 2 * s, 1 * s, 8 * s)
			ctx.fillRect(10 * s, 2 * s, 1 * s, 8 * s)
			ctx.fillRect(4 * s, 9 * s, 8 * s, 1 * s)
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Captain Chair',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (ID_SET.has(f.type)) return   // right-clicking a chair sits instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Face the chair the way the player looks (nearest cardinal).
				const dir = new THREE.Vector3()
				camera.getWorldDirection(dir)
				let dx = 0, dz = 0
				if (Math.abs(dir.x) >= Math.abs(dir.z)) dx = Math.sign(dir.x) || 1
				else dz = Math.sign(dir.z) || 1

				ctx.setBlock(bx, by, bz, KEY_TO_ID.get(dirKey(dx, dz)))
			},
		})

		console.log('[CaptainChair] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
