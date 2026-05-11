/**
 * Voxel World Plugin — Builder
 *
 * Equip the Builder tool and left-click to place a small house
 * in front of you.
 */

/* global VoxelWorld, THREE */

VoxelWorld.registerPlugin('Builder', {
	init(api) {

		// ── Custom blocks ──────────────────────────────────────────────────
		const WALL_ID = api.allocateBlockId()
		const ROOF_ID = api.allocateBlockId()
		const GLASS_ID = api.allocateBlockId()
		const COUCH_ID = api.allocateBlockId()
		const PLANT_ID = api.allocateBlockId()

		api.registerBlock({
			id: WALL_ID,
			name: 'Silver Brick',
			category: 'Builder',
			draw: {
				side(ctx, x, y, S) {
					ctx.fillStyle = '#b0b8c0'
					ctx.fillRect(x, y, S, S)
					ctx.fillStyle = '#8a9099'
					for (let i = 0; i < S; i += 4) {
						ctx.fillRect(x, y + i, S, 1)
						ctx.fillRect(x + (i % 8 < 4 ? 0 : 4), y + i, 1, 4)
					}
				},
			},
		})

		api.registerBlock({
			id: ROOF_ID,
			name: 'Gold Tile',
			category: 'Builder',
			draw: {
				side(ctx, x, y, S) {
					ctx.fillStyle = '#c8a020'
					ctx.fillRect(x, y, S, S)
				},
				top(ctx, x, y, S) {
					ctx.fillStyle = '#e0b830'
					ctx.fillRect(x, y, S, S)
				},
			},
		})

		api.registerBlock({
			id: GLASS_ID,
			name: 'Window Glass',
			category: 'Builder',
			transparent: true,
			draw: {
				side(ctx, x, y, S) {
					ctx.fillStyle = 'rgba(160,210,240,0.35)'
					ctx.fillRect(x, y, S, S)
					ctx.fillStyle = 'rgba(200,230,255,0.6)'
					ctx.fillRect(x, y, S, 1)
					ctx.fillRect(x, y, 1, S)
				},
			},
		})

		api.registerBlock({
			id: COUCH_ID,
			name: 'Couch',
			category: 'Builder',
			draw: {
				top(ctx, x, y, S) {
					ctx.fillStyle = '#6a3010'
					ctx.fillRect(x, y, S, S)
					ctx.fillStyle = '#8b4820'
					ctx.fillRect(x + 1, y + 1, S - 2, S - 2)
				},
				side(ctx, x, y, S) {
					ctx.fillStyle = '#6a3010'
					ctx.fillRect(x, y, S, S)
				},
			},
		})

		api.registerBlock({
			id: PLANT_ID,
			name: 'Plant',
			category: 'Builder',
			transparent: true,
			draw: {
				side(ctx, x, y, S) {
					ctx.fillStyle = '#1a8a1a'
					ctx.fillRect(x + S / 2 - 1, y, 2, S)
					ctx.fillRect(x, y + S / 2 - 1, S, 2)
					ctx.fillStyle = '#2aaa2a'
					ctx.fillRect(x + S / 4, y + S / 4, S / 2, S / 2)
				},
			},
		})

		// ── Tool ──────────────────────────────────────────────────────────
		api.registerTool({
			name: 'Builder',
			damage: 0,

			draw(ctx) {
				// Roof
				ctx.fillStyle = '#c8a020'
				ctx.beginPath()
				ctx.moveTo(1, 7)
				ctx.lineTo(8, 0)
				ctx.lineTo(15, 7)
				ctx.closePath()
				ctx.fill()
				// Walls
				ctx.fillStyle = '#b0b8c0'
				ctx.fillRect(2, 7, 12, 9)
				// Door
				ctx.fillStyle = '#4a2800'
				ctx.fillRect(6, 10, 4, 6)
				// Windows
				ctx.fillStyle = 'rgba(160,210,240,0.8)'
				ctx.fillRect(3, 8, 2, 3)
				ctx.fillRect(11, 8, 2, 3)
			},

			onLeftClick(toolCtx) {
				const pos = api.camera.getWorldPosition(new THREE.Vector3())
				const dir = new THREE.Vector3()
				api.camera.getWorldDirection(dir)

				const bx = Math.floor(pos.x + dir.x * 4)
				const by = Math.floor(pos.y) - 1
				const bz = Math.floor(pos.z + dir.z * 4)

				buildHouse(toolCtx, bx, by, bz)
			},
		})

		function buildHouse(toolCtx, baseX, baseY, baseZ) {
			const size = 6
			const height = 4
			const AIR = toolCtx.BLOCK.AIR
			const blocks = []

			// STĚNY + PODLAHA + STROP
			for (let x = 0; x < size; x++) {
				for (let y = 0; y <= height; y++) {
					for (let z = 0; z < size; z++) {
						const isWall =
							x === 0 || x === size - 1 ||
							z === 0 || z === size - 1 ||
							y === 0 || y === height
						if (isWall) blocks.push([baseX + x, baseY + y, baseZ + z, WALL_ID])
					}
				}
			}

			// DVEŘE
			blocks.push([baseX + 3, baseY + 1, baseZ + 0, AIR])
			blocks.push([baseX + 3, baseY + 2, baseZ + 0, AIR])

			// OKNA
			for (const [x, y, z] of [
				[0, 2, 2], [0, 3, 2], [0, 2, 3], [0, 3, 3],
				[5, 2, 2], [5, 3, 2], [5, 2, 3], [5, 3, 3],
			]) blocks.push([baseX + x, baseY + y, baseZ + z, GLASS_ID])

			// STŘECHA
			for (let x = 0; x < size; x++) {
				for (let z = 0; z < size; z++) {
					blocks.push([baseX + x, baseY + height, baseZ + z, ROOF_ID])
				}
			}

			// GAUČ
			blocks.push([baseX + 2, baseY + 1, baseZ + 2, COUCH_ID])
			blocks.push([baseX + 3, baseY + 1, baseZ + 2, COUCH_ID])

			// DEKORACE
			blocks.push([baseX + 1, baseY + 1, baseZ + 1, PLANT_ID])
			blocks.push([baseX + 4, baseY + 1, baseZ + 4, PLANT_ID])

			toolCtx.setBlocks(blocks)
		}
	},
})
