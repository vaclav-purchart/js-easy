/**
 * Voxel World Plugin
 *
 * Door — a two-block-tall interactive flat door.
 *
 * Equip the Door tool:
 *   Right-click any surface        → place a closed door (2 blocks tall)
 * Right-click any door (any tool) → toggle open / closed
 *
 * Doors are thin panels rendered as THREE.js meshes (not atlas blocks).
 * Two orientations at placement: Z-facing and X-facing.
 * Direction is inferred from the wall's face normal or camera yaw (floor/ceiling).
 */

/* global VoxelWorld, THREE */

VoxelWorld.registerPlugin('Door', {
	async init(api) {
		const DOOR_URL = 'https://purchart.eu/images?file=2026-05-04--14-58-55---Lachim---door.png'

		const BASE          = api.allocateBlockId()
		const DOOR_Z_CLOSED = BASE       // panel perpendicular to Z, closed (solid)
		const DOOR_X_CLOSED = BASE + 1   // panel perpendicular to X, closed (solid)
		const DOOR_Z_OPEN   = BASE + 2   // panel perpendicular to Z, open  (passable)
		const DOOR_X_OPEN   = BASE + 3   // panel perpendicular to X, open  (passable)

		const DOOR_IDS    = [DOOR_Z_CLOSED, DOOR_X_CLOSED, DOOR_Z_OPEN, DOOR_X_OPEN]
		const DOOR_ID_SET = new Set(DOOR_IDS)

		// ── Register block types ──────────────────────────────────────────
		// invisible: transparent for face-culling AND generates no chunk geometry.
		// Closed variants are solid (default); open variants are passable.
		for (const id of [DOOR_Z_CLOSED, DOOR_X_CLOSED]) {
			api.registerBlock({ id, name: 'Door', category: 'Crafted', invisible: true })
		}
		for (const id of [DOOR_Z_OPEN, DOOR_X_OPEN]) {
			api.registerBlock({ id, name: 'Door (open)', category: 'Crafted', invisible: true, passable: true })
		}

		// ── THREE.js door panel meshes ────────────────────────────────────
		const doorTex = new THREE.TextureLoader().load(DOOR_URL)
		doorTex.magFilter = THREE.NearestFilter
		doorTex.minFilter = THREE.NearestFilter

		// Thin panel: full block width × full 2-block height × slight depth for 3D appearance
		const panelGeo = new THREE.BoxGeometry(1.0, 2.0, 0.1)
		const panelMat = new THREE.MeshLambertMaterial({ map: doorTex, side: THREE.DoubleSide, alphaTest: 0.5 })

		// Map from "x_y_z" (bottom block key) → mesh currently in scene
		const doorMeshes = new Map()

		// Returns position + rotation.y for each door state.
		// Open doors are offset to the hinge side so they don't block the passage.
		function meshTransform(id, x, y, z) {
			switch (id) {
				case DOOR_Z_CLOSED: return { px: x + 0.5,  py: y + 1.0, pz: z + 0.5,  ry: 0             }
				case DOOR_X_CLOSED: return { px: x + 0.5,  py: y + 1.0, pz: z + 0.5,  ry: Math.PI / 2   }
				case DOOR_Z_OPEN:   return { px: x + 0.07, py: y + 1.0, pz: z + 0.5,  ry: Math.PI / 2   }
				case DOOR_X_OPEN:   return { px: x + 0.5,  py: y + 1.0, pz: z + 0.07, ry: 0             }
				default:            return { px: x + 0.5,  py: y + 1.0, pz: z + 0.5,  ry: 0             }
			}
		}

		// Track which door blocks existed last tick so we can detect mining.
		let prevDoorKeys = new Set()

		api.addTickCallback(() => {
			// ── Scan modified for all current door blocks ─────────────────
			const currentDoorKeys = new Set()
			for (const [k, v] of modified) {
				if (DOOR_ID_SET.has(v)) currentDoorKeys.add(k)
			}

			// ── Detect mined door halves and remove the partner ───────────
			for (const k of prevDoorKeys) {
				if (currentDoorKeys.has(k)) continue   // still exists, nothing to do
				const [x, y, z] = k.split('_').map(Number)
				for (const dy of [1, -1]) {
					const pk = `${x}_${y + dy}_${z}`
					if (!currentDoorKeys.has(pk)) continue
					// Partner is still present — remove it
					modified.set(pk, BLOCK.AIR)
					rebuildChunkAt(x, z)
					netSendBlockUpdate(pk, BLOCK.AIR)
					currentDoorKeys.delete(pk)  // prevent cascade next tick
					break
				}
			}
			prevDoorKeys = new Set(currentDoorKeys)

			// ── Sync THREE.js panel meshes to world state ─────────────────
			const bottomKeys = new Set()

			for (const k of currentDoorKeys) {
				const [x, y, z] = k.split('_').map(Number)
				// Only process the bottom half (skip top half — door block directly below is also a door)
				const kBelow = `${x}_${y - 1}_${z}`
				if (currentDoorKeys.has(kBelow)) continue

				bottomKeys.add(k)

				if (!doorMeshes.has(k)) {
					const mesh = new THREE.Mesh(panelGeo, panelMat)
					scene.add(mesh)
					doorMeshes.set(k, mesh)
				}

				const v = modified.get(k)
				const { px, py, pz, ry } = meshTransform(v, x, y, z)
				const mesh = doorMeshes.get(k)
				mesh.position.set(px, py, pz)
				mesh.rotation.y = ry
			}

			// Remove meshes for door pairs that no longer exist
			for (const [k, mesh] of doorMeshes) {
				if (!bottomKeys.has(k)) {
					scene.remove(mesh)
					doorMeshes.delete(k)
				}
			}
		})

		// ── Block interaction: right-click toggles any door ───────────────
		api.registerBlockInteraction(DOOR_IDS, (ctx) => {
			const f = ctx.facing
			if (!f || !DOOR_ID_SET.has(f.type)) return

			const above = ctx.getBlock(f.x, f.y + 1, f.z)
			const below = ctx.getBlock(f.x, f.y - 1, f.z)
			let by, ty
			if (DOOR_ID_SET.has(above)) { by = f.y;     ty = f.y + 1 }
			else if (DOOR_ID_SET.has(below)) { by = f.y - 1; ty = f.y }
			else { by = f.y; ty = f.y }

			const newId =
				f.type === DOOR_Z_CLOSED ? DOOR_Z_OPEN  :
				f.type === DOOR_Z_OPEN   ? DOOR_Z_CLOSED :
				f.type === DOOR_X_CLOSED ? DOOR_X_OPEN  :
				                           DOOR_X_CLOSED

			ctx.setBlocks([
				[f.x, by, f.z, newId],
				[f.x, ty, f.z, newId],
			])
		})

		// ── Door tool: equip to place new doors ───────────────────────────
		api.registerTool({
			name:   'Door',
			url:    DOOR_URL,
			damage: 0,

			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (DOOR_ID_SET.has(f.type)) return   // toggle handled by registerBlockInteraction

				const bx = f.x + f.nx
				const by = f.y + f.ny
				const bz = f.z + f.nz
				if (ctx.getBlock(bx, by,     bz) !== null) return
				if (ctx.getBlock(bx, by + 1, bz) !== null) return

				// Wall normals determine orientation; floor/ceiling falls back to camera yaw.
				let closedId
				if (f.nx !== 0) {
					closedId = DOOR_Z_CLOSED
				} else if (f.nz !== 0) {
					closedId = DOOR_X_CLOSED
				} else {
					const dir = new THREE.Vector3()
					camera.getWorldDirection(dir)
					closedId = Math.abs(dir.x) > Math.abs(dir.z) ? DOOR_X_CLOSED : DOOR_Z_CLOSED
				}

				ctx.setBlocks([
					[bx, by,     bz, closedId],
					[bx, by + 1, bz, closedId],
				])
			},
		})

		console.log('[Door] registered ids ' + BASE + '–' + (BASE + 3))
	},
})
