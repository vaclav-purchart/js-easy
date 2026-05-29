/**
 * Voxel World Plugin
 *
 * Nuclear Reactor — a glowing reactor core for your rocket's power plant.
 *
 *   • Equip the Reactor tool and right-click a surface to place a reactor.
 *   • Right-click a reactor (any tool) to trigger a power surge — the core
 *     flares and the room floods with light for a moment.
 *
 * The core is a pulsing emissive sphere wrapped in an additive glow halo, ringed
 * by six containment struts and a spinning gyroscope of energy rings, with three
 * glowing control rods on top. A real THREE.PointLight lives inside each core, so
 * the reactor actually lights up nearby terrain (green, pulsing). Registered as
 * an `invisible` solid block — the custom THREE.js mesh below is the only visual.
 *
 * Radially symmetric, so a single block ID (no orientations). Per-reactor pieces
 * (the spinner and the point light) are animated individually; the emissive
 * materials are shared and animated once per tick. Purely client-side.
 */

/* global VoxelWorld, THREE, modified, scene, player, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('Reactor', {
	init(api) {
		const REACTOR = api.allocateBlockId()

		api.registerBlock({
			id: REACTOR,
			name: 'Nuclear Reactor',
			category: 'Crafted',
			invisible: true,
		})

		// ── Materials ─────────────────────────────────────────────────────
		// Static metals are shared & static. Glow materials are shared but their
		// emissiveIntensity is animated globally each tick (with a surge multiplier).
		const metalMat = new THREE.MeshLambertMaterial({ color: 0x2b3038 })
		const trimMat  = new THREE.MeshLambertMaterial({ color: 0x4a5560 })
		const coreMat  = new THREE.MeshLambertMaterial({ color: 0x041a0a, emissive: 0x35ff70, emissiveIntensity: 1.4 })
		const haloMat  = new THREE.MeshBasicMaterial({ color: 0x35ff70, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
		const ringMat  = new THREE.MeshLambertMaterial({ color: 0x042022, emissive: 0x00e0ff, emissiveIntensity: 1.2 })
		const rodMat   = new THREE.MeshLambertMaterial({ color: 0x1d3a12, emissive: 0x9bff3a, emissiveIntensity: 1.0 })

		// ── Shared geometry ───────────────────────────────────────────────
		const plinthGeo = new THREE.CylinderGeometry(0.42, 0.47, 0.12, 16); plinthGeo.translate(0, 0.06, 0)
		const capGeo    = new THREE.CylinderGeometry(0.24, 0.30, 0.10, 16); capGeo.translate(0, 0.98, 0)
		const ringTorusGeo = new THREE.TorusGeometry(0.40, 0.04, 8, 22); ringTorusGeo.rotateX(Math.PI / 2)
		const strutGeo  = new THREE.CylinderGeometry(0.035, 0.035, 0.84, 8)
		const coreGeo   = new THREE.SphereGeometry(0.20, 18, 18); coreGeo.translate(0, 0.55, 0)
		const haloGeo   = new THREE.SphereGeometry(0.30, 16, 16); haloGeo.translate(0, 0.55, 0)
		const gyroGeo   = new THREE.TorusGeometry(0.31, 0.025, 6, 26)
		const nodeGeo   = new THREE.SphereGeometry(0.05, 8, 8)
		const ctrlRodGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.28, 8)
		const ctrlTipGeo = new THREE.SphereGeometry(0.05, 8, 8)

		// ── Build the static (non-spinning) part of a reactor into a group ──
		function buildStatic(g) {
			g.add(new THREE.Mesh(plinthGeo, metalMat))
			g.add(new THREE.Mesh(capGeo, metalMat))

			// Top & bottom containment rings.
			const rTop = new THREE.Mesh(ringTorusGeo, trimMat); rTop.position.y = 0.92; g.add(rTop)
			const rBot = new THREE.Mesh(ringTorusGeo, trimMat); rBot.position.y = 0.16; g.add(rBot)

			// Six vertical containment struts around the core.
			for (let i = 0; i < 6; i++) {
				const a = (i / 6) * Math.PI * 2
				const s = new THREE.Mesh(strutGeo, trimMat)
				s.position.set(Math.cos(a) * 0.40, 0.54, Math.sin(a) * 0.40)
				g.add(s)
			}

			// Glowing core + additive halo.
			g.add(new THREE.Mesh(coreGeo, coreMat))
			g.add(new THREE.Mesh(haloGeo, haloMat))

			// Three control rods poking out of the top cap.
			for (let i = 0; i < 3; i++) {
				const a = (i / 3) * Math.PI * 2
				const x = Math.cos(a) * 0.12, z = Math.sin(a) * 0.12
				const rod = new THREE.Mesh(ctrlRodGeo, metalMat)
				rod.position.set(x, 1.17, z); g.add(rod)
				const tip = new THREE.Mesh(ctrlTipGeo, rodMat)
				tip.position.set(x, 1.33, z); g.add(tip)
			}
		}

		// ── Build the spinning gyroscope subgroup (rotated each frame) ──────
		function buildSpinner() {
			const sp = new THREE.Group()
			sp.position.y = 0.55
			const t1 = new THREE.Mesh(gyroGeo, ringMat); t1.rotation.x = Math.PI / 2.6; sp.add(t1)
			const t2 = new THREE.Mesh(gyroGeo, ringMat); t2.rotation.x = Math.PI / 2.6; t2.rotation.z = Math.PI / 2; sp.add(t2)
			for (let i = 0; i < 4; i++) {
				const a = (i / 4) * Math.PI * 2
				const n = new THREE.Mesh(nodeGeo, ringMat)
				n.position.set(Math.cos(a) * 0.31, 0, Math.sin(a) * 0.31)
				sp.add(n)
			}
			return sp
		}

		// ── Power-surge state (global; right-click flares every visible core) ──
		let surgeUntil = 0

		// Animate the shared glow materials once per frame.
		api.addTickCallback(() => {
			const t = performance.now()
			const surge = t < surgeUntil ? 2.2 : 1.0
			const pulse = 1.2 + 0.5 * Math.sin(t / 1000 * 2.4) + 0.15 * Math.sin(t / 1000 * 11)
			coreMat.emissiveIntensity = pulse * surge
			haloMat.opacity = (0.30 + 0.12 * Math.sin(t / 1000 * 2.4)) * surge
			ringMat.emissiveIntensity = 1.0 + 0.4 * Math.sin(t / 1000 * 3.3)
			rodMat.emissiveIntensity = 0.8 + 0.3 * Math.sin(t / 1000 * 5.0)
		})

		// ── Sync THREE.js reactors to placed blocks + per-instance animation ──
		const reactors = new Map()   // "x_y_z" → { group, spinner, light }
		let _scanKeys = new Set()
		const _visibleKeys = new Set()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE

		api.addTickCallback((dt) => {
			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (v === REACTOR) _scanKeys.add(k)
			}

			_visibleKeys.clear()
			for (const k of _scanKeys) {
				const [x, y, z] = k.split('_').map(Number)
				if (Math.abs(x - player.pos.x) > CULL_DIST || Math.abs(z - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)

				if (!reactors.has(k)) {
					const group = new THREE.Group()
					group.position.set(x + 0.5, y, z + 0.5)
					buildStatic(group)
					const spinner = buildSpinner()
					group.add(spinner)
					// Real light inside the core — makes the reactor glow on nearby terrain.
					const light = new THREE.PointLight(0x44ff80, 1.4, 7, 2)
					light.position.y = 0.55
					group.add(light)
					scene.add(group)
					reactors.set(k, { group, spinner, light })
				}
			}

			// Animate + remove.
			const t = performance.now()
			const surge = t < surgeUntil ? 2.4 : 1.0
			const lightPulse = (1.1 + 0.5 * Math.sin(t / 1000 * 2.4)) * surge
			for (const [k, r] of reactors) {
				if (!_visibleKeys.has(k)) {
					scene.remove(r.group)   // children (light, spinner) go with it; shared geo/mats kept
					reactors.delete(k)
					continue
				}
				r.spinner.rotation.y += dt * 1.6
				r.spinner.rotation.x = Math.sin(t / 1000 * 0.7) * 0.25
				r.light.intensity = lightPulse
			}
		})

		// ── Right-click a reactor → power surge + status toast ─────────────
		api.registerBlockInteraction([REACTOR], (ctx) => {
			const f = ctx.facing
			if (!f || f.type !== REACTOR) return
			surgeUntil = performance.now() + 1200
			showToast('☢ Reactor surge — 1.21 GW online!')
		})

		// ── Reactor tool: place a reactor ──────────────────────────────────
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// containment shell
			ctx.fillStyle = '#2b3038'
			ctx.fillRect(3 * s, 2 * s, 10 * s, 13 * s)
			ctx.fillStyle = '#4a5560'
			ctx.fillRect(3 * s, 2 * s, 1 * s, 13 * s)
			ctx.fillRect(12 * s, 2 * s, 1 * s, 13 * s)
			// glowing core
			ctx.fillStyle = '#35ff70'
			ctx.beginPath(); ctx.arc(8 * s, 8 * s, 3.2 * s, 0, Math.PI * 2); ctx.fill()
			ctx.fillStyle = '#d8ffe6'
			ctx.beginPath(); ctx.arc(8 * s, 8 * s, 1.4 * s, 0, Math.PI * 2); ctx.fill()
			// control-rod tips
			ctx.fillStyle = '#9bff3a'
			ctx.fillRect(5 * s, 1 * s, 1 * s, 1 * s)
			ctx.fillRect(8 * s, 1 * s, 1 * s, 1 * s)
			ctx.fillRect(11 * s, 1 * s, 1 * s, 1 * s)
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Reactor',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (f.type === REACTOR) return   // right-clicking a reactor surges it instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied
				ctx.setBlock(bx, by, bz, REACTOR)
			},
		})

		console.log('[Reactor] registered id ' + REACTOR)
	},
})
