/**
 * Voxel World Plugin
 *
 * Sign — a wooden sign on a stick.
 *   • Equip the Sign tool and right-click any surface to place a sign.
 *   • Right-click any sign (any tool) to open the text editor.
 *   • Up to 3 lines × 20 characters; text is visible to all players.
 *
 * Orientation is inferred from the placement surface normal (wall face)
 * or the camera yaw (floor / ceiling placement), matching door behaviour.
 */

/* global VoxelWorld, THREE, modified, player, RENDER_DISTANCE, CHUNK_SIZE */

VoxelWorld.registerPlugin('Sign', {
	async init(api) {
		const SIGN_Z = api.allocateBlockId()  // board faces ±Z axis
		const SIGN_X = api.allocateBlockId()  // board faces ±X axis

		const SIGN_IDS    = [SIGN_Z, SIGN_X]
		const SIGN_ID_SET = new Set(SIGN_IDS)

		// ── Block registration ────────────────────────────────────────────────
		for (const id of SIGN_IDS) {
			api.registerBlock({
				id,
				name:     'Sign',
				category: 'Crafted',
				invisible: true,
				passable:  true,
				draw: {
					side(ctx, x, y, S) {
						ctx.fillStyle = '#c8a45a'
						ctx.fillRect(x, y, S, S)
					},
				},
			})
		}

		// ── Sign text store: "x_y_z" → string[] (max 3 lines) ────────────────
		const signLines = new Map()

		// ── THREE.js shared geometry / material ───────────────────────────────
		const POST_GEO = new THREE.BoxGeometry(0.1, 0.5, 0.1)
		const BOARD_GEO = new THREE.BoxGeometry(0.8, 0.45, 0.06)
		const POST_MAT = new THREE.MeshLambertMaterial({ color: 0x5c3d1e })

		// Draws text onto an existing 128×64 canvas in-place.
		function drawSignCanvas(canvas, lines) {
			const ctx = canvas.getContext('2d')
			ctx.clearRect(0, 0, 128, 64)

			ctx.fillStyle = '#c8a45a'
			ctx.fillRect(0, 0, 128, 64)

			ctx.strokeStyle = '#8b6b2e'
			ctx.lineWidth = 2
			ctx.strokeRect(1, 1, 126, 62)

			ctx.strokeStyle = 'rgba(0,0,0,0.07)'
			ctx.lineWidth = 1
			for (let gy = 10; gy < 64; gy += 10) {
				ctx.beginPath(); ctx.moveTo(2, gy); ctx.lineTo(126, gy); ctx.stroke()
			}

			if (!lines || lines.length === 0) return
			ctx.fillStyle = '#1a0500'
			ctx.font = 'bold 11px monospace'
			ctx.textAlign = 'center'
			ctx.textBaseline = 'middle'
			const lineH = 18
			const startY = 32 - ((lines.length - 1) * lineH) / 2
			for (let i = 0; i < lines.length; i++) {
				ctx.fillText(lines[i], 64, startY + i * lineH)
			}
		}

		// Map from "x_y_z" → THREE.Group
		const signMeshes = new Map()
		const CULL_DIST = (RENDER_DISTANCE + 1) * CHUNK_SIZE

		function makeSignGroup(id, x, y, z) {
			const group = new THREE.Group()

			const post = new THREE.Mesh(POST_GEO, POST_MAT)
			post.position.set(0, 0.25, 0)
			group.add(post)

			const canvas = document.createElement('canvas')
			canvas.width = 128
			canvas.height = 64
			drawSignCanvas(canvas, signLines.get(`${x}_${y}_${z}`) || [])

			const tex = new THREE.CanvasTexture(canvas)
			tex.magFilter = THREE.NearestFilter
			const boardMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide })

			const board = new THREE.Mesh(BOARD_GEO, boardMat)
			board.position.set(0, 0.725, 0)
			if (id === SIGN_X) board.rotation.y = Math.PI / 2
			board.userData.canvas = canvas
			group.add(board)

			group.position.set(x + 0.5, y, z + 0.5)
			return group
		}

		function updateSignMesh(k, lines) {
			const group = signMeshes.get(k)
			if (!group) return
			const board = group.children[1]
			drawSignCanvas(board.userData.canvas, lines)
			board.material.map.needsUpdate = true
		}

		// ── Server message handlers ───────────────────────────────────────────
		api.onServerMessage('init', (msg) => {
			signLines.clear()
			for (const { k, lines } of msg.signs || []) {
				if (Array.isArray(lines) && lines.length > 0) signLines.set(k, lines)
			}
		})

		api.onServerMessage('sign_update', (msg) => {
			if (Array.isArray(msg.lines) && msg.lines.length > 0) {
				signLines.set(msg.k, msg.lines)
			} else {
				signLines.delete(msg.k)
			}
			updateSignMesh(msg.k, signLines.get(msg.k) || [])
		})

		// ── Tick: keep THREE.js meshes in sync with world state ───────────────
		// Reuse sets each frame to avoid per-tick GC pressure.
		// _scanKeys / _prevKeys alternate via pointer swap (no copy needed).
		let _scanKeys = new Set()
		let _prevKeys = new Set()
		const _visibleKeys = new Set()

		api.addTickCallback(() => {
			_scanKeys.clear()
			for (const [k, v] of modified) {
				if (SIGN_ID_SET.has(v)) _scanKeys.add(k)
			}

			// Detect mined signs and clean up server-side text
			for (const k of _prevKeys) {
				if (!_scanKeys.has(k) && signLines.has(k)) {
					signLines.delete(k)
					api.netSend({ type: 'sign_update', k, lines: [] })
				}
			}

			// Swap: _scanKeys becomes prev for next tick, _prevKeys becomes scratch
			const _tmp = _prevKeys; _prevKeys = _scanKeys; _scanKeys = _tmp

			// _prevKeys now holds the current sign keys; build visible set
			_visibleKeys.clear()
			for (const k of _prevKeys) {
				const parts = k.split('_').map(Number)
				if (Math.abs(parts[0] - player.pos.x) > CULL_DIST ||
					Math.abs(parts[2] - player.pos.z) > CULL_DIST) continue
				_visibleKeys.add(k)

				if (!signMeshes.has(k)) {
					const [bx, by, bz] = parts
					const group = makeSignGroup(modified.get(k), bx, by, bz)
					api.scene.add(group)
					signMeshes.set(k, group)
				}
			}

			// Remove off-screen / mined meshes and release GPU resources
			for (const [k, group] of signMeshes) {
				if (!_visibleKeys.has(k)) {
					api.scene.remove(group)
					const board = group.children[1]
					board.material.map?.dispose()
					board.material.dispose()
					signMeshes.delete(k)
				}
			}
		})

		// ── Edit GUI ──────────────────────────────────────────────────────────
		const overlay = document.createElement('div')
		overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9000;align-items:center;justify-content:center'

		const modal = document.createElement('div')
		modal.style.cssText = 'background:#1a1a1a;border:1px solid #555;border-radius:6px;min-width:290px;font-family:monospace;box-shadow:0 4px 24px rgba(0,0,0,0.65)'

		const hdr = document.createElement('div')
		hdr.style.cssText = 'padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between'
		const hdrTitle = document.createElement('span')
		hdrTitle.style.cssText = 'color:#ddd;font-size:14px;font-weight:bold'
		hdrTitle.textContent = '✏ Edit Sign'
		const hdrClose = document.createElement('button')
		hdrClose.textContent = '✕'
		hdrClose.style.cssText = 'background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:0 4px'
		hdr.append(hdrTitle, hdrClose)

		const body = document.createElement('div')
		body.style.cssText = 'padding:14px 16px'

		const inputs = Array.from({ length: 3 }, (_, i) => {
			const wrap = document.createElement('div')
			if (i > 0) wrap.style.marginTop = '10px'
			const lbl = document.createElement('div')
			lbl.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:4px'
			lbl.textContent = `Line ${i + 1}`
			const inp = document.createElement('input')
			inp.type = 'text'
			inp.maxLength = 20
			inp.placeholder = '(empty)'
			inp.style.cssText = 'width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;font-size:13px;font-family:monospace;border-radius:3px;outline:none'
			wrap.append(lbl, inp)
			body.appendChild(wrap)
			return inp
		})

		const btnRow = document.createElement('div')
		btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px'
		const saveBtn = document.createElement('button')
		saveBtn.textContent = 'Save'
		saveBtn.style.cssText = 'flex:1;padding:7px 0;background:rgba(60,200,100,.15);border:1px solid #40c870;color:#80f0a0;cursor:pointer;border-radius:4px;font-size:13px;font-family:monospace'
		const cancelBtn = document.createElement('button')
		cancelBtn.textContent = 'Cancel'
		cancelBtn.style.cssText = 'flex:1;padding:7px 0;background:rgba(255,255,255,.05);border:1px solid #555;color:#aaa;cursor:pointer;border-radius:4px;font-size:13px;font-family:monospace'
		btnRow.append(saveBtn, cancelBtn)
		body.appendChild(btnRow)
		modal.append(hdr, body)
		overlay.appendChild(modal)
		document.body.appendChild(overlay)

		let currentKey = null

		function openSignEdit(k) {
			currentKey = k
			const lines = signLines.get(k) || []
			inputs.forEach((inp, i) => { inp.value = lines[i] || '' })
			overlay.style.display = 'flex'
			document.exitPointerLock?.()
			inputs[0].focus()
		}

		function closeSignEdit() {
			overlay.style.display = 'none'
			currentKey = null
			if (!('ontouchstart' in window)) document.querySelector('canvas')?.requestPointerLock?.()
		}

		function saveSign() {
			if (!currentKey) return
			// Trim lines; drop trailing empty lines
			const lines = inputs.map((inp) => inp.value.trim())
			while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
			signLines.set(currentKey, lines)
			updateSignMesh(currentKey, lines)
			api.netSend({ type: 'sign_update', k: currentKey, lines })
			closeSignEdit()
		}

		hdrClose.addEventListener('click', closeSignEdit)
		cancelBtn.addEventListener('click', closeSignEdit)
		saveBtn.addEventListener('click', saveSign)
		overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSignEdit() })
		inputs.forEach((inp) => {
			inp.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') saveSign()
				if (e.key === 'Escape') closeSignEdit()
				e.stopPropagation()
			})
		})

		// ── Block interaction: right-click any sign opens the editor ──────────
		api.registerBlockInteraction(SIGN_IDS, (ctx) => {
			const f = ctx.facing
			if (!f || !SIGN_ID_SET.has(f.type)) return
			openSignEdit(`${f.x}_${f.y}_${f.z}`)
		})

		// ── Sign tool ─────────────────────────────────────────────────────────
		// Build a 64×64 icon: brown post at bottom, wooden board above with lines.
		const iconCanvas = document.createElement('canvas')
		iconCanvas.width = 64
		iconCanvas.height = 64
		{
			const ic = iconCanvas.getContext('2d')
			// Post
			ic.fillStyle = '#5c3d1e'
			ic.fillRect(28, 38, 8, 26)
			// Board background
			ic.fillStyle = '#c8a45a'
			ic.fillRect(4, 4, 56, 32)
			// Board border
			ic.strokeStyle = '#8b6b2e'
			ic.lineWidth = 2
			ic.strokeRect(4, 4, 56, 32)
			// Grain
			ic.strokeStyle = 'rgba(0,0,0,0.08)'
			ic.lineWidth = 1
			for (let gy = 12; gy < 36; gy += 8) {
				ic.beginPath(); ic.moveTo(5, gy); ic.lineTo(59, gy); ic.stroke()
			}
			// Text lines
			ic.fillStyle = '#1a0500'
			for (const ly of [14, 22, 30]) ic.fillRect(12, ly, 40, 2)
		}

		api.registerTool({
			name: 'Sign',
			url: iconCanvas.toDataURL(),
			damage: 0,

			onRightClick(ctx) {
				const f = ctx.facing
				if (!f) return
				if (SIGN_ID_SET.has(f.type)) return  // handled by registerBlockInteraction

				const px = f.x + f.nx
				const py = f.y + f.ny
				const pz = f.z + f.nz
				if (ctx.getBlock(px, py, pz) !== null) return

				// Infer orientation from face normal; fall back to camera yaw on flat surfaces
				let signId
				if (f.nx !== 0) {
					signId = SIGN_X
				} else if (f.nz !== 0) {
					signId = SIGN_Z
				} else {
					const dir = new THREE.Vector3()
					api.camera.getWorldDirection(dir)
					signId = Math.abs(dir.x) > Math.abs(dir.z) ? SIGN_X : SIGN_Z
				}

				ctx.setBlock(px, py, pz, signId)
				// Open the editor after the block is placed
				setTimeout(() => openSignEdit(`${px}_${py}_${pz}`), 50)
			},
		})

		console.log('[Sign] registered SIGN_Z=' + SIGN_Z + ' SIGN_X=' + SIGN_X)
	},
})
