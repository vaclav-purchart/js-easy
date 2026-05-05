/**
 * Voxel World Plugin — Amethyst Pickaxe (3x3 Miner)
 *
 * Breaks a 3x3 area depending on the face you're looking at.
 */

VoxelWorld.registerPlugin('AmethystPickaxe', {
	async init(api) {
		const TOOL_URL = 'https://purchart.eu/images?file=2026-05-04--14-48-40---vasik-amethist-pixax---pixaxe.png'

		const toolVisual = await api.preloadToolVisual(TOOL_URL)

		api.registerTool({
			name: 'Amethyst Pickaxe',
			url: TOOL_URL,
			damage: 0,

			onLeftClick(ctx) {
				const f = ctx.facing
				if (!f) return

				const centerX = f.x
				const centerY = f.y
				const centerZ = f.z

				// Determine plane based on hit face
				let offsets = []

				// If breaking top/bottom → mine XZ plane
				if (Math.abs(f.ny) === 1) {
					for (let x = -1; x <= 1; x++) {
						for (let z = -1; z <= 1; z++) {
							offsets.push([x, 0, z])
						}
					}
				}
				// If breaking north/south → mine XY plane
				else if (Math.abs(f.nz) === 1) {
					for (let x = -1; x <= 1; x++) {
						for (let y = -1; y <= 1; y++) {
							offsets.push([x, y, 0])
						}
					}
				}
				// If breaking east/west → mine YZ plane
				else if (Math.abs(f.nx) === 1) {
					for (let y = -1; y <= 1; y++) {
						for (let z = -1; z <= 1; z++) {
							offsets.push([0, y, z])
						}
					}
				}

				// Break all 9 blocks
				const blocks = []
				for (const [dx, dy, dz] of offsets) {
					const bx = centerX + dx
					const by = centerY + dy
					const bz = centerZ + dz
					if (ctx.getBlock(bx, by, bz) !== null) {
						blocks.push([bx, by, bz, ctx.BLOCK.AIR])
					}
				}
				ctx.setBlocks(blocks)
			},
		})
	},
})
