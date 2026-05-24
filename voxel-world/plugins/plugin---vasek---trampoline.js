/**
 * Voxel World Plugin
 *
 * Trampoline — a bouncy block that reflects the player's full velocity on
 * landing and adds 20% extra energy with each bounce.
 *
 * Physics: the trampoline surface is horizontal, so the reflection flips the
 * Y component while preserving horizontal direction. The entire speed vector
 * is multiplied by 1.2 (angle of incidence = angle of reflection + 20% boost).
 * This means chained trampolines also amplify horizontal travel speed.
 *
 * Landing detection: the engine zeros vel.y on ground contact, and the jump
 * check may replace it in the same frame — both happen before the tick fires.
 * Reliable signal: prevVelY < 0 (was falling) AND vel.y >= 0 (landed or jumped).
 * This catches both the normal case and the Space-held case, and overwrites
 * whatever the regular jump set.
 *
 * Total speed is capped at 40 m/s to prevent tunnelling — the engine uses
 * discrete collision detection which breaks above ~62 m/s (>1 block/frame at 60 fps).
 */

/* global VoxelWorld, THREE, G, player, getBlock, keys, yawObject */

VoxelWorld.registerPlugin('Trampoline', {
	init(api) {
		const TRAMPOLINE = api.allocateBlockId()
		const MAX_SPEED = 40                    // m/s total — tunnelling safety cap
		const MIN_BOUNCE_Y = Math.sqrt(2 * G * 4) // minimum 4-block apex (~8.85 m/s)

		// ── Block textures ─────────────────────────────────────────────────
		function drawTop(ctx, x, y, S) {
			ctx.fillStyle = '#1a9e6e'; ctx.fillRect(x, y, S, S)
			ctx.fillStyle = '#0d7a52'
			for (let i = 2; i < S; i += 4) {
				ctx.fillRect(x + i, y, 1, S)
				ctx.fillRect(x, y + i, S, 1)
			}
			ctx.fillStyle = '#9aacb8'
			ctx.fillRect(x,         y,         S, 2)
			ctx.fillRect(x,         y + S - 2, S, 2)
			ctx.fillRect(x,         y,         2, S)
			ctx.fillRect(x + S - 2, y,         2, S)
		}

		function drawSide(ctx, x, y, S) {
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
			draw: { top: drawTop, side: drawSide, bottom: drawSide },
		})

		// ── Bounce physics ─────────────────────────────────────────────────
		// prevVelY < 0 (was falling) + player.vel.y >= 0 (landed or jump fired)
		// is the reliable landing signal that works whether or not Space is held.
		let prevVelX = 0, prevVelY = 0, prevVelZ = 0

		const _fwd = new THREE.Vector3()
		const _rgt = new THREE.Vector3()

		api.addTickCallback(() => {
			if (prevVelY < -0.001 && player.vel.y >= 0) {
				const fx = Math.floor(player.pos.x)
				const fy = Math.floor(player.pos.y - player.height - 0.001)
				const fz = Math.floor(player.pos.z)

				if (getBlock(fx, fy, fz) === TRAMPOLINE) {
					_fwd.set(0, 0, -1).applyQuaternion(yawObject.quaternion)
					_rgt.set(1, 0, 0).applyQuaternion(yawObject.quaternion)
					let inputX = 0, inputZ = 0
					const hs = player.speed
					if (keys.KeyW) { inputX += _fwd.x * hs; inputZ += _fwd.z * hs }
					if (keys.KeyS) { inputX -= _fwd.x * hs; inputZ -= _fwd.z * hs }
					if (keys.KeyD) { inputX += _rgt.x * hs; inputZ += _rgt.z * hs }
					if (keys.KeyA) { inputX -= _rgt.x * hs; inputZ -= _rgt.z * hs }

					// Full incoming velocity = WASD direction + stored trampoline momentum
					const inVx = inputX + prevVelX
					const inVz = inputZ + prevVelZ

					// Reflect Y, boost the whole vector by 20%, enforce minimum height
					let outVx = inVx * 1.2
					let outVy = Math.max(Math.abs(prevVelY) * 1.2, MIN_BOUNCE_Y)
					let outVz = inVz * 1.2

					// Cap total speed to prevent discrete-collision tunnelling
					const spd = Math.sqrt(outVx * outVx + outVy * outVy + outVz * outVz)
					if (spd > MAX_SPEED) {
						const s = MAX_SPEED / spd
						outVx *= s; outVy *= s; outVz *= s
					}

					player.vel.x = outVx
					player.vel.y = outVy
					player.vel.z = outVz
					player.onGround = false
				}
			}

			prevVelX = player.vel.x
			prevVelY = player.vel.y
			prevVelZ = player.vel.z
		})

		// ── Tool — icon generated from the top-face texture ────────────────
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = 64; iconCanvas.height = 64
		drawTop(iconCanvas.getContext('2d'), 0, 0, 64)

		api.registerTool({
			name:   'Trampoline',
			url:    iconCanvas.toDataURL(),
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
