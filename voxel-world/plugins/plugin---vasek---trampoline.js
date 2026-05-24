/**
 * Voxel World Plugin
 *
 * Trampoline — a bouncy block that reflects the player's velocity on landing
 * and adds 20% extra energy with each consecutive bounce.
 *
 * Physics: the trampoline surface is horizontal so only the Y component flips;
 * horizontal momentum is preserved (angle of incidence = angle of reflection).
 * Each landing multiplies the impact speed by 1.2. Bounces are capped at 40 m/s
 * (≈82-block apex) to prevent tunnelling — the engine uses discrete collision
 * detection which breaks above ~62 m/s (>1 block per frame at 60 fps).
 *
 * If the player walks gently onto the trampoline the bounce is negligible because
 * the incoming vertical speed is near zero. Energy accumulates only when the
 * player keeps landing on the same trampoline from increasing heights.
 */

/* global VoxelWorld, player, getBlock */

VoxelWorld.registerPlugin('Trampoline', {
	init(api) {
		const TRAMPOLINE = api.allocateBlockId()
		const MAX_BOUNCE = 40   // m/s cap — keeps per-frame Y movement under 1 block

		// ── Block textures ─────────────────────────────────────────────────
		function drawTop(ctx, x, y, S) {
			// Teal bouncy mat
			ctx.fillStyle = '#1a9e6e'; ctx.fillRect(x, y, S, S)
			// Weave grid
			ctx.fillStyle = '#0d7a52'
			for (let i = 2; i < S; i += 4) {
				ctx.fillRect(x + i, y, 1, S)
				ctx.fillRect(x, y + i, S, 1)
			}
			// Metal border frame
			ctx.fillStyle = '#9aacb8'
			ctx.fillRect(x,         y,         S, 2)
			ctx.fillRect(x,         y + S - 2, S, 2)
			ctx.fillRect(x,         y,         2, S)
			ctx.fillRect(x + S - 2, y,         2, S)
		}

		function drawSide(ctx, x, y, S) {
			// Steel-grey frame legs
			ctx.fillStyle = '#b0bec5'; ctx.fillRect(x, y, S, S)
			ctx.fillStyle = '#78909c'
			ctx.fillRect(x, y,         S, 3)
			ctx.fillRect(x, y + S - 3, S, 3)
			ctx.fillStyle = '#90a4ae'
			for (let i = 5; i < S - 2; i += 5) {
				ctx.fillRect(x + i, y + 3, 1, S - 6)
			}
		}

		api.registerBlock({
			id: TRAMPOLINE,
			name: 'Trampoline',
			category: 'Crafted',
			draw: {
				top:    drawTop,
				side:   drawSide,
				bottom: drawSide,
			},
		})

		// ── Bounce physics ─────────────────────────────────────────────────
		// The engine zeros player.vel.y BEFORE the tick callback fires on a
		// landing frame, so we must remember last-frame's velocity to know how
		// fast the player hit the surface.
		let prevVelY    = 0
		let wasOnGround = false

		api.addTickCallback(() => {
			const justLanded = !wasOnGround && player.onGround

			if (justLanded) {
				// Block the player is standing on: feet are at an exact integer Y
				// after the engine snaps them to the surface, so subtract a tiny
				// epsilon to land in the grid cell below.
				const fx = Math.floor(player.pos.x)
				const fy = Math.floor(player.pos.y - player.height - 0.001)
				const fz = Math.floor(player.pos.z)

				if (getBlock(fx, fy, fz) === TRAMPOLINE) {
					const bounce = Math.min(Math.abs(prevVelY) * 1.5, MAX_BOUNCE)
					player.vel.y  = bounce
					player.onGround = false
				}
			}

			wasOnGround = player.onGround
			prevVelY    = player.vel.y
		})

		// ── Tool — generate icon from the top-face texture ─────────────────
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width  = 64
		iconCanvas.height = 64
		drawTop(iconCanvas.getContext('2d'), 0, 0, 64)
		const iconUrl = iconCanvas.toDataURL()

		api.registerTool({
			name:   'Trampoline',
			url:    iconUrl,
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				ctx.setBlock(f.x + f.nx, f.y + f.ny, f.z + f.nz, TRAMPOLINE)
			},
		})

		console.log('[Trampoline] registered id ' + TRAMPOLINE)
	},
})
