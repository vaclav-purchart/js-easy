/**
 * Voxel World Plugin
 *
 * Elevator — a floor pad that whisks you vertically between floors of a shaft.
 *
 *   • Equip the Elevator tool and right-click a surface to place a floor pad.
 *   • Stack pads in the SAME vertical column (same X,Z, different Y) — each pad
 *     is one floor of that shaft.
 *   • Stand on a pad, look down and right-click it to open the floor selector.
 *   • Pick a target floor and you glide smoothly up/down the shaft to it.
 *
 * Floors are derived purely from pad positions — every pad sharing the clicked
 * pad's X,Z column is a floor, numbered bottom→top (Floor 1 = lowest). Nothing
 * extra is persisted: the pads themselves already sync as ordinary placed
 * blocks, so this is a browser-only plugin with no server changes.
 *
 * The ride takes over vertical motion for its duration: each tick the plugin
 * snaps the player to the shaft centre, interpolates Y with an ease-in-out
 * curve and zeroes velocity, so gravity and WASD can't fight the lift. Tick
 * callbacks fire after the main loop's physics + camera sync, so the override
 * wins for the frame — but we re-copy player.pos into yawObject ourselves to
 * keep the camera glued to the cabin (the loop already synced it pre-tick).
 */

/* global VoxelWorld, THREE, modified, player, yawObject */

VoxelWorld.registerPlugin('Elevator', {
	init(api) {
		const ELEVATOR = api.allocateBlockId()

		const RIDE_SPEED = 6        // blocks/sec — sets ride duration from distance
		const RIDE_MIN_DUR = 0.4    // seconds — floor (so short hops still read as a ride)
		const RIDE_MAX_DUR = 2.5    // seconds — cap (so tall shafts don't crawl)

		// ── Block textures (brushed-metal floor pad with a call button) ────────
		function drawTop(ctx, x, y, S) {
			ctx.fillStyle = '#6c7a89'; ctx.fillRect(x, y, S, S)
			// border frame
			ctx.fillStyle = '#48535e'
			ctx.fillRect(x, y, S, 1); ctx.fillRect(x, y + S - 1, S, 1)
			ctx.fillRect(x, y, 1, S); ctx.fillRect(x + S - 1, y, 1, S)
			// brushed grooves
			ctx.fillStyle = '#7d8b99'
			for (let i = 3; i < S - 1; i += 3) ctx.fillRect(x + 1, y + i, S - 2, 1)
			// centre call button (amber)
			const c = S / 2
			ctx.fillStyle = '#f0a830'
			ctx.fillRect(x + c - 2, y + c - 2, 4, 4)
			ctx.fillStyle = '#3a2a08'
			ctx.fillRect(x + c - 1, y + c - 1, 2, 2)
		}

		function drawSide(ctx, x, y, S) {
			ctx.fillStyle = '#55606b'; ctx.fillRect(x, y, S, S)
			ctx.fillStyle = '#48535e'
			ctx.fillRect(x, y, S, 2); ctx.fillRect(x, y + S - 2, S, 2)
			// vertical rails
			ctx.fillStyle = '#6c7a89'
			for (let i = 4; i < S - 2; i += 5) ctx.fillRect(x + i, y + 2, 1, S - 4)
		}

		api.registerBlock({
			id: ELEVATOR,
			name: 'Elevator',
			category: 'Crafted',
			draw: { top: drawTop, side: drawSide, bottom: drawSide },
		})

		// ── Shaft scan ─────────────────────────────────────────────────────────
		// Every placed pad sharing (x,z) is a floor; sorted ascending by Y so the
		// array index gives the floor number (index 0 = Floor 1 = lowest).
		function shaftFloors(x, z) {
			const ys = []
			for (const [k, v] of modified) {
				if (v !== ELEVATOR) continue
				const [bx, by, bz] = k.split('_').map(Number)
				if (bx === x && bz === z) ys.push(by)
			}
			ys.sort((a, b) => a - b)
			return ys
		}

		// ── Ride state ───────────────────────────────────────────────────────
		// null when idle; otherwise { cx, cz, fromY, toY, t, dur } (eye-Y values).
		let ride = null

		function startRide(x, z, targetPadY) {
			const fromY = player.pos.y
			const toY = targetPadY + 1 + player.height   // stand on top of the target pad
			const dist = Math.abs(toY - fromY)
			const dur = Math.max(RIDE_MIN_DUR, Math.min(RIDE_MAX_DUR, dist / RIDE_SPEED))
			ride = { cx: x + 0.5, cz: z + 0.5, fromY, toY, t: 0, dur }
		}

		// Smoothstep ease-in-out — gentle start/stop so the lift doesn't jerk.
		function ease(a) { return a * a * (3 - 2 * a) }

		api.addTickCallback((dt) => {
			if (!ride) return
			ride.t += dt
			const a = Math.min(1, ride.t / ride.dur)
			player.pos.x = ride.cx
			player.pos.z = ride.cz
			player.pos.y = ride.fromY + (ride.toY - ride.fromY) * ease(a)
			player.vel.set(0, 0, 0)
			player.onGround = false
			// Re-sync the camera: the main loop copied player.pos into yawObject
			// BEFORE this tick, so without this the cabin lags one frame.
			yawObject.position.copy(player.pos)
			if (a >= 1) {
				player.onGround = true
				ride = null
			}
		})

		// ── Floor-selector GUI ─────────────────────────────────────────────────
		const overlay = document.createElement('div')
		overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9000;align-items:center;justify-content:center'

		const modal = document.createElement('div')
		modal.style.cssText = 'background:#1a1a1a;border:1px solid #555;border-radius:6px;min-width:260px;font-family:monospace;box-shadow:0 4px 24px rgba(0,0,0,0.65)'

		const hdr = document.createElement('div')
		hdr.style.cssText = 'padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between'
		const hdrTitle = document.createElement('span')
		hdrTitle.style.cssText = 'color:#ddd;font-size:14px;font-weight:bold'
		hdrTitle.textContent = '🛗 Elevator'
		const hdrClose = document.createElement('button')
		hdrClose.textContent = '✕'
		hdrClose.style.cssText = 'background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:0 4px'
		hdr.append(hdrTitle, hdrClose)

		const body = document.createElement('div')
		body.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow-y:auto'

		modal.append(hdr, body)
		overlay.appendChild(modal)
		document.body.appendChild(overlay)

		function closeGui() {
			overlay.style.display = 'none'
			body.replaceChildren()
			if (!('ontouchstart' in window)) document.querySelector('canvas')?.requestPointerLock?.()
		}

		function openGui(x, y, z) {
			const ys = shaftFloors(x, z)
			body.replaceChildren()

			if (ys.length <= 1) {
				const hint = document.createElement('div')
				hint.style.cssText = 'color:#aaa;font-size:12px;line-height:1.5;padding:4px 0'
				hint.textContent = 'This shaft has only this floor. Stack more Elevator pads in the same column (same X,Z) to add floors.'
				body.appendChild(hint)
			} else {
				// Highest floor at the top, like a real elevator panel.
				for (let i = ys.length - 1; i >= 0; i--) {
					const fy = ys[i]
					const isHere = fy === y
					const btn = document.createElement('button')
					btn.textContent = `Floor ${i + 1}` + (isHere ? '  ● here' : `   ↑↓ y=${fy}`)
					btn.disabled = isHere
					btn.style.cssText = isHere
						? 'text-align:left;padding:9px 12px;background:rgba(240,168,48,.14);border:1px solid #f0a830;color:#f0c070;border-radius:4px;font-size:13px;font-family:monospace;cursor:default'
						: 'text-align:left;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid #555;color:#ddd;border-radius:4px;font-size:13px;font-family:monospace;cursor:pointer'
					if (!isHere) {
						btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(80,160,255,.18)'; btn.style.borderColor = '#5aa0ff' })
						btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,.05)'; btn.style.borderColor = '#555' })
						btn.addEventListener('click', () => {
							startRide(x, z, fy)
							closeGui()
						})
					}
					body.appendChild(btn)
				}
			}

			overlay.style.display = 'flex'
			document.exitPointerLock?.()
		}

		hdrClose.addEventListener('click', closeGui)
		overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGui() })
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && overlay.style.display === 'flex') { closeGui(); e.stopPropagation() }
		})

		// ── Block interaction: right-click a pad opens its floor selector ──────
		api.registerBlockInteraction([ELEVATOR], (ctx) => {
			if (ride) return   // ignore while a ride is in progress
			const f = ctx.facing
			if (!f || f.type !== ELEVATOR) return
			openGui(f.x, f.y, f.z)
		})

		// ── Elevator tool: place floor pads ────────────────────────────────────
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = 64; iconCanvas.height = 64
		drawTop(iconCanvas.getContext('2d'), 0, 0, 64)

		api.registerTool({
			name: 'Elevator',
			url: iconCanvas.toDataURL(),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (f.type === ELEVATOR) return   // right-clicking a pad opens the GUI instead
				const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
				if (ctx.getBlock(bx, by, bz) !== null) return
				ctx.setBlock(bx, by, bz, ELEVATOR)
			},
		})

		console.log('[Elevator] registered id ' + ELEVATOR)
	},
})
