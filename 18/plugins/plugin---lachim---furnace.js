/**
 * Voxel World Plugin â€” Furnace Block
 *
 * Demonstrates URL-based texture loading via api.loadBlockTexture().
 * No internal engine globals are used â€” everything goes through api.
 */

VoxelWorld.registerPlugin('Furnace', {
	init(api) {
		const BLOCK_ID = api.allocateBlockId()

		// Register with a placeholder first so the atlas row is reserved.
		// top and bottom will fall back to side automatically if not specified.
		api.registerBlock({
			id:       BLOCK_ID,
			name:     'Furnace',
			category: 'Crafted',
			draw: {
				side(ctx, x, y, S) {
					ctx.fillStyle = '#555'
					ctx.fillRect(x, y, S, S)
				},
			},
		})

		// Load textures via api â€” no internal globals needed
		api.loadBlockTexture(BLOCK_ID,
			'https://purchart.cloud/images?file=2026-03-23--15-14-55---lachim---pec-strana.png',
			'side')
		api.loadBlockTexture(BLOCK_ID,
			'https://purchart.cloud/images?file=2026-03-23--15-18-13---lachim---pec-horn-strana.png',
			'top')
		api.loadBlockTexture(BLOCK_ID,
			'https://purchart.cloud/images?file=2026-03-23--15-16-15---lachim---pec-spodek.png',
			'bottom')

		console.log('[Furnace] Registered (id=' + BLOCK_ID + '), textures loadingâ€¦')
	},
})