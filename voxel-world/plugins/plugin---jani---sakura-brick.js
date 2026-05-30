/**
 * Voxel World Plugin — Sakura Brick
 *
 * A cute, light-coloured building block: a pale grey brick wall sprinkled with
 * little pink cherry-blossom (sakura) flowers. The whole tile is painted
 * procedurally into the atlas (deterministic, no network textures, no engine
 * internals touched) — same pure-api approach as the concrete and lava blocks.
 *
 * The brick courses use a running-bond layout that tiles seamlessly, and the
 * flowers are drawn with wrap-around pixels so blossoms that fall off one edge
 * reappear on the opposite edge — every face and every neighbouring block lines
 * up cleanly.
 */

/* global VoxelWorld */

VoxelWorld.registerPlugin('SakuraBrick', {
	init(api) {
		const ID = api.allocateBlockId()

		// ── Palette ───────────────────────────────────────────────────────
		const BRICK_LIGHT = '#dadad8'   // light grey brick face
		const BRICK_DARK  = '#cccccb'   // faint per-brick shade variation
		const MORTAR      = '#b6b6b4'   // grey mortar between bricks
		const PETAL_LIGHT = '#ffd6e8'   // soft sakura pink
		const PETAL_DEEP  = '#ff9ec6'   // deeper pink at the petal tips
		const FLOWER_EYE  = '#ffd76b'   // tiny golden centre
		const VINE_LIGHT  = '#a8d878'   // light green vine
		const VINE_DARK   = '#7cb858'   // shaded green / little leaves

		// One brick course is 4px tall + 1px mortar; vertical joints every 8px,
		// offset half a brick on alternate courses (classic running bond). With
		// S=16 this wraps perfectly: 16 / (4+1) is not integer, so we drive the
		// pattern off absolute pixel rows mod the 5px course and 8px brick width.
		function paintBrick(ctx, x, y, S) {
			for (let py = 0; py < S; py++) {
				const courseRow = py % 5            // 0..3 brick, 4 = mortar line
				const course    = Math.floor(py / 5)
				const offset    = (course & 1) ? 4 : 0   // stagger alternate rows
				for (let px = 0; px < S; px++) {
					let col
					if (courseRow === 4) {
						col = MORTAR                          // horizontal joint
					} else if (((px + offset) % 8) === 0) {
						col = MORTAR                          // vertical joint
					} else {
						// subtle checker so individual bricks read apart
						const brick = Math.floor((px + offset) / 8) + course
						col = (brick & 1) ? BRICK_LIGHT : BRICK_DARK
					}
					ctx.fillStyle = col
					ctx.fillRect(x + px, y + py, 1, 1)
				}
			}
		}

		// Set one pixel, wrapping around the tile so blossoms tile across edges.
		function wrapPixel(ctx, x, y, S, px, py, col) {
			const wx = ((px % S) + S) % S
			const wy = ((py % S) + S) % S
			ctx.fillStyle = col
			ctx.fillRect(x + wx, y + wy, 1, 1)
		}

		// A little 5-ish petal blossom centred on (cx,cy). Corners are skipped to
		// round it off; the outer ring is the deeper pink (petal tips), the inner
		// ring soft pink, with a single golden pixel in the middle.
		function drawSakura(ctx, x, y, S, cx, cy) {
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue  // clip corners
					let col
					if (dx === 0 && dy === 0)            col = FLOWER_EYE
					else if (Math.abs(dx) === 2 || Math.abs(dy) === 2) col = PETAL_DEEP
					else                                  col = PETAL_LIGHT
					wrapPixel(ctx, x, y, S, cx + dx, cy + dy, col)
				}
			}
		}

		// A tiny 3-pixel bud for a bit of scatter between the full blossoms.
		function drawBud(ctx, x, y, S, cx, cy) {
			wrapPixel(ctx, x, y, S, cx,     cy,     PETAL_LIGHT)
			wrapPixel(ctx, x, y, S, cx + 1, cy,     PETAL_DEEP)
			wrapPixel(ctx, x, y, S, cx,     cy + 1, PETAL_DEEP)
		}

		// A wavy vine that trails straight down the wall, weaving between the
		// blossoms. The horizontal sway is driven by sin() of the row, so it is
		// fully deterministic and wraps cleanly with wrapPixel. Every few rows a
		// small leaf branches off to one side.
		function drawVine(ctx, x, y, S, baseX, phase, leafSide) {
			for (let py = 0; py < S; py++) {
				const sway = Math.round(1.5 * Math.sin(py * 0.85 + phase))
				const vx   = baseX + sway
				wrapPixel(ctx, x, y, S, vx, py, (py & 1) ? VINE_LIGHT : VINE_DARK)
				// little leaf every 4 rows, alternating which way it points
				if (py % 4 === 1) {
					wrapPixel(ctx, x, y, S, vx + leafSide, py, VINE_LIGHT)
					wrapPixel(ctx, x, y, S, vx + leafSide, py - 1, VINE_DARK)
				}
			}
		}

		// Shared blossom layer (used by every face).
		function paintBlossoms(ctx, x, y, S) {
			// Fixed, hand-placed blossoms — spaced out and wrapping at the edges
			// so the block tiles nicely in every direction.
			drawSakura(ctx, x, y, S, 4, 3)
			drawSakura(ctx, x, y, S, 12, 10)
			drawBud(ctx, x, y, S, 10, 2)
			drawBud(ctx, x, y, S, 2, 12)
		}

		// Top & bottom faces: brick + blossoms, no vines.
		function paintSakuraBrick(ctx, x, y, S) {
			paintBrick(ctx, x, y, S)
			paintBlossoms(ctx, x, y, S)
		}

		// Side faces: brick, then trailing green vines, then blossoms on top so
		// the flowers sit amid the foliage.
		function paintSakuraBrickSide(ctx, x, y, S) {
			paintBrick(ctx, x, y, S)
			drawVine(ctx, x, y, S, 8, 0, 1)        // central strand, leaves right
			drawVine(ctx, x, y, S, 0, 2.1, -1)     // edge strand (wraps), leaves left
			paintBlossoms(ctx, x, y, S)
		}

		api.registerBlock({
			id:       ID,
			name:     'Sakura Brick',
			category: 'Building',
			draw: {
				side:   paintSakuraBrickSide,
				top:    paintSakuraBrick,
				bottom: paintSakuraBrick,
			},
		})

		console.log('[SakuraBrick] Registered (id=' + ID + ')')
	},
})
