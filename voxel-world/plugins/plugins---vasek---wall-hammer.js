/**
 * Voxel World Plugin — Hammer
 *
 * Right-click on any surface to build an axis-aligned wall:
 *   - 5 blocks wide (orthogonal to the player's horizontal facing direction)
 *   - 4 blocks tall, rising from the clicked face
 *   - Material: last block selected in the hotbar before equipping the hammer
 */

/* global VoxelWorld, THREE */

VoxelWorld.registerPlugin('Hammer', {
	init(api) {
		let lastBlockId = 1  // grass as fallback

		// Keep lastBlockId updated to whatever block is currently selected.
		// Using the global HOTBAR_ITEMS / selectedSlot from index.html.
		api.addTickCallback(() => {
			const item = HOTBAR_ITEMS[selectedSlot]
			if (item && item.type === 'block') {
				lastBlockId = item.blockId
			}
		})

		function drawHammerIcon(ctx, W, H) {
			ctx.clearRect(0, 0, W, H)

			// Hammer head (metal gray)
			ctx.fillStyle = '#777777'
			ctx.fillRect(4, 1, 8, 5)
			// Head highlight (top + left edge)
			ctx.fillStyle = '#AAAAAA'
			ctx.fillRect(4, 1, 8, 1)
			ctx.fillRect(4, 1, 1, 5)
			// Head shadow (bottom + right edge)
			ctx.fillStyle = '#444444'
			ctx.fillRect(4, 5, 8, 1)
			ctx.fillRect(11, 1, 1, 5)

			// Handle (wood brown)
			ctx.fillStyle = '#8B4513'
			ctx.fillRect(7, 6, 3, 9)
			// Handle highlight / shadow
			ctx.fillStyle = '#A0522D'
			ctx.fillRect(7, 6, 1, 9)
			ctx.fillStyle = '#5C2E0A'
			ctx.fillRect(9, 6, 1, 9)
		}

		api.registerTool({
			name: 'Hammer',
			draw: drawHammerIcon,
			damage: 3,

			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return

				// Placement origin: one block out from the clicked face
				const bx = f.x + f.nx
				const by = f.y + f.ny
				const bz = f.z + f.nz

				// Determine wall axis: perpendicular to the camera's horizontal facing.
				// If looking mostly along X → wall runs along Z, and vice versa.
				const camDir = new THREE.Vector3()
				api.camera.getWorldDirection(camDir)

				let ax = 0, az = 0
				if (Math.abs(camDir.x) >= Math.abs(camDir.z)) {
					az = 1
				} else {
					ax = 1
				}

				// Build a 5-wide × 4-tall wall centred on the click point
				const blocks = []
				for (let h = 0; h < 4; h++) {
					for (let s = -2; s <= 2; s++) {
						const wx = bx + ax * s
						const wy = by + h
						const wz = bz + az * s
						if (ctx.getBlock(wx, wy, wz) === null) {
							blocks.push([wx, wy, wz, lastBlockId])
						}
					}
				}
				ctx.setBlocks(blocks)
			},
		})
	},
})
