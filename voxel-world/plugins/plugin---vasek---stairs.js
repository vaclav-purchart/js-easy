/**
 * Voxel World Plugin
 *
 * Stairs — a ramp block you can walk up smoothly.
 *
 * Equip the Stairs tool and right-click a surface to place a stair. The stair
 * climbs in the direction you are facing: walk forward into its low side and
 * the engine lifts you up the slope onto the block above it. The back face and
 * the two side faces act as solid walls, so stairs read as a one-way ramp.
 *
 * Stairs are registered as `stair` blocks (engine handles the sloped collision,
 * see the STAIRS registry + MAIN LOOP ramp pass in index.html). They are also
 * `passable` (so the generic AABB collision ignores them) and `invisible` (no
 * chunk geometry — the visible staircase is a custom THREE.js mesh below).
 *
 * Four orientations, one per cardinal climb direction, are separate block IDs
 * so the orientation survives in the world's modified-block diff like any other
 * block.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('Stairs', {
	init(api) {
		// One block ID per climb direction. (dx,dz) is the unit direction the
		// surface rises in — the low/entry side is the opposite face.
		const DIRS = [
			{ dx:  1, dz:  0, ry: 0 },              // climb +X
			{ dx:  0, dz:  1, ry: -Math.PI / 2 },   // climb +Z
			{ dx: -1, dz:  0, ry: Math.PI },        // climb -X
			{ dx:  0, dz: -1, ry: Math.PI / 2 },    // climb -Z
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function dirKey(dx, dz) { return dx + ',' + dz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [dirKey(d.dx, d.dz), d.id]))

		// ── Register the four stair block types ───────────────────────────
		// stair{dx,dz} → engine ramp collision; passable → generic collision
		// skips it; invisible → no chunk mesh (custom mesh drawn below).
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Stairs',
				category: 'Crafted',
				invisible: true,
				passable: true,
				stair: { dx: d.dx, dz: d.dz },
			})
		}

		// ── Shared texture (procedural wood planks) ───────────────────────
		const texCanvas = document.createElement('canvas')
		texCanvas.width = texCanvas.height = 16
		const tctx = texCanvas.getContext('2d')
		tctx.fillStyle = '#9c6b3f'
		tctx.fillRect(0, 0, 16, 16)
		tctx.fillStyle = '#7d5430'
		for (let y = 0; y < 16; y += 4) tctx.fillRect(0, y, 16, 1)
		tctx.fillStyle = '#85592f'
		tctx.fillRect(7, 0, 1, 16)
		const tex = new THREE.CanvasTexture(texCanvas)
		tex.magFilter = THREE.NearestFilter
		tex.minFilter = THREE.NearestFilter
		const stairMat = new THREE.MeshLambertMaterial({ map: tex })

		// ── Canonical stepped geometry (climb +X), centred on the cell in XZ
		// so a group rotation about Y reorients it. Steps share geometry; each
		// stair instance is a cheap clone (shared geo + material, nothing per
		// instance to dispose on cull).
		const N_STEPS = 4
		const stepGeos = []
		for (let i = 0; i < N_STEPS; i++) {
			const w = 1 / N_STEPS
			const h = (i + 1) / N_STEPS
			const g = new THREE.BoxGeometry(w, h, 1)
			g.translate((i + 0.5) / N_STEPS - 0.5, h / 2, 0)
			stepGeos.push(g)
		}

		const templates = new Map()   // dirKey → THREE.Group template
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const g of stepGeos) grp.add(new THREE.Mesh(g, stairMat))
			grp.rotation.y = d.ry
			templates.set(dirKey(d.dx, d.dz), grp)
		}

		// ── Sync THREE.js meshes to placed stair blocks ───────────────────
		const stairMeshes = new Map()   // "x_y_z" → mesh
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

				if (!stairMeshes.has(k)) {
					const d = ID_TO_DIR.get(modified.get(k))
					const mesh = templates.get(dirKey(d.dx, d.dz)).clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					scene.add(mesh)
					stairMeshes.set(k, mesh)
				}
			}

			// Remove meshes for stairs that were mined or left render distance.
			for (const [k, mesh] of stairMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					stairMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Stairs tool: place a stair facing the player's look direction ──
		api.registerTool({
			name: 'Stairs',
			damage: 0,
			draw(ctx, W, H) {
				ctx.clearRect(0, 0, W, H)
				ctx.fillStyle = '#9c6b3f'
				const s = W / 4
				// ascending staircase silhouette
				for (let i = 0; i < 4; i++) ctx.fillRect(i * s, H - (i + 1) * s, s, (i + 1) * s)
				ctx.strokeStyle = '#5e3f23'
				ctx.lineWidth = Math.max(1, W / 16)
				for (let i = 0; i < 4; i++) ctx.strokeRect(i * s, H - (i + 1) * s, s, (i + 1) * s)
			},
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Climb in the direction the player is looking (nearest cardinal),
				// so the low/entry side ends up facing the player.
				const dir = new THREE.Vector3()
				camera.getWorldDirection(dir)
				let dx = 0, dz = 0
				if (Math.abs(dir.x) >= Math.abs(dir.z)) dx = Math.sign(dir.x) || 1
				else dz = Math.sign(dir.z) || 1

				ctx.setBlock(bx, by, bz, KEY_TO_ID.get(dirKey(dx, dz)))
			},
		})

		console.log('[Stairs] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
