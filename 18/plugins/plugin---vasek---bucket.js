/**
 * Voxel World Plugin — Bucket
 *
 * Adds two tools: an empty bucket and a water bucket.
 *
 * Usage:
 *   Right-click (or touch Place) with empty bucket on a water block → scoops
 *   the water and switches to the water bucket.
 *
 *   Right-click (or touch Place) with water bucket on any surface → places a
 *   water block at the adjacent position and switches back to the empty bucket.
 *
 * The block mutation goes through setBlock() so it is broadcast to all
 * connected players exactly like any other block change.
 */

VoxelWorld.registerPlugin('Bucket', {
	init(api) {
		api.registerTool({
			name: 'Bucket',
			url: 'https://purchart.eu/images?file=2026-05-03--19-11-00---vasek---bucket-empty.png',
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f || f.type !== ctx.BLOCK.WATER) return
				ctx.setBlock(f.x, f.y, f.z, ctx.BLOCK.AIR)
				ctx.swapTool('Water Bucket')
			},
		})

		api.registerTool({
			name: 'Water Bucket',
			url: 'https://purchart.eu/images?file=2026-05-03--19-11-14---vasek---bucket-water.png',
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				// Place water in the adjacent empty cell
				const px = f.x + f.nx
				const py = f.y + f.ny
				const pz = f.z + f.nz
				const existing = ctx.getBlock(px, py, pz)
				// Only place into air or existing water (no-op for water so the
				// bucket doesn't drain into an already-wet cell)
				if (existing !== null && existing !== ctx.BLOCK.WATER) return
				ctx.setBlock(px, py, pz, ctx.BLOCK.WATER)
				ctx.swapTool('Bucket')
			},
		})
	},
})
