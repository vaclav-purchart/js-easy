/**
 * Voxel World Plugin — Concrete Block
 *
 * A plain solid building block: smooth light-grey concrete with subtle
 * speckle/grain painted procedurally into the atlas tile. No textures are
 * loaded over the network and no engine internals are touched — everything
 * goes through the plugin api.
 */

/* global VoxelWorld */

VoxelWorld.registerPlugin('Concrete', {
	init(api) {
		const ID = api.allocateBlockId()

		// Deterministic per-pixel grain so every concrete block looks identical
		// and the tile tiles cleanly. A tiny hash keeps the speckle stable
		// (no Math.random — the atlas is only painted once, but staying
		// deterministic keeps top/side/bottom faces consistent).
		function paintConcrete(ctx, x, y, S) {
			// Base fill
			ctx.fillStyle = '#9a9a98'
			ctx.fillRect(x, y, S, S)

			for (let py = 0; py < S; py++) {
				for (let px = 0; px < S; px++) {
					// cheap integer hash → 0..7
					const h = ((px * 73856093) ^ (py * 19349663)) >>> 0
					const n = h & 7
					if (n === 0)      ctx.fillStyle = '#8a8a88'  // dark fleck
					else if (n === 1) ctx.fillStyle = '#aeaeac'  // light fleck
					else continue                                 // leave base
					ctx.fillRect(x + px, y + py, 1, 1)
				}
			}
		}

		api.registerBlock({
			id:       ID,
			name:     'Concrete',
			category: 'Building',
			draw: {
				side:   paintConcrete,
				top:    paintConcrete,
				bottom: paintConcrete,
			},
		})

		console.log('[Concrete] Registered (id=' + ID + ')')
	},
})
