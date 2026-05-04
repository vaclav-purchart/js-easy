/**
 * Voxel World Plugin — Bucket
 *
 * One tool with two visual states (empty / water-filled).
 *
 *   Left-click  on a water block → always scoops water (works empty or full).
 *   Right-click anywhere          → places water only when the bucket is full.
 *
 * The block change goes through setBlock() so every connected player sees it.
 * ctx.setToolVisual() swaps the icon and hand model between the two states.
 */

VoxelWorld.registerPlugin('Bucket', {
	async init(api) {
		const EMPTY_URL = 'https://purchart.eu/images?file=2026-05-03--19-11-00---vasek---bucket-empty.png'
		const FULL_URL  = 'https://purchart.eu/images?file=2026-05-03--19-11-14---vasek---bucket-water.png'

		// Pre-load both visuals so state swaps are instant.
		const [emptyV, fullV] = await Promise.all([
			api.preloadToolVisual(EMPTY_URL),
			api.preloadToolVisual(FULL_URL),
		])

		let full = false

		api.registerTool({
			name: 'Bucket',
			url: EMPTY_URL,
			damage: 0,

			onLeftClick(ctx) {
				const f = ctx.facing
				if (!f || f.type !== ctx.BLOCK.WATER) return
				ctx.setBlock(f.x, f.y, f.z, ctx.BLOCK.AIR)
				full = true
				ctx.setToolVisual(fullV)
			},

			onRightClick(ctx) {
				if (!full) return
				const f = ctx.facing
				if (!f) return
				const px = f.x + f.nx, py = f.y + f.ny, pz = f.z + f.nz
				const existing = ctx.getBlock(px, py, pz)
				// Only place into air (null) or an already-water cell
				if (existing !== null && existing !== ctx.BLOCK.WATER) return
				ctx.setBlock(px, py, pz, ctx.BLOCK.WATER)
				full = false
				ctx.setToolVisual(emptyV)
			},
		})
	},
})
