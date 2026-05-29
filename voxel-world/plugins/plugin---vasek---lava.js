/**
 * Voxel World Plugin — Molten Lava
 *
 * A solid block of molten lava: a dark cooling crust broken up by glowing
 * cracks of bright orange/yellow magma. The pattern is painted procedurally
 * into the atlas tile (deterministic, no network textures, no engine internals
 * touched) — same pure-api approach as the concrete and floor-slab blocks.
 */

/* global VoxelWorld, getBlock, player, myHp, showToast */

VoxelWorld.registerPlugin('Lava', {
	init(api) {
		const ID = api.allocateBlockId()

		// ── Tiling value-noise field ──────────────────────────────────────
		// We carve the tile into organic blobs with smooth bilinear value noise
		// instead of straight crack lines. Lattice points are hashed on a grid
		// that wraps every CELLS columns/rows, so the texture tiles seamlessly
		// from one block to the next. Deterministic (no Math.random) — the atlas
		// is painted once, and all six faces share the same look.
		function hash01(ix, iy) {
			let h = (ix * 374761393 + iy * 668265263) >>> 0
			h = (h ^ (h >>> 13)) >>> 0
			h = (h * 1274126177) >>> 0
			return (h >>> 0) / 4294967296
		}

		// One octave of wrapping value noise at lattice spacing `g` (S/g cells).
		function octave(px, py, S, g) {
			const cells = S / g
			const gx = px / g, gy = py / g
			const ix0 = Math.floor(gx), iy0 = Math.floor(gy)
			let fx = gx - ix0, fy = gy - iy0
			fx = fx * fx * (3 - 2 * fx)   // smoothstep
			fy = fy * fy * (3 - 2 * fy)
			const x0 = ((ix0 % cells) + cells) % cells
			const y0 = ((iy0 % cells) + cells) % cells
			const x1 = (x0 + 1) % cells
			const y1 = (y0 + 1) % cells
			const v00 = hash01(x0, y0), v10 = hash01(x1, y0)
			const v01 = hash01(x0, y1), v11 = hash01(x1, y1)
			const a = v00 + (v10 - v00) * fx
			const b = v01 + (v11 - v01) * fx
			return a + (b - a) * fy
		}

		// Two octaves → blobby crust islands with finer wobble on the edges.
		function field(px, py, S) {
			return octave(px, py, S, 8) * 0.65 + octave(px, py, S, 4) * 0.35
		}

		// The whole tile is molten — no cooled rock. The noise field just decides
		// how hot each spot is: low values are white-hot cores, high values are
		// the deep glowing-red veins where the lava is a little cooler. Every
		// colour stays in the incandescent yellow→orange→red range so nothing
		// reads as brown crust.
		function moltenColor(n) {
			if (n < 0.16) return '#ffcf2e'   // golden-yellow core (no white)
			if (n < 0.27) return '#ffb01f'
			if (n < 0.38) return '#ffc224'
			if (n < 0.49) return '#ff9512'
			if (n < 0.60) return '#ff670e'
			if (n < 0.71) return '#f5430a'
			if (n < 0.82) return '#cf2c06'
			return '#9c1c04'                  // deepest, coolest red vein
		}

		function paintLava(ctx, x, y, S) {
			for (let py = 0; py < S; py++) {
				for (let px = 0; px < S; px++) {
					ctx.fillStyle = moltenColor(field(px, py, S))
					ctx.fillRect(x + px, y + py, 1, 1)
				}
			}
		}

		api.registerBlock({
			id:       ID,
			name:     'Molten Lava',
			category: 'Natural',
			semiTransparent: true,   // only slightly see-through (matSemi, opacity 0.85)
			draw: {
				top:    paintLava,
				side:   paintLava,
				bottom: paintLava,
			},
		})

		// ── Burn the player while they stand in/on lava ───────────────────
		// Damage is authoritative: we send the `env_damage` message and the
		// server applies it to us, broadcasts the new HP, and handles death /
		// respawn (so other players see the HP drop and the kill feed). The
		// server clamps the amount and enforces a 500ms window per hit, so we
		// pace our sends just slower than that and let the engine's existing
		// hp_update / player_died handlers drive the HUD.
		const DPS = 5                 // target hit points per second on lava
		const SEND_INTERVAL = 0.6     // s between damage sends (> server's 500ms gate)
		let sinceSend = SEND_INTERVAL // fire on the first frame of contact
		let sinceToast = 1e9

		function onLava() {
			const x = Math.floor(player.pos.x)
			const z = Math.floor(player.pos.z)
			const feetY = player.pos.y - player.height
			// standing on top of a lava block, or feet sunk into one
			return (
				getBlock(x, Math.floor(feetY - 0.1), z) === ID ||
				getBlock(x, Math.floor(feetY + 0.1), z) === ID
			)
		}

		api.addTickCallback((dt) => {
			sinceToast += dt
			if (myHp <= 0 || !onLava()) { sinceSend = SEND_INTERVAL; return }

			sinceSend += dt
			if (sinceSend < SEND_INTERVAL) return
			const amount = Math.max(1, Math.round(DPS * sinceSend))
			sinceSend = 0

			api.netSend({ type: 'env_damage', amount, cause: 'lava' })

			if (sinceToast > 0.9) {   // local feedback only; HP itself is server-driven
				sinceToast = 0
				showToast('🔥 Burning!')
			}
		})

		console.log('[Lava] Registered (id=' + ID + ')')
	},
})
