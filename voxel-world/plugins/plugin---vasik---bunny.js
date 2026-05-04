/**
 * Voxel World Plugin — Bunny mob
 *
 * Demonstrates the api.registerMob() plugin point: one call carries both the
 * server-side AI config (HP/speed/behavior knobs) and the client-side model
 * factory. Each environment picks the fields it needs and ignores the rest.
 *
 * Bunnies are passive but skittish — they run *fast* after being hit, with
 * a longer flee window than chickens.
 */

VoxelWorld.registerPlugin('Bunny', {
	init(api) {
		api.registerMob({
			type: 'bunny',

			// ── Server (AI) ──────────────────────────────────────────────
			maxHp:           6,
			damage:          0,        // peaceful — never bites
			speed:           2.4,      // hops faster than a chicken
			regionSize:      5,
			countPerRegion:  2,
			spawnMinRadius:  10,
			spawnRadius:     32,
			despawnRadius:   160,
			wanderMin:       3,
			wanderMax:       8,
			idleMinMs:       300,
			idleMaxMs:       1200,
			stepMaxClimb:    1,
			respawnDelayMs:  2000,
			behavior:        'passive',
			fleeBoostMs:     3000,     // bolt for 3s after being hit
			fleeBoostMul:    2.5,      // 2.5× normal speed → seriously fast

			// ── Client (renderer) ────────────────────────────────────────
			hitBox: { sx: 0.55, sy: 0.6, sz: 0.65, oy: 0.3 },
			makeModel: makeBunnyModel,
		})
	},
})

// Top-level so its body isn't evaluated on the server (where THREE is undefined).
// The function is only invoked client-side from addMob().
function makeBunnyModel() {
	const root = new THREE.Group()

	const matBody = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 })
	const matEarInner = new THREE.MeshLambertMaterial({ color: 0xffb0c0 })
	const matNose = new THREE.MeshLambertMaterial({ color: 0xff7090 })
	const matEye = new THREE.MeshLambertMaterial({ color: 0x111111 })

	// bodyPivot bobs up/down for the hop animation
	const bodyPivot = new THREE.Group()
	root.add(bodyPivot)

	const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.32, 0.55), matBody)
	body.position.y = 0.28
	bodyPivot.add(body)

	const headPivot = new THREE.Group()
	headPivot.position.set(0, 0.42, 0.28)
	bodyPivot.add(headPivot)

	const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.3, 0.3), matBody)
	headPivot.add(head)

	const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), matNose)
	nose.position.set(0, -0.04, 0.16)
	headPivot.add(nose)

	for (const sx of [-1, 1]) {
		const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), matEye)
		eye.position.set(sx * 0.09, 0.06, 0.13)
		headPivot.add(eye)
	}

	// Long ears, pivoted at the skull so they tilt during anim
	function makeEar(sx) {
		const pivot = new THREE.Group()
		pivot.position.set(sx * 0.08, 0.15, 0)
		const outer = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.04), matBody)
		outer.position.y = 0.14
		pivot.add(outer)
		const inner = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.02), matEarInner)
		inner.position.set(0, 0.14, 0.022)
		pivot.add(inner)
		pivot.rotation.z = sx * -0.08
		headPivot.add(pivot)
		return pivot
	}
	const earL = makeEar(-1)
	const earR = makeEar( 1)

	// Fluffy tail
	const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.1), matBody)
	tail.position.set(0, 0.32, -0.3)
	bodyPivot.add(tail)

	function makeLeg(sx, sz, large) {
		const pivot = new THREE.Group()
		pivot.position.set(sx * 0.13, 0.14, sz)
		const w = large ? 0.13 : 0.1
		const h = large ? 0.18 : 0.14
		const d = large ? 0.18 : 0.12
		const leg = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matBody)
		leg.position.y = -h / 2
		pivot.add(leg)
		bodyPivot.add(pivot)
		return pivot
	}
	const flL = makeLeg(-1,  0.16, false)
	const frL = makeLeg( 1,  0.16, false)
	const blL = makeLeg(-1, -0.14, true)   // bigger hind legs
	const brL = makeLeg( 1, -0.14, true)

	const hpBar = makeMobHpBar()
	hpBar.position.y = 0.95
	root.add(hpBar)
	root.userData.hpBar = hpBar

	let phase = 0
	let earWiggle = 0
	root.userData.tickAnim = (dt, isMoving) => {
		if (isMoving) {
			phase += dt * 7
			// Hop: only-positive sine raises the body, then drops it.
			const hop = Math.max(0, Math.sin(phase)) * 0.18
			bodyPivot.position.y = hop
			// Front legs reach forward at peak; back legs push down
			const cyc = Math.sin(phase)
			flL.rotation.x =  cyc * 0.5
			frL.rotation.x =  cyc * 0.5
			blL.rotation.x = -cyc * 0.7
			brL.rotation.x = -cyc * 0.7
			earL.rotation.x = -cyc * 0.15
			earR.rotation.x = -cyc * 0.15
		} else {
			bodyPivot.position.y *= 0.85
			flL.rotation.x *= 0.85
			frL.rotation.x *= 0.85
			blL.rotation.x *= 0.85
			brL.rotation.x *= 0.85
			earWiggle += dt * 1.8
			earL.rotation.x = Math.sin(earWiggle) * 0.06
			earR.rotation.x = Math.cos(earWiggle) * 0.06
		}
	}

	return root
}
