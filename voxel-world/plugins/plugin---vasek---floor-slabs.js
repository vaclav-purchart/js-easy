/**
 * Voxel World Plugin — Floor Slabs
 *
 * A solid stone building block textured to look like big paving slabs: the top
 * face reads as a 2x2 grid of large flagstones with recessed joints and a soft
 * bevel, and the sides show two stacked stone courses so a wall of them looks
 * like layered slabs. Everything is painted procedurally into the atlas tile —
 * no network textures, no engine internals touched, all through the plugin api.
 */

/* global VoxelWorld */

VoxelWorld.registerPlugin('FloorSlabs', {
	init(api) {
		const ID = api.allocateBlockId()

		// Deterministic per-pixel grain so every slab looks identical and tiles
		// cleanly. A tiny integer hash keeps the speckle stable (no Math.random —
		// the atlas is painted once, but staying deterministic keeps the top and
		// side faces consistent with each other).
		function grain(ctx, x, y, S) {
			for (let py = 0; py < S; py++) {
				for (let px = 0; px < S; px++) {
					const h = ((px * 73856093) ^ (py * 19349663)) >>> 0
					const n = h & 7
					if (n === 0)      ctx.fillStyle = '#7c7c75'  // dark fleck
					else if (n === 1) ctx.fillStyle = '#9c9c95'  // light fleck
					else continue                                 // leave base
					ctx.fillRect(x + px, y + py, 1, 1)
				}
			}
		}

		// Top face: 2x2 large slabs. A recessed dark joint splits the tile in
		// half on each axis, with a 1px highlight on the upper/left edge of each
		// quadrant to fake a bevel so the slabs read as raised pavers.
		function paintTop(ctx, x, y, S) {
			ctx.fillStyle = '#8d8d86'
			ctx.fillRect(x, y, S, S)
			grain(ctx, x, y, S)

			const m = S >> 1   // joint position (centre)

			// recessed cross joint (dark)
			ctx.fillStyle = '#5d5d57'
			ctx.fillRect(x, y + m, S, 1)
			ctx.fillRect(x + m, y, 1, S)

			// bevel highlight just below/right of each joint
			ctx.fillStyle = '#a3a39c'
			ctx.fillRect(x, y + m + 1, S, 1)
			ctx.fillRect(x + m + 1, y, 1, S)
		}

		// Side face: two stacked courses. A dark horizontal joint near the middle
		// reads as the gap between slabs; vertical joints are offset between the
		// upper and lower course like a brick bond.
		function paintSide(ctx, x, y, S) {
			ctx.fillStyle = '#85857e'
			ctx.fillRect(x, y, S, S)
			grain(ctx, x, y, S)

			const m = S >> 1

			// horizontal course joint
			ctx.fillStyle = '#565650'
			ctx.fillRect(x, y + m, S, 1)
			ctx.fillStyle = '#9a9a92'
			ctx.fillRect(x, y + m + 1, S, 1)

			// offset vertical joints (upper course centred, lower course at edges)
			ctx.fillStyle = '#565650'
			ctx.fillRect(x + m, y, 1, m)            // upper course
			ctx.fillRect(x, y + m, 1, S - m)        // lower course (wraps at edge)
		}

		api.registerBlock({
			id:       ID,
			name:     'Floor Slabs',
			category: 'Building',
			draw: {
				top:    paintTop,
				side:   paintSide,
				bottom: paintSide,
			},
		})

		console.log('[FloorSlabs] Registered (id=' + ID + ')')
	},
})
