/**
 * Voxel World Plugin — Wolf mob
 *
 * Hostile counterpart to the bunny: chases players within aggro range and
 * bites them in melee. Once a player attacks a wolf, it locks onto them for
 * the post-hit aggro window even outside aggro range.
 */

VoxelWorld.registerPlugin('Wolf', {
	init(api) {
		api.registerMob({
			type: 'wolf',

			// ── Server (AI) ──────────────────────────────────────────────
			maxHp:           18,
			damage:          8,        // legacy / fallback when attackDamage is unset
			speed:           2.6,
			regionSize:      8,        // wolves are rarer than chickens/bunnies
			countPerRegion:  1,
			spawnMinRadius:  16,
			spawnRadius:     40,
			despawnRadius:   180,
			wanderMin:       4,
			wanderMax:       12,
			idleMinMs:       400,
			idleMaxMs:       1500,
			stepMaxClimb:    1,
			respawnDelayMs:  4000,
			behavior:        'hostile',

			// hostile knobs
			aggroRadius:     12,       // start chase within 12 blocks
			deaggroRadius:   22,       // give up after this far
			aggroDurationMs: 8000,     // stay locked on after a hit
			attackRange:     1.6,      // close enough to bite
			attackDamage:    8,
			attackCooldownMs:1000,
			chaseMul:        1.5,      // sprint while chasing

			// ── Client (renderer) ────────────────────────────────────────
			hitBox: { sx: 0.85, sy: 0.95, sz: 1.2, oy: 0.5 },
			makeModel: makeWolfModel,
		})
	},
})

// Top-level so its body isn't evaluated on the server.
function makeWolfModel() {
	const root = new THREE.Group()

	const matFur   = new THREE.MeshLambertMaterial({ color: 0x6e6e72 })
	const matBelly = new THREE.MeshLambertMaterial({ color: 0x404048 })
	const matSnout = new THREE.MeshLambertMaterial({ color: 0x2a2a30 })
	const matEye   = new THREE.MeshLambertMaterial({ color: 0xffd040 })
	const matFang  = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 })

	const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 1.0), matFur)
	body.position.y = 0.55
	root.add(body)

	const belly = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.9), matBelly)
	belly.position.y = 0.35
	root.add(belly)

	// Head pivot — droops while idle, lunges forward while chasing
	const headPivot = new THREE.Group()
	headPivot.position.set(0, 0.7, 0.5)
	root.add(headPivot)

	const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.42), matFur)
	headPivot.add(head)

	const snout = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.3), matSnout)
	snout.position.set(0, -0.06, 0.3)
	headPivot.add(snout)

	for (const sx of [-1, 1]) {
		const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.04), matEye)
		eye.position.set(sx * 0.11, 0.08, 0.2)
		headPivot.add(eye)
		// Triangular ear tip — fake with a small box
		const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.08), matFur)
		ear.position.set(sx * 0.16, 0.27, -0.05)
		ear.rotation.z = sx * 0.2
		headPivot.add(ear)
		// Tiny fang — only visible when looking close
		const fang = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.04), matFang)
		fang.position.set(sx * 0.07, -0.13, 0.4)
		headPivot.add(fang)
	}

	// Tail pivot, anchored at the rump
	const tailPivot = new THREE.Group()
	tailPivot.position.set(0, 0.6, -0.5)
	tailPivot.rotation.x = -0.4   // angled up
	root.add(tailPivot)
	const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.4), matFur)
	tail.position.z = -0.18
	tailPivot.add(tail)

	function makeLeg(sx, sz) {
		const pivot = new THREE.Group()
		pivot.position.set(sx * 0.18, 0.4, sz)
		const upper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.16), matFur)
		upper.position.y = -0.2
		pivot.add(upper)
		root.add(pivot)
		return pivot
	}
	const flL = makeLeg(-1,  0.32)
	const frL = makeLeg( 1,  0.32)
	const blL = makeLeg(-1, -0.32)
	const brL = makeLeg( 1, -0.32)

	const hpBar = makeMobHpBar()
	hpBar.position.y = 1.3
	root.add(hpBar)
	root.userData.hpBar = hpBar

	let phase = 0
	let tailWag = 0
	root.userData.tickAnim = (dt, isMoving) => {
		if (isMoving) {
			phase += dt * 8
			// Diagonal trot — front-left + back-right swing in sync
			flL.rotation.x =  Math.sin(phase) * 0.7
			brL.rotation.x =  Math.sin(phase) * 0.7
			frL.rotation.x = -Math.sin(phase) * 0.7
			blL.rotation.x = -Math.sin(phase) * 0.7
			headPivot.position.y = 0.7 + Math.sin(phase * 2) * 0.02
			tailWag += dt * 12   // fast wag while moving
		} else {
			flL.rotation.x *= 0.85
			frL.rotation.x *= 0.85
			blL.rotation.x *= 0.85
			brL.rotation.x *= 0.85
			tailWag += dt * 5
		}
		tailPivot.rotation.y = Math.sin(tailWag) * 0.4
	}

	return root
}
