/**
 * Voxel World Plugin — Trees
 *
 * Adds oak trees (wood trunk + leaf canopy) to the world using
 * api.registerTerrainBlock(). Trees are computed purely from the world
 * seed — nothing is stored in the modified map, so there is nothing to
 * distribute. Every client independently derives the same forest layout.
 *
 * Player-mined tree blocks are stored in modified as AIR by the engine
 * and take priority over the terrain layer automatically, so mining and
 * multiplayer sync work exactly like any other block.
 *
 * The function passed to registerTerrainBlock closes over api on the main
 * thread and receives an injected api object in Web Workers — the same shape
 * in both environments, so no special handling is needed here.
 */

/* global VoxelWorld, THREE */

VoxelWorld.registerPlugin('Trees', {
	init(api) {
		api.registerTerrainBlock(function treeBlockAt(x, y, z) {
			const { SEED, terrainHeight, SEA_LEVEL, BLOCK } = api.CONST
			const TREE_RARITY = 1500  // ~1 tree per 1500 surface columns

			// A tree rooted at (tx, tz) can have canopy reaching up to 2 blocks
			// away in X and Z, so we must check that neighborhood for each query.
			for (let tx = x - 2; tx <= x + 2; tx++) {
				for (let tz = z - 2; tz <= z + 2; tz++) {
					const h = Math.abs(Math.sin(tx * 213.7 + tz * 157.3 + SEED * 0.0017) * 43758.5453) % 1
					if (h > 1 / TREE_RARITY) continue

					const th = terrainHeight(tx, tz)
					if (th <= SEA_LEVEL) continue  // no trees in water

					const ty = th + 1  // trunk base (one above the grass surface)
					const trunkH = 4 + Math.floor((Math.abs(Math.sin(tx * 77.3 + tz * 91.7)) % 1) * 3)
					const topY = ty + trunkH - 1

					// Trunk column
					if (tx === x && tz === z && y >= ty && y <= topY) return BLOCK.WOOD

					// Canopy: two wide rings (r=2) then two narrow rings (r=1),
					// corners clipped on every ring.
					const dy = y - topY
					if (dy < -1 || dy > 2) continue
					const r = dy <= 0 ? 2 : 1
					const adx = Math.abs(x - tx)
					const adz = Math.abs(z - tz)
					if (adx > r || adz > r) continue
					if (adx === r && adz === r) continue  // clip corners
					return BLOCK.LEAVES
				}
			}
			return null
		}, 32)
	},
})
