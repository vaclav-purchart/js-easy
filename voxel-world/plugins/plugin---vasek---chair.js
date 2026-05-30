/**
 * Voxel World Plugin
 *
 * Wooden Chair — a simple custom-mesh chair you can actually sit on.
 *
 *   • Equip the Wooden Chair tool and right-click a surface to place a chair.
 *     It faces the direction you are looking (nearest cardinal), so you sit
 *     looking "forward" out of the seat.
 *   • Right-click a chair (with any tool) to sit down — the camera snaps into
 *     the seat facing forward and movement is locked.
 *   • Press Shift to stand up again.
 *
 * The chair is a custom THREE.js mesh (planked seat, slatted backrest, four
 * legs). It is registered as an `invisible` block (no chunk geometry — the mesh
 * below is the visual) and stays solid for collision so you can stand on it too.
 *
 * Four orientations, one block ID each, so the facing survives in the world's
 * modified-block diff. Sitting is a purely client-side camera/physics override —
 * nothing extra is networked. (Mirrors plugin---vasek---captain-chair.js.)
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, yawObject, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('WoodenChair', {
	init(api) {
		// One block ID per cardinal facing — (dx,dz) is the direction the seated
		// player looks; the backrest sits on the opposite side.
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
				name: 'Wooden Chair',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Shared procedural wood texture (planks) ───────────────────────
		const texCanvas = document.createElement('canvas')
		texCanvas.width = texCanvas.height = 16
		const tctx = texCanvas.getContext('2d')
		tctx.fillStyle = '#a9763f'
		tctx.fillRect(0, 0, 16, 16)
		tctx.fillStyle = '#8a5e30'
		for (let y = 0; y < 16; y += 4) tctx.fillRect(0, y, 16, 1)
		tctx.fillStyle = '#92652f'
		tctx.fillRect(5, 0, 1, 16)
		const tex = new THREE.CanvasTexture(texCanvas)
		tex.magFilter = THREE.NearestFilter
		tex.minFilter = THREE.NearestFilter
		const seatMat = new THREE.MeshLambertMaterial({ map: tex })
		const frameMat = new THREE.MeshLambertMaterial({ color: 0x6e4a26 })

		// ── Canonical chair geometry, sitter looking +Z (backrest at -Z) ──────
		// Centred on the cell in XZ so a Y rotation reorients it; feet at y=0.
		const parts = []
		function box(w, h, d, x, y, z, mat) {
			const g = new THREE.BoxGeometry(w, h, d)
			g.translate(x, y, z)
			parts.push([g, mat])
		}

		const SEAT_Y = 0.5
		// Four legs from the floor up to the seat.
		for (const sx of [-1, 1]) {
			for (const sz of [-1, 1]) {
				box(0.07, SEAT_Y, 0.07, sx * 0.2, SEAT_Y / 2, sz * 0.2, frameMat)
			}
		}
		// Seat slab.
		box(0.52, 0.07, 0.52, 0, SEAT_Y, 0, seatMat)
		// Two back posts (continue the rear legs upward) + slats between them.
		for (const sx of [-1, 1]) {
			box(0.07, 0.52, 0.07, sx * 0.2, SEAT_Y + 0.26, -0.22, frameMat)
		}
		for (const sy of [0.66, 0.80, 0.94]) {
			box(0.5, 0.07, 0.05, 0, sy, -0.22, seatMat)
		}

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
		const SEAT_EYE = 1.0   // eye height above the chair block's floor while seated

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
		// this tick, so without this the view lags one frame).
		api.addTickCallback(() => {
			if (!seat) return
			// Stand up automatically if the chair was removed underneath us.
			if (!ID_SET.has(modified.get(seat.key))) { standUp(); return }
			player.pos.set(seat.ex, seat.ey, seat.ez)
			player.vel.set(0, 0, 0)
			player.onGround = true
			yawObject.position.copy(player.pos)
		})

		// Shift stands up. Capture-phase so it wins before the fly/sink Shift
		// handling, and only while actually seated.
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

		// ── Wooden Chair tool: place a chair facing the player ────────────
		api.registerTool({
			name: 'Wooden Chair',
			damage: 0,
			draw(ctx, W, H) {
				ctx.clearRect(0, 0, W, H)
				const s = W / 16
				// backrest
				ctx.fillStyle = '#8a5e30'
				ctx.fillRect(4 * s, 2 * s, 8 * s, 1.5 * s)
				ctx.fillRect(4 * s, 4 * s, 8 * s, 1.5 * s)
				// back posts
				ctx.fillStyle = '#6e4a26'
				ctx.fillRect(4 * s, 2 * s, 1.5 * s, 7 * s)
				ctx.fillRect(10.5 * s, 2 * s, 1.5 * s, 7 * s)
				// seat
				ctx.fillStyle = '#a9763f'
				ctx.fillRect(3 * s, 8 * s, 10 * s, 2 * s)
				// front legs
				ctx.fillStyle = '#6e4a26'
				ctx.fillRect(3.5 * s, 10 * s, 1.5 * s, 5 * s)
				ctx.fillRect(11 * s, 10 * s, 1.5 * s, 5 * s)
			},
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

		console.log('[WoodenChair] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
