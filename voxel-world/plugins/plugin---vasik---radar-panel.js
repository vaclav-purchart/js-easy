/**
 * Voxel World Plugin
 *
 * Radar Panel — a flat console like the Control Panel, but topped with a live
 * round radar scope instead of status screens.
 *
 *   • Equip the Radar Panel tool and right-click a surface to place a console.
 *     The scope faces back toward you, ready to watch where you stand.
 *
 * The scope is a shared CanvasTexture redrawn once per frame (so cost is
 * constant no matter how many panels are placed):
 *   • a permanent blue dot in the dead centre,
 *   • a green sweep line rotating forever,
 *   • a fresh red blip spawned every 5 s that flies around the scope for 3 s
 *     before sailing out past the radar range,
 *   • and a "beep beep" every 10 s (Web Audio) whenever a panel is on screen.
 *
 * Registered as an `invisible` solid block — the custom THREE.js mesh below is
 * the only visual. Four orientations, one block ID each, so the facing survives
 * in the world's modified-block diff. Purely client-side — nothing networked.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('RadarPanel', {
	init(api) {
		// One block ID per cardinal facing — (dx,dz) is the direction the scope
		// faces (toward the operator).
		const DIRS = [
			{ dx:  0, dz:  1 },   // scope faces +Z
			{ dx:  1, dz:  0 },   // scope faces +X
			{ dx:  0, dz: -1 },   // scope faces -Z
			{ dx: -1, dz:  0 },   // scope faces -X
		]
		for (const d of DIRS) d.id = api.allocateBlockId()

		const ID_TO_DIR = new Map(DIRS.map((d) => [d.id, d]))
		const ID_SET = new Set(DIRS.map((d) => d.id))

		function dirKey(dx, dz) { return dx + ',' + dz }
		const KEY_TO_ID = new Map(DIRS.map((d) => [dirKey(d.dx, d.dz), d.id]))

		// invisible → no chunk mesh (custom mesh below); solid for collision.
		for (const d of DIRS) {
			api.registerBlock({
				id: d.id,
				name: 'Radar Panel',
				category: 'Crafted',
				invisible: true,
			})
		}

		// ── Static materials (shared, never disposed) ─────────────────────
		const bodyMat = new THREE.MeshLambertMaterial({ color: 0x23282e })
		const trimMat = new THREE.MeshLambertMaterial({ color: 0x3a4450 })
		const bezel   = new THREE.MeshLambertMaterial({ color: 0x10141a })
		const ledRed  = new THREE.MeshLambertMaterial({ color: 0x200505, emissive: 0xff2020, emissiveIntensity: 1.0 })
		const ledGrn  = new THREE.MeshLambertMaterial({ color: 0x052005, emissive: 0x20ff40, emissiveIntensity: 1.0 })

		// ── Radar scope: one shared canvas/texture, redrawn each frame ─────
		const SCOPE = 160
		const scopeCanvas = document.createElement('canvas')
		scopeCanvas.width = scopeCanvas.height = SCOPE
		const sctx = scopeCanvas.getContext('2d')
		const scopeTex = new THREE.CanvasTexture(scopeCanvas)
		scopeTex.minFilter = THREE.LinearFilter
		// MeshBasic → the scope is self-lit (a screen), independent of world light.
		const scopeMat = new THREE.MeshBasicMaterial({ map: scopeTex })

		// ── Canonical geometry, scope facing +Z (operator on the +Z side) ──
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

		// Desk body + work-surface lip + toe-kick trim.
		box(0.92, 0.50, 0.55, 0, 0.25, -0.05, bodyMat)
		box(0.94, 0.06, 0.58, 0, 0.50, -0.05, trimMat)
		box(0.86, 0.12, 0.06, 0, 0.10, 0.24, trimMat)

		// Reclined display board (thin in Z, facing +Z), tilted back.
		const TILT = -0.6
		const cosT = Math.cos(TILT), sinT = Math.sin(TILT)
		const BX = 0, BY = 0.78, BZ = -0.18
		const scopeParts = []   // parts whose mesh needs the live texture material
		function place(w, h, t, lx, ly, oz, mat) {
			const g = new THREE.BoxGeometry(w, h, t)
			g.rotateX(TILT)
			g.translate(BX + lx, BY + ly * cosT - oz * sinT, BZ + ly * sinT + oz * cosT)
			parts.push([g, mat])
			if (mat === scopeMat) scopeParts.push(parts.length - 1)
		}

		place(0.84, 0.50, 0.05, 0, 0, 0, bezel)           // the dark bezel board
		place(0.46, 0.46, 0.02, 0, 0.01, 0.035, scopeMat) // the round radar scope

		// Indicator LEDs + chunky trim buttons on the flat work surface.
		box(0.05, 0.04, 0.05, -0.18, 0.55, 0.18, ledRed)
		box(0.05, 0.04, 0.05,  0.18, 0.55, 0.18, ledGrn)
		box(0.10, 0.05, 0.10, -0.34, 0.55, 0.05, trimMat)
		box(0.10, 0.05, 0.10,  0.34, 0.55, 0.05, trimMat)
		cyl(0.02, 0.025, 0.12, 0.30, 0.59, 0.06, trimMat)  // small joystick stem

		// Build one template Group per facing (cheap clones at placement time).
		const templates = new Map()
		for (const d of DIRS) {
			const grp = new THREE.Group()
			for (const [g, mat] of parts) grp.add(new THREE.Mesh(g, mat))
			grp.rotation.y = Math.atan2(d.dx, d.dz)   // +Z canonical → (dx,dz)
			templates.set(dirKey(d.dx, d.dz), grp)
		}

		// ── Beep beep (Web Audio), created lazily after a user gesture ─────
		let audioCtx = null
		function tone(start, freq, dur) {
			const o = audioCtx.createOscillator()
			const g = audioCtx.createGain()
			o.type = 'square'
			o.frequency.value = freq
			g.gain.setValueAtTime(0.0001, start)
			g.gain.exponentialRampToValueAtTime(0.18, start + 0.01)
			g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
			o.connect(g).connect(audioCtx.destination)
			o.start(start)
			o.stop(start + dur + 0.02)
		}
		function beepBeep() {
			return // skip
			if (!audioCtx) {
				const AC = window.AudioContext || window.webkitAudioContext
				if (!AC) return
				audioCtx = new AC()
			}
			if (audioCtx.state === 'suspended') audioCtx.resume()
			const t0 = audioCtx.currentTime
			tone(t0, 1320, 0.09)
			tone(t0 + 0.16, 1320, 0.09)
		}

		// ── Radar simulation (shared by every placed scope) ────────────────
		// A blip flies around the scope for BLIP_LIFE seconds: its radius grows
		// from the centre out past 1.0 (radar range) while its angle advances,
		// so it spirals out and vanishes off the edge.
		const BLIP_LIFE = 3.0     // seconds on screen
		const SPAWN_EVERY = 5.0   // new red blip cadence
		const BEEP_EVERY = 10.0   // beep beep cadence
		const blips = []          // { age, ang, spin }
		let spawnAcc = SPAWN_EVERY   // spawn one almost immediately
		let beepAcc = 0
		let sweep = 0             // sweep-line angle

		function drawScope() {
			const c = SCOPE / 2, R = c - 6
			sctx.fillStyle = '#02160a'
			sctx.fillRect(0, 0, SCOPE, SCOPE)

			// Round scope face.
			sctx.save()
			sctx.beginPath()
			sctx.arc(c, c, R, 0, Math.PI * 2)
			sctx.clip()
			sctx.fillStyle = '#031c0d'
			sctx.fillRect(0, 0, SCOPE, SCOPE)

			// Range rings + crosshair.
			sctx.strokeStyle = 'rgba(0,255,110,0.35)'
			sctx.lineWidth = 1.5
			for (let i = 1; i <= 3; i++) {
				sctx.beginPath()
				sctx.arc(c, c, (R * i) / 3, 0, Math.PI * 2)
				sctx.stroke()
			}
			sctx.beginPath()
			sctx.moveTo(c - R, c); sctx.lineTo(c + R, c)
			sctx.moveTo(c, c - R); sctx.lineTo(c, c + R)
			sctx.stroke()

			// Rotating sweep — a fading green wedge.
			sctx.save()
			sctx.translate(c, c)
			sctx.rotate(sweep)
			const wedge = sctx.createLinearGradient(0, 0, R, 0)
			wedge.addColorStop(0, 'rgba(0,255,110,0.0)')
			wedge.addColorStop(1, 'rgba(0,255,110,0.45)')
			sctx.fillStyle = wedge
			sctx.beginPath()
			sctx.moveTo(0, 0)
			sctx.arc(0, 0, R, -0.45, 0)
			sctx.closePath()
			sctx.fill()
			sctx.strokeStyle = 'rgba(120,255,170,0.9)'
			sctx.lineWidth = 2
			sctx.beginPath()
			sctx.moveTo(0, 0); sctx.lineTo(R, 0)
			sctx.stroke()
			sctx.restore()

			// Red blips.
			for (const b of blips) {
				const rad = (b.age / BLIP_LIFE) * 1.15   // 0 → past the edge
				const px = c + Math.cos(b.ang) * rad * R
				const py = c + Math.sin(b.ang) * rad * R
				const fade = Math.max(0, 1 - rad * 0.6)
				sctx.fillStyle = 'rgba(255,40,40,' + (0.4 + 0.6 * fade) + ')'
				sctx.shadowColor = '#ff2020'
				sctx.shadowBlur = 8
				sctx.beginPath()
				sctx.arc(px, py, 4, 0, Math.PI * 2)
				sctx.fill()
				sctx.shadowBlur = 0
			}

			// Permanent blue dot dead centre (us).
			sctx.fillStyle = '#46b4ff'
			sctx.shadowColor = '#46b4ff'
			sctx.shadowBlur = 10
			sctx.beginPath()
			sctx.arc(c, c, 5, 0, Math.PI * 2)
			sctx.fill()
			sctx.shadowBlur = 0
			sctx.restore()

			// Bezel ring on top.
			sctx.strokeStyle = '#0a3d1c'
			sctx.lineWidth = 4
			sctx.beginPath()
			sctx.arc(c, c, R, 0, Math.PI * 2)
			sctx.stroke()

			scopeTex.needsUpdate = true
		}

		// ── Per-frame: advance the sim, blink LEDs, redraw the scope ───────
		api.addTickCallback((dt) => {
			// Nothing in range → no scope on screen, so skip the whole sim and
			// (the costly part) the canvas redraw + GPU texture re-upload. The
			// mesh-sync tick below keeps panelMeshes to just the in-range panels,
			// so a radar that's unplaced or out of render distance costs nothing.
			// (One-frame lag when a panel first comes in range is irrelevant; the
			// sim just resumes from where it froze — nobody saw the frozen state.)
			if (panelMeshes.size === 0) return

			// Guard against huge dt after a tab was backgrounded.
			if (dt > 0.25) dt = 0.25

			sweep += dt * 2.4
			beepAcc += dt
			spawnAcc += dt

			if (spawnAcc >= SPAWN_EVERY) {
				spawnAcc -= SPAWN_EVERY
				blips.push({ age: 0, ang: Math.random() * Math.PI * 2, spin: (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random()) })
			}
			for (let i = blips.length - 1; i >= 0; i--) {
				const b = blips[i]
				b.age += dt
				b.ang += b.spin * dt   // fly around while drifting outward
				if (b.age >= BLIP_LIFE) blips.splice(i, 1)
			}

			if (beepAcc >= BEEP_EVERY) {
				beepAcc -= BEEP_EVERY
				if (panelMeshes.size > 0) beepBeep()   // only nag when a scope is up
			}

			const t = performance.now() / 1000
			ledRed.emissiveIntensity = Math.sin(t * 5.0) > 0 ? 1.5 : 0.15
			ledGrn.emissiveIntensity = Math.sin(t * 5.0 + Math.PI) > 0 ? 1.5 : 0.15

			drawScope()
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

		// ── Radar Panel tool: place a console facing back toward you ───────
		function drawIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)
			const s = W / 16
			// desk body
			ctx.fillStyle = '#23282e'
			ctx.fillRect(2 * s, 9 * s, 12 * s, 6 * s)
			// bezel board
			ctx.fillStyle = '#10141a'
			ctx.fillRect(3 * s, 2 * s, 10 * s, 7 * s)
			// round scope
			ctx.fillStyle = '#031c0d'
			ctx.beginPath(); ctx.arc(8 * s, 5.5 * s, 3.4 * s, 0, Math.PI * 2); ctx.fill()
			ctx.strokeStyle = '#00ff6e'; ctx.lineWidth = Math.max(1, s * 0.4)
			ctx.beginPath(); ctx.arc(8 * s, 5.5 * s, 3.4 * s, 0, Math.PI * 2); ctx.stroke()
			ctx.beginPath(); ctx.arc(8 * s, 5.5 * s, 1.7 * s, 0, Math.PI * 2); ctx.stroke()
			// sweep
			ctx.strokeStyle = '#9effc0'
			ctx.beginPath(); ctx.moveTo(8 * s, 5.5 * s); ctx.lineTo(11 * s, 4 * s); ctx.stroke()
			// blue centre + red blip
			ctx.fillStyle = '#46b4ff'; ctx.beginPath(); ctx.arc(8 * s, 5.5 * s, 0.9 * s, 0, Math.PI * 2); ctx.fill()
			ctx.fillStyle = '#ff2020'; ctx.beginPath(); ctx.arc(6 * s, 4 * s, 0.8 * s, 0, Math.PI * 2); ctx.fill()
			// LED row
			ctx.fillStyle = '#ff2020'; ctx.fillRect(5 * s, 10 * s, 1 * s, 1 * s)
			ctx.fillStyle = '#20ff40'; ctx.fillRect(10 * s, 10 * s, 1 * s, 1 * s)
		}
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = iconCanvas.height = 64
		drawIcon(iconCanvas.getContext('2d'), 64, 64)

		api.registerTool({
			name: 'Radar Panel',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (ID_SET.has(f.type)) return
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

				// Scope faces back toward the player (nearest cardinal opposite of
				// the look direction), so it's ready to watch where you stand.
				const dir = new THREE.Vector3()
				camera.getWorldDirection(dir)
				let dx = 0, dz = 0
				if (Math.abs(dir.x) >= Math.abs(dir.z)) dx = -(Math.sign(dir.x) || 1)
				else dz = -(Math.sign(dir.z) || 1)

				ctx.setBlock(bx, by, bz, KEY_TO_ID.get(dirKey(dx, dz)))
			},
		})

		console.log('[RadarPanel] registered ids ' + DIRS.map((d) => d.id).join(','))
	},
})
