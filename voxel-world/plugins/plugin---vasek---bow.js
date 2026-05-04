/**
 * Voxel World Plugin — Bow
 *
 * Hold the Place / right-mouse button to draw the bow (minimum 0.2 s charge).
 * Release to shoot. The arrow hits the first mob, player, or block in the
 * camera's line of sight up to 48 blocks away.
 *
 * Entity hits:  hitscan damage sent immediately via the normal hit messages.
 * Block hits:   arrow sticks for a moment then disappears.
 * Visual arrow: flies from the player's eye to the impact point, client-side only.
 *
 * Two visual states — idle bow and drawn bow — are pre-loaded so the swap is
 * instant. Damage scales linearly from 3 (min charge) to 10 (full charge).
 */

VoxelWorld.registerPlugin('Bow', {
	async init(api) {

		// ── Sprite draw helpers ────────────────────────────────────────────
		function drawBowSprite(ctx, W, H, drawn) {
			ctx.clearRect(0, 0, W, H)
			ctx.save()
			ctx.translate(W / 2, H / 2)
			ctx.rotate(Math.PI / 2 + Math.PI)   // 270° clockwise
			ctx.translate(-W / 2, -H / 2)

			// Bow stave — pixel-art arc (stave on right, string faces player after rotation)
			ctx.fillStyle = '#7B3F00'
			const stave = [
				[5, 0], [4, 1], [3, 2], [3, 3], [2, 4], [2, 5], [2, 6],
				[2, 7], [2, 8], [2, 9], [2, 10], [3, 11], [3, 12], [4, 13], [5, 14], [5, 15],
			]
			for (const [x, y] of stave) ctx.fillRect(15 - x, y, 1, 1)

			// Bowstring — straight when idle, pulled back (toward player) when drawn
			ctx.fillStyle = '#E8D8A0'
			const pull = drawn ? 4 : 0
			for (let y = 0; y <= 15; y++) {
				const frac = Math.abs(y - 7.5) / 7.5
				const x = Math.round(10 - pull * (1 - frac))
				ctx.fillRect(x, y, 1, 1)
			}

			// Nocked arrow only when drawn — horizontal, tip on the right
			if (drawn) {
				ctx.fillStyle = '#C8A060'
				for (let x = 7; x <= 13; x++) ctx.fillRect(x, 7, 1, 1)
				ctx.fillStyle = '#909090'
				ctx.fillRect(13, 6, 1, 1)
				ctx.fillRect(14, 7, 1, 1)
				ctx.fillRect(13, 8, 1, 1)
			}

			ctx.restore()
		}

		// Pre-load both visual states.
		const [idleV, drawnV] = await Promise.all([
			api.preloadToolVisual({ draw: (ctx, W, H) => drawBowSprite(ctx, W, H, false) }),
			api.preloadToolVisual({ draw: (ctx, W, H) => drawBowSprite(ctx, W, H, true) }),
		])

		let chargeStart = -1   // performance.now() when right was pressed; -1 = not charging

		const MIN_CHARGE_MS = 200    // below this the shot is cancelled
		const MAX_CHARGE_MS = 1000   // full charge
		const MIN_DAMAGE = 3
		const MAX_DAMAGE = 10
		const ARROW_SPEED = 36     // blocks / second
		const MAX_RANGE = 48     // blocks

		// ── Arrow 3-D model ───────────────────────────────────────────────
		function makeArrowMesh() {
			const g = new THREE.Group()

			const shaftGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6)
			const woodMat = new THREE.MeshLambertMaterial({ color: 0xC8A060 })
			const shaft = new THREE.Mesh(shaftGeo, woodMat)
			// Cylinder is Y-up by default; rotate so it lies along Z (forward).
			shaft.rotation.x = Math.PI / 2
			g.add(shaft)

			const tipGeo = new THREE.ConeGeometry(0.04, 0.14, 6)
			const tipMat = new THREE.MeshLambertMaterial({ color: 0x888888 })
			const tip = new THREE.Mesh(tipGeo, tipMat)
			// rotation.x = -π/2 puts the cone apex at -Z (toward target)
			tip.rotation.x = -Math.PI / 2
			tip.position.z = -0.46
			g.add(tip)

			// Two crossed feather planes at the tail (+Z = away from target)
			const featherMat = new THREE.MeshLambertMaterial({ color: 0xEEEEEE, side: THREE.DoubleSide })
			for (let i = 0; i < 2; i++) {
				const fGeo = new THREE.PlaneGeometry(0.06, 0.14)
				const feather = new THREE.Mesh(fGeo, featherMat)
				feather.rotation.x = Math.PI / 2
				feather.rotation.z = i * Math.PI / 2
				feather.position.z = 0.36
				g.add(feather)
			}

			return g
		}

		// ── Launch a visual arrow ─────────────────────────────────────────
		function launchArrowVisual(startPos, direction, targetPos) {
			const arrow = makeArrowMesh()
			const forward = direction.clone().normalize()

			// Orient the arrow group so its -Z faces the direction of travel (apex at -Z).
			arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), forward)
			arrow.position.copy(startPos)
			api.scene.add(arrow)

			const totalDist = startPos.distanceTo(targetPos)
			let traveled = 0

			function tick(dt) {
				traveled += ARROW_SPEED * dt
				if (traveled >= totalDist) {
					arrow.traverse(obj => {
						obj.geometry?.dispose()
						if (obj.material) [].concat(obj.material).forEach(m => m.dispose())
					})
					api.scene.remove(arrow)
					api.removeTickCallback(tick)
					return
				}
				const frac = traveled / totalDist
				arrow.position.copy(startPos).addScaledVector(forward, traveled)
				// Slight gravity arc — peaks at midpoint
				arrow.position.y += Math.sin(frac * Math.PI) * totalDist * 0.04
			}
			api.addTickCallback(tick)
		}

		// ── Tool definition ───────────────────────────────────────────────
		api.registerTool({
			name: 'Bow',
			draw: (ctx, W, H) => drawBowSprite(ctx, W, H, false),
			damage: 0,   // damage is computed on release, not from the default hit path

			onRightClick(ctx) {
				chargeStart = performance.now()
				ctx.setToolVisual(drawnV)
				ctx.setAimMode(true)
			},

			onRightUp(ctx) {
				if (chargeStart < 0) return
				const elapsed = performance.now() - chargeStart
				chargeStart = -1
				ctx.setToolVisual(idleV)
				ctx.setAimMode(false)

				if (elapsed < MIN_CHARGE_MS) return   // too short — cancelled

				const chargeFrac = Math.min(elapsed / MAX_CHARGE_MS, 1)
				const damage = Math.round(MIN_DAMAGE + (MAX_DAMAGE - MIN_DAMAGE) * chargeFrac)

				// Hitscan — find what the camera is pointing at
				const hit = api.shootRay(MAX_RANGE)

				// Start the arrow at world-space eye level, 0.3 blocks in front of camera
				const camDir = new THREE.Vector3()
				api.camera.getWorldDirection(camDir)
				const startPos = api.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(camDir, 0.3)

				let targetPos
				if (hit) {
					targetPos = hit.point

					if (hit.type === 'mob') {
						api.netSend({ type: 'ranged_hit_mob', mobId: hit.id, damage })
					} else if (hit.type === 'player') {
						api.netSend({ type: 'ranged_hit_player', targetId: hit.id, damage })
					}
					// Block hit: arrow just flies to the surface and disappears
				} else {
					// No hit — fly to max range
					targetPos = startPos.clone().addScaledVector(camDir, MAX_RANGE)
				}

				launchArrowVisual(startPos, camDir, targetPos)
			},
		})
	},
})
