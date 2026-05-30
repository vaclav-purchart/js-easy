/**
 * Voxel World Plugin — Terrain Leveler
 *
 * Left-click a block to flatten a 10×10 area to that block's height.
 * Blocks above are removed; the surface is filled with the clicked block type.
 * Right-click to undo the most recent leveling (last 10 are remembered).
 */

/* global VoxelWorld, showToast */

VoxelWorld.registerPlugin('TerrainLeveler', {
	async init(api) {
		// Undo history: stack of operations, each a [[x,y,z,prevBlockId], …]
		// array recording the block values *before* a level op. Capped so we
		// never hold more than the last MAX_UNDO operations.
		const MAX_UNDO = 10
		const undoStack = []

		api.registerTool({
			name: 'Terrain Leveler',
			draw(ctx, W, H) {
				// Ground surface (flat line)
				ctx.fillStyle = '#8B6914'
				ctx.fillRect(1, H * 0.65, W - 2, 3)

				// Left hill being cut down
				ctx.fillStyle = '#5a8a3a'
				ctx.beginPath()
				ctx.moveTo(1, H * 0.65)
				ctx.lineTo(1, H * 0.25)
				ctx.lineTo(W * 0.35, H * 0.25)
				ctx.lineTo(W * 0.35, H * 0.65)
				ctx.closePath()
				ctx.fill()

				// Down arrows indicating leveling
				ctx.fillStyle = '#fff'
				ctx.beginPath()
				ctx.moveTo(W * 0.2, H * 0.3)
				ctx.lineTo(W * 0.28, H * 0.3)
				ctx.lineTo(W * 0.24, H * 0.5)
				ctx.closePath()
				ctx.fill()

				// Right flat area
				ctx.fillStyle = '#5a8a3a'
				ctx.fillRect(W * 0.35, H * 0.55, W * 0.62, H * 0.1)
			},
			damage: 0,

			onLeftClick(ctx) {
				const f = ctx.facing
				if (!f) return

				const targetY = f.y
				const blockType = ctx.getBlock(f.x, f.y, f.z)
				if (blockType === null) return

				const blocks = []
				// Previous values, recorded before we mutate, so the op can be
				// undone. getBlock returns null for air → store AIR explicitly.
				const undo = []
				const record = (x, y, z, newVal) => {
					const prev = ctx.getBlock(x, y, z)
					if (prev === newVal) return // no-op, nothing to change/undo
					undo.push([x, y, z, prev === null ? ctx.BLOCK.AIR : prev])
					blocks.push([x, y, z, newVal])
				}

				for (let dx = -4; dx <= 5; dx++) {
					for (let dz = -4; dz <= 5; dz++) {
						const cx = f.x + dx
						const cz = f.z + dz

						// Fill surface at target level with clicked block type
						record(cx, targetY, cz, blockType)

						// Remove blocks above target level
						for (let dy = 1; dy <= 64; dy++) {
							if (blocks.length >= 1020) break
							const cy = targetY + dy
							if (ctx.getBlock(cx, cy, cz) !== null) {
								record(cx, cy, cz, ctx.BLOCK.AIR)
							}
						}
					}
				}

				if (!blocks.length) return

				undoStack.push(undo)
				if (undoStack.length > MAX_UNDO) undoStack.shift()

				ctx.setBlocks(blocks)
			},

			onRightClick(ctx) {
				const undo = undoStack.pop()
				if (!undo) {
					showToast('Nothing to undo')
					return
				}
				ctx.setBlocks(undo)
				showToast(`↩ Undo (${undoStack.length} left)`)
			},
		})
	},
})
