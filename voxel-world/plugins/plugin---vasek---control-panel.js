/**
 * Voxel World Plugin
 *
 * Rocket Control Panel — a flat futuristic console for your cockpit.
 *
 *   • Equip the Control Panel tool and right-click a surface to place a console.
 *     The screen faces back toward you, so it's ready to operate where you stand
 *     (pair it with the Captain Chair in front of the seat).
 *   • Right-click the console (any tool) for a rotating status readout.
 *
 * A waist-high dark-metal desk with a reclined display board: animated green /
 * cyan / amber screens, a blinking red+green indicator row, and a small glowing
 * joystick. The screens pulse and the LEDs blink every frame (shared emissive
 * materials animated once per tick, so cost is independent of how many panels
 * are placed). Registered as an `invisible` solid block — the custom THREE.js
 * mesh below is the only visual.
 *
 * Four orientations, one block ID each, so the facing survives in the world's
 * modified-block diff like any other block. Purely client-side — nothing networked.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, RENDER_DISTANCE, CHUNK_SIZE, showToast */

VoxelWorld.registerPlugin('ControlPanel', {
	init(api) {
		// One block ID per cardinal facing — (dx,dz) is the direction the screen
		// faces (toward the operator).
		const DIRS = [
			{ dx:  0, dz:  1 },   // screen faces +Z
			{ dx:  1, dz:  0 },   // screen faces +X
			{ dx:  0, dz: -1 },   // screen faces -Z
			{ dx: -1, dz:  0 },   // screen faces -X
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function dirKey(dx, dz) { return dx + ',' + dz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [dirKey(d.dx, d.dz), d.id]))

		// ── Register the four panel block types ───────────────────────────
		// invisible → no chunk mesh (custom mesh below); solid for collision.
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Control Panel',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Materials ─────────────────────────────────────────────────────
		// Static ones are shared and never disposed. The glow materials are also
		// shared, but their emissiveIntensity is animated globally each tick.
		const bodyMat  = new THREE.MeshLambertMaterial({ color: 0x23282e })
		const trimMat  = new THREE.MeshLambertMaterial({ color: 0x3a4450 })
		const boardMat = new THREE.MeshLambertMaterial({ color: 0x161a1f })

		const scrGreen = new THREE.MeshLambertMaterial({ color: 0x031a0c, emissive: 0x00ff66, emissiveIntensity: 1.0 })
		const scrCyan  = new THREE.MeshLambertMaterial({ color: 0x041e22, emissive: 0x00d8ff, emissiveIntensity: 1.0 })
		const scrAmber = new THREE.MeshLambertMaterial({ color: 0x221603, emissive: 0xffaa20, emissiveIntensity: 1.0 })
		const ledRed   = new THREE.MeshLambertMaterial({ color: 0x200505, emissive: 0xff2020, emissiveIntensity: 1.0 })
		const ledGreen = new THREE.MeshLambertMaterial({ color: 0x052005, emissive: 0x20ff40, emissiveIntensity: 1.0 })
		const knobMat  = new THREE.MeshLambertMaterial({ color: 0x06323b, emissive: 0x00d8ff, emissiveIntensity: 1.2 })

		// ── Canonical geometry, screen facing +Z (operator on the +Z side) ────
		// Centred on the cell in XZ; feet at y=0. Each piece is [geometry, material].
		const parts = []
		function box(w, h, d, x, y, z, mat) {
			const g = new THREE.BoxGeometry(w, h, d)
			g.translate(x, y, z)
			parts.push([g, mat])
		}
		function cyl(rt, rb, h, x, y, z, mat) {
			const g = new THREE.CylinderGeometry(rt, rb, h, 10)
			g.translate(x, y, z)
			parts.push([g, mat])
		}

		// Desk body + front kick panel + flat work surface lip.
		box(0.92, 0.50, 0.55, 0, 0.25, -0.05, bodyMat)
		box(0.94, 0.06, 0.58, 0, 0.50, -0.05, trimMat)   // surface lip
		box(0.86, 0.12, 0.06, 0, 0.10, 0.24, trimMat)    // toe-kick trim (front)

		// Reclined display board: built in the XY plane (thin in Z, facing +Z),
		// tilted back so the screen faces up + toward the operator, then moved
		// onto the back of the desk. Screens sit just proud of the board.
		const TILT = -0.6
		const cosT = Math.cos(TILT), sinT = Math.sin(TILT)
		const BX = 0, BY = 0.78, BZ = -0.18   // display centre on the desk
		// place(w,h,t, lx,ly, oz, mat): a piece at local board coords (lx,ly),
		// pushed oz out along the board's normal, sharing the board's tilt.
		function place(w, h, t, lx, ly, oz, mat) {
			const g = new THREE.BoxGeometry(w, h, t)
			g.rotateX(TILT)
			g.translate(BX + lx, BY + ly * cosT - oz * sinT, BZ + ly * sinT + oz * cosT)
			parts.push([g, mat])
		}

		place(0.84, 0.50, 0.05, 0, 0, 0, boardMat)        // the board itself
		place(0.46, 0.30, 0.02, -0.17, 0.03, 0.035, scrGreen)  // main screen
		place(0.24, 0.18, 0.02,  0.21, 0.07, 0.035, scrCyan)   // aux screen
		place(0.24, 0.10, 0.02,  0.21, -0.10, 0.035, scrAmber) // small readout
		place(0.70, 0.04, 0.02,  0, -0.20, 0.035, scrAmber)    // status ticker

		// Indicator LED row + buttons on the flat work surface (front edge).
		const ledMats = [ledRed, ledGreen, ledRed, ledGreen, ledRed]
		for (let i = 0; i < 5; i++) {
			box(0.05, 0.04, 0.05, -0.30 + i * 0.10, 0.55, 0.18, ledMats[i])
		}
		// A couple of chunky trim buttons.
		box(0.10, 0.05, 0.10, -0.34, 0.55, 0.05, trimMat)
		box(0.10, 0.05, 0.10,  0.34, 0.55, 0.05, trimMat)

		// Glowing joystick on the right of the desk.
		cyl(0.02, 0.025, 0.14, 0.30, 0.60, 0.06, trimMat)
		box(0.07, 0.07, 0.07, 0.30, 0.69, 0.06, knobMat)

		// Build one template Group per facing (cheap clones at placement time).
		const templates = new Map()
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const [g, mat] of parts) grp.add(new THREE.Mesh(g, mat))
			grp.rotation.y = Math.atan2(d.dx, d.dz)   // +Z canonical → (dx,dz)
			templates.set(dirKey(d.dx, d.dz), grp)
		}

		// ── Animate the glow materials once per frame (shared → all panels in
		// sync; cost is constant regardless of how many are placed). ──────────
		api.addTickCallback(() => {
			const t = performance.now() / 1000
			scrGreen.emissiveIntensity = 0.8 + 0.4 * Math.sin(t * 2.0)
			scrCyan.emissiveIntensity  = 0.8 + 0.4 * Math.sin(t * 3.1 + 1.0)
			scrAmber.emissiveIntensity = 0.9 + 0.2 * Math.sin(t * 7.0)        // faster flicker
			ledRed.emissiveIntensity   = Math.sin(t * 5.0) > 0 ? 1.5 : 0.15   // discrete blink
			ledGreen.emissiveIntensity = Math.sin(t * 5.0 + Math.PI) > 0 ? 1.5 : 0.15
			knobMat.emissiveIntensity  = 1.0 + 0.3 * Math.sin(t * 2.5)
		})

		// ── Sync THREE.js meshes to placed panel blocks ───────────────────
		const panelMeshes = new Map()   // "x_y_z" → mesh
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

				if (!panelMeshes.has(k)) {
					const d = ID_TO_DIR.get(modified.get(k))
					const mesh = templates.get(dirKey(d.dx, d.dz)).clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					scene.add(mesh)
					panelMeshes.set(k, mesh)
				}
			}

			// Remove meshes for panels mined or left render distance.
			for (const [k, mesh] of panelMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					panelMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}
		})

		// ── Right-click a panel for a rotating status readout (no state) ──
		const STATUS = [
			'🚀 All systems nominal',
			'⛽ Fuel: 100%  ·  O₂: 100%',
			'🛰 Nav lock acquired',
			'🌡 Reactor temp stable',
			'📡 Telemetry uplink green',
		]
		let _statusIdx = 0
		api.registerBlockInteraction([...ID_SET], (ctx) => {
			const f = ctx.facing
			if (!f || !ID_SET.has(f.type)) return
			showToast(STATUS[_statusIdx % STATUS.length])
			_statusIdx++
		})

		// ── Control Panel tool: place a console facing back toward you ────
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// desk body
			ctx.fillStyle = '#23282e'
			ctx.fillRect(2 * s, 9 * s, 12 * s, 6 * s)
			// reclined board
			ctx.fillStyle = '#161a1f'
			ctx.fillRect(3 * s, 2 * s, 10 * s, 7 * s)
			// screens
			ctx.fillStyle = '#00ff66'; ctx.fillRect(4 * s, 3 * s, 5 * s, 3 * s)
			ctx.fillStyle = '#00d8ff'; ctx.fillRect(10 * s, 3 * s, 2 * s, 2 * s)
			ctx.fillStyle = '#ffaa20'; ctx.fillRect(4 * s, 7 * s, 8 * s, 1 * s)
			// LED row
			ctx.fillStyle = '#ff2020'; ctx.fillRect(4 * s, 10 * s, 1 * s, 1 * s)
			ctx.fillStyle = '#20ff40'; ctx.fillRect(6 * s, 10 * s, 1 * s, 1 * s)
			ctx.fillStyle = '#ff2020'; ctx.fillRect(8 * s, 10 * s, 1 * s, 1 * s)
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Control Panel',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (ID_SET.has(f.type)) return   // right-clicking a panel shows status instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Screen faces back toward the player: opposite of the look direction
				// (nearest cardinal), so the console is ready to operate where you stand.
				const dir = new THREE.Vector3()
				camera.getWorldDirection(dir)
				let dx = 0, dz = 0
				if (Math.abs(dir.x) >= Math.abs(dir.z)) dx = -(Math.sign(dir.x) || 1)
				else dz = -(Math.sign(dir.z) || 1)

				ctx.setBlock(bx, by, bz, KEY_TO_ID.get(dirKey(dx, dz)))
			},
		})

		console.log('[ControlPanel] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
