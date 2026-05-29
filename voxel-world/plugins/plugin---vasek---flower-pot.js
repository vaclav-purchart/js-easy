/**
 * Voxel World Plugin
 *
 * Flower Pot — a small decorative terracotta pot with a blooming flower.
 *
 * Equip the Flower Pot tool and right-click a surface to place one. It is a
 * custom THREE.js mesh (a tapered terracotta pot with a soil top, a green stem
 * with two leaves, and a radial bloom), not a textured cube. The flower colour
 * is chosen deterministically from the pot's coordinates, so every pot keeps a
 * stable look across reloads without any extra networking — and the bloom sways
 * gently in the breeze.
 *
 * Registered as a single `invisible` block (no chunk geometry — the mesh below
 * is the visual) and `passable` so this little ornament never blocks movement.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('FlowerPot', {
	init(api) {
		const ID = api.allocateBlockId()

		// invisible → no chunk mesh (custom mesh below); passable → purely
		// decorative, the player walks straight through it.
		api.registerBlock({
			id: ID,
			name: 'Flower Pot',
			category: 'Crafted',
			invisible: true,
			passable: true,
		})

		// ── Shared materials (never disposed on cull — used by every instance) ──
		const potMat    = new THREE.MeshLambertMaterial({ color: 0xc1440e })   // terracotta
		const rimMat    = new THREE.MeshLambertMaterial({ color: 0x9c360a })   // darker rim
		const soilMat   = new THREE.MeshLambertMaterial({ color: 0x3b2a1d })
		const stemMat   = new THREE.MeshLambertMaterial({ color: 0x3a8a3a })
		const leafMat   = new THREE.MeshLambertMaterial({ color: 0x4caf50 })
		const centerMat = new THREE.MeshLambertMaterial({ color: 0xffd54a, emissive: 0x4a3a00, emissiveIntensity: 0.4 })

		// One bloom colour per template — picked per pot by hashing its key.
		const PETAL_COLORS = [0xe53935, 0xec407a, 0xab47bc, 0xff7043, 0x42a5f5, 0xfafafa]
		const petalMats = PETAL_COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c }))

		// ── Shared geometry (canonical, centred on the cell in XZ, feet at y=0) ──
		// Pot body + rim + soil cap.
		const bodyGeo = new THREE.CylinderGeometry(0.26, 0.18, 0.34, 16)
		bodyGeo.translate(0, 0.17, 0)
		const rimGeo = new THREE.CylinderGeometry(0.29, 0.27, 0.07, 16)
		rimGeo.translate(0, 0.35, 0)
		const soilGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.05, 16)
		soilGeo.translate(0, 0.33, 0)

		// Plant pieces — built relative to the plant group's origin (the soil top,
		// y=0) so the whole bloom can sway about its base.
		const stemGeo = new THREE.CylinderGeometry(0.018, 0.026, 0.5, 8)
		stemGeo.translate(0, 0.25, 0)

		// A leaf: a flattened sphere, tilted outward off the stem.
		function makeLeafGeo(side) {
			const g = new THREE.SphereGeometry(0.07, 8, 6)
			g.scale(1.7, 0.35, 0.9)
			g.rotateZ(side * 0.6)
			g.translate(side * 0.14, 0.2, 0)
			return g
		}
		const leafGeoL = makeLeafGeo(1)
		const leafGeoR = makeLeafGeo(-1)

		const centerGeo = new THREE.SphereGeometry(0.055, 10, 8)
		centerGeo.translate(0, 0.52, 0)

		// One shared petal: a flat oval radiating from the bloom centre.
		const petalGeo = new THREE.SphereGeometry(0.05, 8, 6)
		petalGeo.scale(1.7, 0.45, 1.0)
		const N_PETALS = 6

		// ── One template Group per bloom colour (cheap clones at placement) ───
		// Structure: child[0] = static pot group, child[1] = plant group (sways).
		const templates = petalMats.map((petalMat) => {
			const grp = new THREE.Group()

			const pot = new THREE.Group()
			pot.add(new THREE.Mesh(bodyGeo, potMat))
			pot.add(new THREE.Mesh(rimGeo, rimMat))
			pot.add(new THREE.Mesh(soilGeo, soilMat))
			grp.add(pot)

			const plant = new THREE.Group()
			plant.position.y = 0.35   // pivot at the soil surface
			plant.add(new THREE.Mesh(stemGeo, stemMat))
			plant.add(new THREE.Mesh(leafGeoL, leafMat))
			plant.add(new THREE.Mesh(leafGeoR, leafMat))
			plant.add(new THREE.Mesh(centerGeo, centerMat))
			for (let i = 0; i < N_PETALS; i++) {
				const a = (i / N_PETALS) * Math.PI * 2
				const petal = new THREE.Mesh(petalGeo, petalMat)
				petal.position.set(Math.cos(a) * 0.09, 0.52, Math.sin(a) * 0.09)
				petal.rotation.y = -a
				plant.add(petal)
			}
			grp.add(plant)

			return grp
		})

		// Deterministic per-key hash → stable colour + sway phase per pot.
		function hashKey(k) {
			let h = 0
			for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0
			return Math.abs(h)
		}

		// ── Sync THREE.js meshes to placed flower-pot blocks ──────────────────
		const potMeshes = new Map()   // "x_y_z" → mesh
		let _scanKeys = new Set()
		const _visibleKeys = new Set()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE
		let _t = 0

		api.addTickCallback((dt) => {
			_t += dt

			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (v === ID) _scanKeys.add(k)
			}

			_visibleKeys.clear()
			for (const k of _scanKeys) {
				const [x, y, z] = k.split('_').map(Number)
				if (Math.abs(x - player.pos.x) > CULL_DIST || Math.abs(z - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)

				if (!potMeshes.has(k)) {
					const h = hashKey(k)
					const mesh = templates[h % templates.length].clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					mesh.userData.plant = mesh.children[1]   // sub-group that sways
					mesh.userData.phase = (h % 628) / 100     // 0..2π-ish
					scene.add(mesh)
					potMeshes.set(k, mesh)
				}
			}

			// Gentle breeze: rock each visible bloom about its base.
			for (const k of _visibleKeys) {
				const mesh = potMeshes.get(k)
				const ph = mesh.userData.phase
				const plant = mesh.userData.plant
				plant.rotation.z = Math.sin(_t * 1.6 + ph) * 0.05
				plant.rotation.x = Math.cos(_t * 1.2 + ph) * 0.04
			}

			// Remove meshes for pots mined or left render distance.
			for (const [k, mesh] of potMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					potMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Flower Pot tool: place a pot on the surface you click ─────────────
		api.registerTool({
			name: 'Flower Pot',
			damage: 0,
			draw(ctx, W, H) {
				ctx.clearRect(0, 0, W, H)
				const s = W / 16
				// stem
				ctx.fillStyle = '#3a8a3a'
				ctx.fillRect(7.5 * s, 4 * s, 1 * s, 6 * s)
				// leaves
				ctx.fillStyle = '#4caf50'
				ctx.fillRect(5 * s, 6 * s, 2.5 * s, 1.5 * s)
				ctx.fillRect(8.5 * s, 7 * s, 2.5 * s, 1.5 * s)
				// bloom petals
				ctx.fillStyle = '#e53935'
				ctx.fillRect(6 * s, 2 * s, 4 * s, 4 * s)
				ctx.fillStyle = '#ffd54a'
				ctx.fillRect(7 * s, 3 * s, 2 * s, 2 * s)
				// pot
				ctx.fillStyle = '#9c360a'
				ctx.fillRect(4.5 * s, 10 * s, 7 * s, 1.5 * s)   // rim
				ctx.fillStyle = '#c1440e'
				ctx.beginPath()
				ctx.moveTo(5 * s, 11.5 * s)
				ctx.lineTo(11 * s, 11.5 * s)
				ctx.lineTo(10 * s, 15 * s)
				ctx.lineTo(6 * s, 15 * s)
				ctx.closePath()
				ctx.fill()
			},
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (f.type === ID) return   // don't stack on an existing pot
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied
				ctx.setBlock(bx, by, bz, ID)
			},
		})

		console.log('[FlowerPot] registered id ' + ID)
	},
})
