/**
 * Voxel World Plugin
 *
 * Fuel Canister — a pressurised liquid-fuel tank for your spaceship.
 *
 *   • Equip a Fuel Canister tool and right-click a surface to place a tank.
 *     The tank lies ALONG the direction you are looking (its long axis points
 *     away from you). Two sizes:
 *       – Small  (3×1):  3000 L
 *       – Large  (3×2):  6000 L
 *   • Each tank shows its CAPACITY on a painted side plate and its CURRENT fuel
 *     level on a sight-glass gauge whose amber column rises/falls with the tank.
 *   • Look at any canister (within ~7 blocks) for an exact readout on a HUD bar.
 *   • Any Rocket Engine inside the 10×10×10 box around a canister DRAINS it at
 *     50 L/s (per engine). Tanks also TOP THEMSELVES UP at 25 L/s.
 *   • Equip the Fuel Pump and right-click a canister to top it up 1000 L per
 *     click.
 *
 * Each canister is a single `invisible` solid anchor block (one block ID per
 * size × cardinal facing, so the size + orientation survive in the world's
 * modified-block diff); the oversized THREE.js mesh below is the only visual,
 * exactly like the Rocket Engine. Purely client-side — nothing networked.
 *
 * Efficiency: geometry + materials are shared template clones. The per-tank
 * liquid column is animated with a cheap `scale.y` (no per-tank canvas/texture);
 * the capacity plate uses one shared static texture per size. The drain/refill
 * simulation (the only part that scans `modified` for engines) is throttled to
 * 5 Hz and skipped entirely when no canister state exists. The look-up readout
 * is one raycast per frame, run only while canisters are on screen.
 */

/* global VoxelWorld, THREE, modified, scene, camera, player, RENDER_DISTANCE, CHUNK_SIZE, blockIdsByName, showToast */

VoxelWorld.registerPlugin('FuelCanister', {
	init(api) {
		// ── Tunables (litres / second) ────────────────────────────────────
		const DRAIN_PER_ENGINE = 50    // each rocket engine in range drains this
		const AUTO_REFILL       = 25   // passive self-refuel
		const REFILL_PER_CLICK  = 1000 // Fuel Pump right-click tops up this much
		const ENGINE_HALF       = 5    // 10×10×10 box → ±5 cells around the tank
		const SIM_STEP          = 0.2  // run the (modified-scanning) sim at 5 Hz
		const LOOK_DIST         = 7    // max distance to read / pump a canister

		// ── Size configs ──────────────────────────────────────────────────
		const SIZES = {
			small: {
				cap: 3000, len: 2.7, r: 0.42, cy: 0.55,
				gaugeH: 0.55, accent: 0x3a78c8,
				name: 'Fuel Canister 3000L', label: 'FUEL  3000 L',
			},
			big: {
				cap: 6000, len: 2.7, r: 0.62, cy: 1.05,
				gaugeH: 0.70, accent: 0xc8503a,
				name: 'Fuel Canister 6000L', label: 'FUEL  6000 L',
			},
		}

		// One block ID per size × cardinal facing. (dx,dz) is the tank's long
		// axis — the direction you were looking when you placed it.
		const DIRS = [
			{ dx: 0, dz: 1 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 },
		]
		const VARIANTS = []   // { size, cfg, dx, dz, id }
		for (const size of ['small', 'big']) {
			for (const d of DIRS) {
				VARIANTS.push({ size, cfg: SIZES[size], dx: d.dx, dz: d.dz, id: api.allocateBlockId() })
			}
		}
		const idInfo = new Map()          // id → { cfg, size, cap, label }
		const ID_SET = new Set()
		const sizeDirToId = new Map()     // `${size}|${dx},${dz}` → id
		for (const v of VARIANTS) {
			idInfo.set(v.id, { cfg: v.cfg, size: v.size, cap: v.cfg.cap, label: v.cfg.name })
			ID_SET.add(v.id)
			sizeDirToId.set(v.size + '|' + v.dx + ',' + v.dz, v.id)
		}

		// invisible → no chunk mesh (custom mesh below); solid for collision +
		// clickable pick faces. All facings of a size share one name so /remove
		// and /blocks treat them as a single block.
		for (const v of VARIANTS) {
			api.registerBlock({ id: v.id, name: v.cfg.name, category: 'Crafted', invisible: true })
		}

		// ── Shared materials (never disposed — no per-instance resources) ──
		const legMat    = new THREE.MeshLambertMaterial({ color: 0x40464d })
		const capMat    = new THREE.MeshLambertMaterial({ color: 0x9aa2aa })
		const glassMat  = new THREE.MeshLambertMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.28 })
		const liquidMat = new THREE.MeshBasicMaterial({ color: 0xffae2a })   // self-lit fuel
		// Steel body + accent band, one per size (colours differ slightly).
		const bodyMat = {
			small: new THREE.MeshLambertMaterial({ color: 0xc2c8ce }),
			big:   new THREE.MeshLambertMaterial({ color: 0xc6cace }),
		}
		const bandMat = {
			small: new THREE.MeshLambertMaterial({ color: SIZES.small.accent }),
			big:   new THREE.MeshLambertMaterial({ color: SIZES.big.accent }),
		}

		// One static capacity-plate texture per size (shared by every tank of
		// that size — capacity is fixed, so this never needs redrawing).
		function makeLabelTex(text, accent) {
			const cv = document.createElement('canvas')
			cv.width = 256; cv.height = 96
			const c = cv.getContext('2d')
			c.fillStyle = '#1b1f24'; c.fillRect(0, 0, 256, 96)
			c.strokeStyle = '#' + accent.toString(16).padStart(6, '0')
			c.lineWidth = 8; c.strokeRect(6, 6, 244, 84)
			c.fillStyle = '#ffd27a'
			c.font = 'bold 32px sans-serif'
			c.textAlign = 'center'; c.textBaseline = 'middle'
			c.fillText(text, 128, 52)
			const tex = new THREE.CanvasTexture(cv)
			tex.minFilter = THREE.LinearFilter
			return new THREE.MeshBasicMaterial({ map: tex })
		}
		const labelMat = {
			small: makeLabelTex(SIZES.small.label, SIZES.small.accent),
			big:   makeLabelTex(SIZES.big.label, SIZES.big.accent),
		}

		// ── Build a tank's geometry (canonical: long axis along +Z) ─────────
		// Returns { parts:[[geo,mat,posY?], …], liquidIndex }. The liquid column
		// is the one part with a posY (so its mesh keeps a position and scales
		// from its base); everything else bakes its offset into the geometry.
		function buildTank(cfg, size) {
			const parts = []
			const r = cfg.r, len = cfg.len, cy = cfg.cy
			const body = bodyMat[size], band = bandMat[size]

			// Main cylindrical body, lying along Z.
			const bodyGeo = new THREE.CylinderGeometry(r, r, len, 20)
			bodyGeo.rotateX(Math.PI / 2)
			bodyGeo.translate(0, cy, 0)
			parts.push([bodyGeo, body])

			// Domed end caps.
			for (const sz of [-1, 1]) {
				const cap = new THREE.SphereGeometry(r, 18, 12)
				cap.translate(0, cy, sz * len / 2)
				parts.push([cap, body])
			}

			// Accent bands wrapping the body (torus axis = Z, no rotation needed).
			for (const bz of [-0.8, 0, 0.8]) {
				const ring = new THREE.TorusGeometry(r + 0.015, 0.045, 8, 22)
				ring.translate(0, cy, bz)
				parts.push([ring, band])
			}

			// Saddle legs down to the floor.
			const legH = cy - r * 0.55
			for (const lz of [-len * 0.3, len * 0.3]) {
				const leg = new THREE.BoxGeometry(r * 1.7, legH, 0.3)
				leg.translate(0, legH / 2, lz)
				parts.push([leg, legMat])
			}

			// Capacity plates on both long sides (outward faces show the label).
			// Stood off past the bands (outer radius r + 0.06) so the middle ring
			// doesn't poke through the sign.
			for (const sx of [-1, 1]) {
				const plate = new THREE.BoxGeometry(0.03, 0.5, 1.5)
				plate.translate(sx * (r + 0.1), cy, 0)
				parts.push([plate, labelMat[size]])
			}

			// ── Sight-glass gauge on top: glass tube + caps + amber column ──
			const y0 = cy + r + 0.02          // gauge base sits on top of the tank
			const gH = cfg.gaugeH
			const tube = new THREE.CylinderGeometry(0.1, 0.1, gH + 0.06, 14, 1, true)
			tube.translate(0, y0 + gH / 2, 0)
			parts.push([tube, glassMat])
			for (const cyc of [y0, y0 + gH]) {
				const disc = new THREE.CylinderGeometry(0.12, 0.12, 0.05, 14)
				disc.translate(0, cyc, 0)
				parts.push([disc, capMat])
			}
			// Liquid column: base at local origin so scale.y grows it upward from
			// the gauge base. posY positions the mesh; default full (scale.y = 1).
			const liquid = new THREE.CylinderGeometry(0.07, 0.07, gH, 12)
			liquid.translate(0, gH / 2, 0)
			const liquidIndex = parts.length
			parts.push([liquid, liquidMat, y0])

			return { parts, liquidIndex }
		}

		// Build canonical parts once per size, then a rotated template per facing.
		const built = { small: buildTank(SIZES.small, 'small'), big: buildTank(SIZES.big, 'big') }
		const templates = new Map()   // id → { group, liquidIndex }
		for (const v of VARIANTS) {
			const b = built[v.size]
			const g = new THREE.Group()
			for (const [geo, mat, posY] of b.parts) {
				const m = new THREE.Mesh(geo, mat)
				if (posY !== undefined) m.position.y = posY
				g.add(m)
			}
			g.rotation.y = Math.atan2(v.dx, v.dz)   // +Z canonical → (dx,dz)
			templates.set(v.id, { group: g, liquidIndex: b.liquidIndex })
		}

		// ── State ───────────────────────────────────────────────────────────
		const fuelByKey = new Map()       // "x_y_z" → litres (client-only, not persisted)
		const canisterMeshes = new Map()  // "x_y_z" → THREE.Group
		let _scanKeys = new Set()
		const _visibleKeys = new Set()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE

		// Rocket-engine block IDs are resolved lazily by name (the engine plugin
		// may load after us). Cache once we get a non-empty set — they're fixed.
		let rocketIds = null
		function getRocketIds() {
			if (rocketIds && rocketIds.size) return rocketIds
			const ids = blockIdsByName('Rocket Engine')   // Set of all 6 orientations
			if (ids && ids.size) rocketIds = ids
			return rocketIds || ids || new Set()
		}

		// ── Look-up readout (one raycast/frame, gated on visible canisters) ──
		const hud = document.createElement('div')
		hud.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);' +
			'font:bold 15px sans-serif;color:#ffd27a;background:rgba(8,12,18,0.78);' +
			'padding:6px 14px;border-radius:8px;border:1px solid rgba(255,210,122,0.4);' +
			'pointer-events:none;z-index:50;display:none;white-space:nowrap;'
		document.body.appendChild(hud)

		const _rc = new THREE.Raycaster()
		_rc.far = LOOK_DIST
		const _origin = new THREE.Vector2(0, 0)
		const _lookArr = []
		let lookedKey = null

		function fmt(n) { return Math.round(n).toLocaleString('en-US') }

		function updateLook() {
			lookedKey = null
			if (canisterMeshes.size === 0) { hud.style.display = 'none'; return }
			_lookArr.length = 0
			for (const g of canisterMeshes.values()) _lookArr.push(g)
			_rc.setFromCamera(_origin, camera)
			const hits = _rc.intersectObjects(_lookArr, true)
			if (hits.length) {
				let o = hits[0].object
				while (o && o.userData.fuelKey === undefined) o = o.parent
				if (o) lookedKey = o.userData.fuelKey
			}

			if (lookedKey === null) { hud.style.display = 'none'; return }
			const info = idInfo.get(modified.get(lookedKey))
			const l = fuelByKey.get(lookedKey)
			if (!info || l === undefined) { hud.style.display = 'none'; return }
			const pct = Math.round((l / info.cap) * 100)
			const low = l < info.cap * 0.15
			hud.style.display = 'block'
			hud.style.color = low ? '#ff6b5a' : '#ffd27a'
			hud.textContent = '⛽ ' + info.label + '  —  ' + fmt(l) + ' / ' + fmt(info.cap) +
				' L  (' + pct + '%)'
		}

		// ── Drain + refill simulation (throttled; scans modified for engines) ─
		let simAcc = 0
		const _engines = []   // flat [x,y,z, x,y,z, …] — reused, no per-step alloc

		function runSim(dt) {
			if (fuelByKey.size === 0) return
			const rids = getRocketIds()

			_engines.length = 0
			if (rids.size) {
				for (const [k, v] of modified) {
					if (rids.has(v)) {
						const p = k.split('_')
						_engines.push(+p[0], +p[1], +p[2])
					}
				}
			}

			for (const [k, l] of fuelByKey) {
				const info = idInfo.get(modified.get(k))
				if (!info) { fuelByKey.delete(k); continue }   // mined or replaced
				const p = k.split('_')
				const cx = +p[0], cy = +p[1], cz = +p[2]
				let n = 0
				for (let i = 0; i < _engines.length; i += 3) {
					if (Math.abs(_engines[i] - cx) <= ENGINE_HALF &&
						Math.abs(_engines[i + 1] - cy) <= ENGINE_HALF &&
						Math.abs(_engines[i + 2] - cz) <= ENGINE_HALF) n++
				}
				let f = l - n * DRAIN_PER_ENGINE * dt + AUTO_REFILL * dt
				if (f < 0) f = 0
				else if (f > info.cap) f = info.cap
				fuelByKey.set(k, f)
			}
		}

		// ── Per-frame: mesh sync, liquid level, look-up; sim on a 5 Hz tick ──
		api.addTickCallback((dt) => {
			if (dt > 0.25) dt = 0.25

			// Sync THREE.js meshes to placed canister blocks.
			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (ID_SET.has(v)) _scanKeys.add(k)
			}
			_visibleKeys.clear()
			for (const k of _scanKeys) {
				const [x, y, z] = k.split('_').map(Number)
				if (Math.abs(x - player.pos.x) > CULL_DIST || Math.abs(z - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)
				if (!fuelByKey.has(k)) fuelByKey.set(k, idInfo.get(modified.get(k)).cap)   // start full
				if (!canisterMeshes.has(k)) {
					const t = templates.get(modified.get(k))
					const mesh = t.group.clone()
					mesh.position.set(x + 0.5, y, z + 0.5)
					mesh.userData.fuelKey = k
					mesh.userData.liquid = mesh.children[t.liquidIndex]
					scene.add(mesh)
					canisterMeshes.set(k, mesh)
				}
			}
			for (const [k, mesh] of canisterMeshes) {
				if (!_visibleKeys.has(k)) {
					scene.remove(mesh)
					canisterMeshes.delete(k)   // shared geo/material — nothing per-instance to dispose
				}
			}

			// Cheap per-tank liquid column update (scale only).
			for (const [k, mesh] of canisterMeshes) {
				const info = idInfo.get(modified.get(k))
				const l = fuelByKey.get(k)
				if (info && l !== undefined) {
					mesh.userData.liquid.scale.y = Math.max(0.0001, Math.min(1, l / info.cap))
				}
			}

			updateLook()

			simAcc += dt
			if (simAcc >= SIM_STEP) { runSim(simAcc); simAcc = 0 }
		})

		// ── Placement helper: tank lies along your look direction ───────────
		const _lookDir = new THREE.Vector3()
		function placeCanister(ctx, size) {
			const f = ctx.facing
			if (!f) return
			if (ID_SET.has(f.type)) return   // don't stack onto a canister face
			const bx = f.x + f.nx, by = f.y + f.ny, bz = f.z + f.nz
			if (ctx.getBlock(bx, by, bz) !== null) return   // cell occupied

			camera.getWorldDirection(_lookDir)
			let dx = 0, dz = 0
			if (Math.abs(_lookDir.x) >= Math.abs(_lookDir.z)) dx = Math.sign(_lookDir.x) || 1
			else dz = Math.sign(_lookDir.z) || 1

			const id = sizeDirToId.get(size + '|' + dx + ',' + dz)
			if (id === undefined) return
			ctx.setBlock(bx, by, bz, id)
		}

		// ── Tool icons ──────────────────────────────────────────────────────
		function drawTankIcon(c, W, H, accent, big) {
			c.clearRect(0, 0, W, H)
			const s = W / 16
			const y = big ? 4 : 6, h = big ? 8 : 5
			// horizontal tank body
			c.fillStyle = '#c2c8ce'
			c.fillRect(2 * s, y * s, 12 * s, h * s)
			// rounded ends
			c.beginPath(); c.arc(2 * s, (y + h / 2) * s, (h / 2) * s, 0, Math.PI * 2); c.fill()
			c.beginPath(); c.arc(14 * s, (y + h / 2) * s, (h / 2) * s, 0, Math.PI * 2); c.fill()
			// accent bands
			c.fillStyle = '#' + accent.toString(16).padStart(6, '0')
			c.fillRect(6 * s, y * s, 1 * s, h * s)
			c.fillRect(10 * s, y * s, 1 * s, h * s)
			// amber gauge column on top
			c.fillStyle = '#ffae2a'
			c.fillRect(7.5 * s, (y - 3) * s, 1 * s, 3 * s)
			c.fillStyle = '#bfe0ff'
			c.strokeStyle = '#bfe0ff'; c.lineWidth = Math.max(1, s * 0.3)
			c.strokeRect(7 * s, (y - 3) * s, 2 * s, 3 * s)
			// legs
			c.fillStyle = '#40464d'
			c.fillRect(4 * s, (y + h) * s, 1.5 * s, (15 - (y + h)) * s)
			c.fillRect(10.5 * s, (y + h) * s, 1.5 * s, (15 - (y + h)) * s)
		}
		function makeIcon(draw) {
			const cv = document.createElement('canvas')
			cv.width = cv.height = 64
			draw(cv.getContext('2d'), 64, 64)
			return cv.toDataURL()
		}

		api.registerTool({
			name: 'Fuel Canister 3000L',
			url: makeIcon((c, W, H) => drawTankIcon(c, W, H, SIZES.small.accent, false)),
			damage: 0,
			onRightClick(ctx) { placeCanister(ctx, 'small') },
		})
		api.registerTool({
			name: 'Fuel Canister 6000L',
			url: makeIcon((c, W, H) => drawTankIcon(c, W, H, SIZES.big.accent, true)),
			damage: 0,
			onRightClick(ctx) { placeCanister(ctx, 'big') },
		})

		// ── Fuel Pump: right-click a tank to top it up 1000 L per click ─────
		api.registerTool({
			name: 'Fuel Pump',
			url: makeIcon((c, W, H) => {
				c.clearRect(0, 0, W, H)
				const s = W / 16
				c.fillStyle = '#c8503a'                       // pump body
				c.fillRect(3 * s, 5 * s, 6 * s, 9 * s)
				c.fillStyle = '#1b1f24'                       // display
				c.fillRect(4 * s, 6 * s, 4 * s, 3 * s)
				c.fillStyle = '#ffae2a'; c.fillRect(4.5 * s, 6.5 * s, 3 * s, 1 * s)
				c.strokeStyle = '#40464d'; c.lineWidth = Math.max(1, s)   // hose + nozzle
				c.beginPath(); c.moveTo(9 * s, 7 * s); c.lineTo(13 * s, 7 * s); c.lineTo(13 * s, 11 * s); c.stroke()
				c.fillStyle = '#9aa2aa'; c.fillRect(12 * s, 11 * s, 2 * s, 3 * s)
			}),
			damage: 0,
			onRightClick(ctx) {
				const f = ctx.facing
				if (!f || !ID_SET.has(f.type)) return   // must be aiming at a canister
				const key = f.x + '_' + f.y + '_' + f.z
				const info = idInfo.get(f.type)
				const cur = fuelByKey.get(key)
				if (!info || cur === undefined) return
				const next = Math.min(info.cap, cur + REFILL_PER_CLICK)
				fuelByKey.set(key, next)
				showToast('⛽ +' + fmt(next - cur) + ' L  ·  ' + fmt(next) + ' / ' + fmt(info.cap) + ' L')
			},
		})

		console.log('[FuelCanister] registered ids ' + VARIANTS.map((v) => v.id).join(','))
	},
})
