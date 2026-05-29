/**
 * Voxel World Plugin
 *
 * Wooden Table — a simple custom-mesh table you can place things on.
 *
 * Equip the Wooden Table tool and right-click a surface to place one. It is a
 * custom THREE.js mesh (a planked tabletop on four legs), not a textured cube.
 *
 * Registered as a single `invisible` block (no chunk geometry — the mesh below
 * is the visual) but kept SOLID (not passable): the block still has clickable
 * pick faces, so you can target its top and place blocks / items right on top
 * of the table, and walk into it like any other solid block.
 */

/* global VoxelWorld, THREE, modified, scene, player, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('WoodenTable', {
	init(api) {
		const ID = api.allocateBlockId()

		// invisible → no chunk mesh (custom mesh below). NOT passable → stays a
		// solid block so it has collision and a clickable top face to build on.
		api.registerBlock({
			id: ID,
			name: 'Wooden Table',
			category: 'Crafted',
			invisible: true,
		})

		// ── Shared procedural wood texture (planks) ───────────────────────────
		const texCanvas = document.createElement('canvas')
		texCanvas.width = texCanvas.height = 16
		const tctx = texCanvas.getContext('2d')
		tctx.fillStyle = '#a9763f'
		tctx.fillRect(0, 0, 16, 16)
		tctx.fillStyle = '#8a5e30'
		for (let y = 0; y < 16; y += 4) tctx.fillRect(0, y, 16, 1)
		tctx.fillStyle = '#92652f'
		tctx.fillRect(5, 0, 1, 16)
		tctx.fillRect(11, 0, 1, 16)
		const tex = new THREE.CanvasTexture(texCanvas)
		tex.magFilter = THREE.NearestFilter
		tex.minFilter = THREE.NearestFilter
		const topMat = new THREE.MeshLambertMaterial({ map: tex })
		const legMat = new THREE.MeshLambertMaterial({ color: 0x6e4a26 })

		// ── Shared geometry (canonical, centred on the cell in XZ, feet at y=0) ─
		const TOP_Y = 0.9          // tabletop sits near the top of the cell
		const TOP_H = 0.12
		const topGeo = new THREE.BoxGeometry(0.92, TOP_H, 0.92)
		topGeo.translate(0, TOP_Y, 0)

		// Apron rails just under the top, tying the legs together.
		const railH = 0.1
		const railY = TOP_Y - TOP_H / 2 - railH / 2
		const railX = new THREE.BoxGeometry(0.7, railH, 0.08)
		railX.translate(0, railY, 0)
		const railZ = new THREE.BoxGeometry(0.08, railH, 0.7)
		railZ.translate(0, railY, 0)

		// Four legs from the floor up to the apron.
		const legH = railY - railH / 2
		const legGeo = new THREE.BoxGeometry(0.1, legH, 0.1)
		legGeo.translate(0, legH / 2, 0)
		const LEG_OFF = 0.37

		// ── Single template Group (cheap clones at placement) ─────────────────
		const template = new THREE.Group()
		template.add(new THREE.Mesh(topGeo, topMat))
		for (const dz of [-1, 1]) template.add(_railAt(railX, 0, dz * 0.31))
		for (const dx of [-1, 1]) template.add(_railAt(railZ, dx * 0.31, 0))
		for (const dx of [-1, 1]) {
			for (const dz of [-1, 1]) {
				const leg = new THREE.Mesh(legGeo, legMat)
				leg.position.set(dx * LEG_OFF, 0, dz * LEG_OFF)
				template.add(leg)
			}
		}
		function _railAt(geo, x, z) {
			const m = new THREE.Mesh(geo, legMat)
			m.position.set(x, 0, z)
			return m
		}

		// ── Sync THREE.js meshes to placed table blocks ───────────────────────
		const tableMeshes = new Map()   // "x_y_z" → mesh
		let _scanKeys = new Set()
		const _visibleKeys = new Set()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE

		api.addTickCallback(() => {
			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (v === ID) _scanKeys.add(k)
			}

			_visibleKeys.clear()
			for (const k of _scanKeys) {
				const [x, y, z] = k.split('_').map(Number)
				if (Math.abs(x - player.pos.x) > CULL_DIST || Math.abs(z - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)

				if (!tableMeshes.has(k)) {
					const mesh = template.clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					scene.add(mesh)
					tableMeshes.set(k, mesh)
				}
			}

			// Remove meshes for tables mined or left render distance.
			for (const [k, mesh] of tableMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					tableMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Wooden Table tool: place a table on the surface you click ─────────
		api.registerTool({
			name: 'Wooden Table',
			damage: 0,
			draw(ctx, W, H) {
				ctx.clearRect(0, 0, W, H)
				const s = W / 16
				// tabletop
				ctx.fillStyle = '#a9763f'
				ctx.fillRect(2 * s, 5 * s, 12 * s, 2 * s)
				ctx.fillStyle = '#8a5e30'
				ctx.fillRect(2 * s, 6 * s, 12 * s, 1 * s)
				// legs
				ctx.fillStyle = '#6e4a26'
				ctx.fillRect(3 * s, 7 * s, 1.5 * s, 7 * s)
				ctx.fillRect(11.5 * s, 7 * s, 1.5 * s, 7 * s)
			},
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied
				ctx.setBlock(bx, by, bz, ID)
			},
		})

		console.log('[WoodenTable] registered id ' + ID)
	},
})
