/**
 * Voxel World Plugin — Tall Grass
 *
 * Adds pixelated tall grass as a second plant type alongside flowers.
 * Uses the same deterministic surface placement — above sea level, never
 * in water. Overall plant density stays the same; roughly half the spots
 * become grass, the rest remain flowers.
 *
 * Uses api.registerPlant() so no engine internals are touched directly.
 */

/* global VoxelWorld, THREE */

VoxelWorld.registerPlugin('TallGrass', {
	init(api) {
		api.registerPlant({
			name: 'TallGrass',
			draw(ctx, x, y, S) {
				// Five blades at different offsets, heights, and green shades.
				const blades = [
					{ ox: 1, h: 10, c: '#3d7a22' },
					{ ox: 4, h: 13, c: '#4a8c2a' },
					{ ox: 7, h: 11, c: '#56a030' },
					{ ox: 10, h: 12, c: '#4a8c2a' },
					{ ox: 13, h: 9, c: '#3d7a22' },
				]
				for (const { ox, h, c } of blades) {
					ctx.fillStyle = c
					ctx.fillRect(x + ox, y + S - h, 2, h - 1)
					// Bright tip pixel
					ctx.fillStyle = '#7acc44'
					ctx.fillRect(x + ox, y + S - h, 1, 1)
				}
			},
		})
	},
})
