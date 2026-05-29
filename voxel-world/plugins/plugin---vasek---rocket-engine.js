/**
 * Voxel World Plugin
 *
 * Rocket Engine — a real-looking liquid-fuel engine with a bell nozzle.
 *
 *   • Equip the Rocket Engine tool and right-click a surface. The engine mounts
 *     against that surface and its nozzle fires AWAY from it (click the underside
 *     of a hull → engine hangs below, thrusting down; click a wall → it points
 *     sideways). All six directions are supported.
 *   • Right-click an engine (any tool) to ignite — the exhaust plume flares for
 *     a moment.
 *
 * Each engine is a detailed THREE.js model: a gimbal mount plate, twin
 * turbopumps, wrap-around plumbing and fuel lines, a combustion chamber and a
 * flared copper bell nozzle with rib rings, a glowing throat, and an additive
 * exhaust plume + inner glow. Registered as an `invisible` solid block — the
 * mesh below is the only visual.
 *
 * Six orientations (one block ID each, keyed by the mount normal) so the facing
 * survives in the world's modified-block diff. Engines are template clones with a
 * static transform; the glowing exhaust uses shared materials animated once per
 * tick, so cost stays low even with a whole cluster of them. Purely client-side.
 */

/* global VoxelWorld, THREE, modified, scene, player, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('RocketEngine', {
	init(api) {
		// One block ID per mount normal. n = the direction the nozzle fires
		// (away from the clicked surface); rot reorients the canonical model,
		// which is built firing DOWN (-Y), so its thrust points along n.
		const DIRS = [
			{ n: [ 0, -1,  0], rot: [0, 0, 0] },                 // fire -Y (down) — canonical
			{ n: [ 0,  1,  0], rot: [Math.PI, 0, 0] },           // fire +Y (up)
			{ n: [ 0,  0,  1], rot: [-Math.PI / 2, 0, 0] },      // fire +Z
			{ n: [ 0,  0, -1], rot: [ Math.PI / 2, 0, 0] },      // fire -Z
			{ n: [ 1,  0,  0], rot: [0, 0,  Math.PI / 2] },      // fire +X
			{ n: [-1,  0,  0], rot: [0, 0, -Math.PI / 2] },      // fire -X
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function nKey(nx, ny, nz) { return nx + ',' + ny + ',' + nz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [nKey(...d.n), d.id]))

		// ── Register the six engine block types ───────────────────────────
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Rocket Engine',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Materials ─────────────────────────────────────────────────────
		// Metals are shared & static. The exhaust glow materials are shared but
		// their opacity/intensity is animated globally each tick (with ignite boost).
		const darkMat = new THREE.MeshLambertMaterial({ color: 0x2b3038 })
		const bodyMat = new THREE.MeshLambertMaterial({ color: 0x4a5560 })
		const pipeMat = new THREE.MeshLambertMaterial({ color: 0x707880 })
		const bellMat = new THREE.MeshLambertMaterial({ color: 0x9c6a3a, side: THREE.DoubleSide })   // copper bell
		const ribMat  = new THREE.MeshLambertMaterial({ color: 0x6e4a28 })
		const throatMat = new THREE.MeshLambertMaterial({ color: 0x1a0d04, emissive: 0xff7a20, emissiveIntensity: 1.2 })
		const glowMat  = new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
		const plumeMat = new THREE.MeshBasicMaterial({ color: 0xaad4ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })

		// ── Canonical geometry, firing DOWN (-Y) ──────────────────────────
		// Authored in unit space (nozzle exit y≈0.05, mount plate y≈0.96), then
		// SCALE'd up and shifted so the mount plate sits at the group origin
		// (local y=0). The group is placed at the centre of the clicked face, so
		// the oversized engine hangs off the surface and its bell + plume extend
		// outward instead of clipping through the placement cell.
		const SCALE = 1.8           // overall size multiplier
		const ANCHOR = 0.96         // unit-space Y of the mount plate → becomes y=0
		const parts = []
		function add(geo, mat) { parts.push([geo, mat]) }
		function box(w, h, d, x, y, z, mat) {
			const g = new THREE.BoxGeometry(w * SCALE, h * SCALE, d * SCALE)
			g.translate(x * SCALE, (y - ANCHOR) * SCALE, z * SCALE); add(g, mat)
		}
		function cyl(rt, rb, h, x, y, z, mat, open) {
			const g = new THREE.CylinderGeometry(rt * SCALE, rb * SCALE, h * SCALE, 18, 1, !!open)
			g.translate(x * SCALE, (y - ANCHOR) * SCALE, z * SCALE); add(g, mat)
		}
		function ring(r, tube, x, y, z, mat) {
			const g = new THREE.TorusGeometry(r * SCALE, tube * SCALE, 8, 22); g.rotateX(Math.PI / 2)
			g.translate(x * SCALE, (y - ANCHOR) * SCALE, z * SCALE); add(g, mat)
		}
		function sphere(r, x, y, z, mat) {
			const g = new THREE.SphereGeometry(r * SCALE, 14, 12)
			g.translate(x * SCALE, (y - ANCHOR) * SCALE, z * SCALE); add(g, mat)
		}

		// Gimbal mount plate + ring (attaches to the hull).
		box(0.66, 0.08, 0.66, 0, 0.96, 0, darkMat)
		ring(0.26, 0.04, 0, 0.88, 0, bodyMat)
		sphere(0.18, 0, 0.78, 0, bodyMat)                 // injector dome

		// Combustion chamber + wrap-around plumbing.
		cyl(0.17, 0.17, 0.22, 0, 0.64, 0, bodyMat)
		ring(0.18, 0.022, 0, 0.62, 0, pipeMat)
		ring(0.18, 0.022, 0, 0.70, 0, pipeMat)

		// Twin turbopumps on the sides + their fuel lines down to the nozzle.
		for (const sx of [-1, 1]) {
			cyl(0.07, 0.07, 0.20, sx * 0.26, 0.66, 0, pipeMat)
			sphere(0.075, sx * 0.26, 0.77, 0, bodyMat)
			cyl(0.022, 0.022, 0.42, sx * 0.275, 0.40, 0.0, pipeMat)   // fuel line
			cyl(0.022, 0.022, 0.42, 0.0, 0.40, sx * 0.275, pipeMat)   // cross fuel line
		}

		// Throat (glowing) → flared bell nozzle with rib rings.
		ring(0.11, 0.025, 0, 0.51, 0, throatMat)
		cyl(0.13, 0.40, 0.46, 0, 0.28, 0, bellMat, true)   // open-ended bell
		ring(0.205, 0.02, 0, 0.42, 0, ribMat)
		ring(0.30,  0.02, 0, 0.22, 0, ribMat)
		ring(0.385, 0.02, 0, 0.07, 0, ribMat)

		// Inner glow cone (sits just inside the bell).
		const innerGlow = new THREE.CylinderGeometry(0.10 * SCALE, 0.34 * SCALE, 0.42 * SCALE, 18, 1, true)
		innerGlow.translate(0, (0.27 - ANCHOR) * SCALE, 0); add(innerGlow, glowMat)

		// Exhaust flame — a long tapering cone from the nozzle exit, in WORLD
		// units so the length is independent of SCALE. Two layers: a translucent
		// blue outer plume and a brighter orange inner core.
		const yExit = (0.05 - ANCHOR) * SCALE       // nozzle exit in group-local space
		const FLAME_LEN = 3.0                        // blocks
		const plume = new THREE.CylinderGeometry(0.30 * SCALE, 0.03 * SCALE, FLAME_LEN, 18, 1, true)
		plume.translate(0, yExit - FLAME_LEN / 2, 0); add(plume, plumeMat)
		const flameCore = new THREE.CylinderGeometry(0.16 * SCALE, 0.02 * SCALE, FLAME_LEN * 0.7, 16, 1, true)
		flameCore.translate(0, yExit - FLAME_LEN * 0.7 / 2, 0); add(flameCore, glowMat)

		// Build one template Group per direction (cheap clones at placement time).
		const templates = new Map()
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const [g, mat] of parts) grp.add(new THREE.Mesh(g, mat))
			grp.rotation.set(d.rot[0], d.rot[1], d.rot[2])
			templates.set(nKey(...d.n), grp)
		}

		// ── Ignite state (global; right-click flares every visible plume) ──
		let igniteUntil = 0

		// Animate the shared exhaust materials once per frame (flicker + ignite).
		api.addTickCallback(() => {
			const t = performance.now()
			const boost = t < igniteUntil ? 1.0 : 0.0
			// Layered sines → a lively, non-repetitive flicker without Math.random.
			const flick = 0.5 + 0.25 * Math.sin(t / 90) + 0.15 * Math.sin(t / 37 + 1.3) + 0.1 * Math.sin(t / 210)
			plumeMat.opacity = (0.18 + 0.22 * flick) + boost * 0.55
			glowMat.opacity  = (0.40 + 0.25 * flick) + boost * 0.35
			throatMat.emissiveIntensity = (1.0 + 0.5 * flick) + boost * 1.2
		})

		// ── Sync THREE.js engines to placed blocks ────────────────────────
		const engineMeshes = new Map()   // "x_y_z" → mesh
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

				if (!engineMeshes.has(k)) {
					const d = ID_TO_DIR.get(modified.get(k))
					const [nx, ny, nz] = d.n
					const mesh = templates.get(nKey(...d.n)).clone()
					// Anchor at the centre of the mounting face (cell centre shifted
					// half a block back along the fire direction), so the mount plate
					// sits flush against the surface and the engine hangs outward.
					mesh.position.set(x + 0.5 - 0.5 * nx, y + 0.5 - 0.5 * ny, z + 0.5 - 0.5 * nz)
					scene.add(mesh)
					engineMeshes.set(k, mesh)
				}
			}

			// Remove meshes for engines mined or left render distance.
			for (const [k, mesh] of engineMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					engineMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Right-click an engine → ignite ────────────────────────────────
		api.registerBlockInteraction([...ID_SET], (ctx) => {
			const f = ctx.facing
			if (!f || !ID_SET.has(f.type)) return
			igniteUntil = performance.now() + 1400
			showToast('🚀 Ignition! Main engine start')
		})

		// ── Rocket Engine tool: place an engine firing away from the surface ──
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// machinery block (top)
			ctx.fillStyle = '#4a5560'
			ctx.fillRect(5 * s, 1 * s, 6 * s, 5 * s)
			ctx.fillStyle = '#707880'
			ctx.fillRect(3 * s, 2 * s, 2 * s, 3 * s)
			ctx.fillRect(11 * s, 2 * s, 2 * s, 3 * s)
			// copper bell nozzle (trapezoid)
			ctx.fillStyle = '#9c6a3a'
			ctx.beginPath()
			ctx.moveTo(6 * s, 6 * s); ctx.lineTo(10 * s, 6 * s)
			ctx.lineTo(13 * s, 13 * s); ctx.lineTo(3 * s, 13 * s)
			ctx.closePath(); ctx.fill()
			// glowing throat + plume
			ctx.fillStyle = '#ff7a20'
			ctx.fillRect(7 * s, 6 * s, 2 * s, 1 * s)
			ctx.fillStyle = '#aad4ff'
			ctx.beginPath()
			ctx.moveTo(5 * s, 13 * s); ctx.lineTo(11 * s, 13 * s)
			ctx.lineTo(8 * s, 16 * s); ctx.closePath(); ctx.fill()
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Rocket Engine',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (ID_SET.has(f.type)) return   // right-clicking an engine ignites it instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Nozzle fires along the clicked face normal (away from the hull).
				const id = KEY_TO_ID.get(nKey(f.nx, f.ny, f.nz))
				if (id === undefined) return   // safety: only the six axis normals are valid
				ctx.setBlock(bx, by, bz, id)
			},
		})

		console.log('[RocketEngine] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
