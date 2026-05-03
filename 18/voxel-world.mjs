/**
 * Voxel World — Multiplayer WebSocket module
 * Players join named world rooms: { type:'join', nickname, world:'default' }
 * Each world is isolated: own seed, own blocks, own players.
 */

// plugins tags - author, type (block|mob), enabled (true), checked (true)
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, watch } from 'fs'
import { join } from 'path'

const WORLDS_DIR = './worlds'
const PLUGINS_DIR = './saves'
const PLUGINS_URL_BASE = 'https://purchart.eu/voxel-world'   // adjust to your domain

// ── Persist a single world to disk ────────────────────────────────────────
function saveWorld(world) {
	mkdirSync(WORLDS_DIR, { recursive: true })
	const filePath = join(WORLDS_DIR, `${world.name}.json`)
	const data = {
		world: world.name,
		seed:  world.seed,
		modified: [...world.modifiedBlocks.entries()],
	}
	writeFileSync(filePath, JSON.stringify(data), 'utf8')
	console.log(`[voxel-world] Saved world "${world.name}"  blocks=${world.modifiedBlocks.size}  → ${filePath}`)
}

function saveAllWorlds() {
	for (const world of worlds.values()) {
		try { saveWorld(world) }
		catch (err) { console.error(`[voxel-world] Failed to save "${world.name}":`, err.message) }
	}
}

// ── Auto-restore all worlds from the worlds/ folder at startup ────────────
function restoreAllWorlds() {
	let files
	try { files = readdirSync(WORLDS_DIR).filter((f) => f.endsWith('.json')) }
	catch { return }
	for (const file of files) {
		const filePath = join(WORLDS_DIR, file)
		try {
			const data = JSON.parse(readFileSync(filePath, 'utf8'))
			const name = (data.world || file.replace(/\.json$/, ''))
				.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_')
			const world = getWorld(name)
			if (typeof data.seed === 'number') world.seed = data.seed
			for (const [k, v] of data.modified || []) world.modifiedBlocks.set(k, v)
			console.log(`[voxel-world] Restored world "${name}"  blocks=${world.modifiedBlocks.size}`)
		} catch (err) {
			console.error(`[voxel-world] Failed to restore "${file}":`, err.message)
		}
	}
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// process.on('exit') fires on ALL exits (including Windows shutdown/restart)
// and supports only synchronous operations — writeFileSync is sync so it works.
// SIGINT / SIGTERM give us an async moment for logging.
function shutdown(label) {
	console.log(`\n[voxel-world] ${label} — saving worlds…`)
	saveAllWorlds()
	console.log('[voxel-world] Done. Goodbye.')
}

process.on('exit', () => shutdown('exit'))        // Windows shutdown, kill -9, etc.
process.on('SIGINT', () => { shutdown('SIGINT'); process.exit(0) })
process.on('SIGTERM', () => { shutdown('SIGTERM'); process.exit(0) })
// Windows Ctrl+Break / terminal close
process.on('SIGHUP', () => { shutdown('SIGHUP'); process.exit(0) })

// ── World rooms ────────────────────────────────────────────────────────────
const worlds = new Map()

function getWorld(name) {
	if (!worlds.has(name)) {
		worlds.set(name, {
			name,
			seed: Math.floor(Math.random() * 1_000_000),
			modifiedBlocks: new Map(),
			players: new Map(),
			nextId: 1,
			// Mobs (chickens, future cows/pigs/…) are server-authoritative but
			// not persisted — they respawn dynamically around active players.
			mobs: new Map(),
			nextMobId: 1,
		})
		console.log(`[voxel-world] Created world "${name}"`)
	}
	return worlds.get(name)
}

// ── Plugin hot-loading: watch plugins/ folder, broadcast new files ────────
// When a new plugin---*.js file appears in ./plugins, broadcast its URL to
// all connected players so they can load it without rejoining.
function broadcastAllPlayers(obj) {
	const data = JSON.stringify(obj)
	for (const world of worlds.values())
		for (const p of world.players.values())
			if (p.ws.readyState === 1) p.ws.send(data)
}

function watchPluginsFolder() {
	try {
		mkdirSync(PLUGINS_DIR, { recursive: true })
		// Track debounce timers per filename to avoid double-firing
		const debounceTimers = new Map()
		watch(PLUGINS_DIR, (eventType, filename) => {
			if (!filename?.endsWith('.js')) return
			// Both 'rename' (new file) and 'change' (updated file) trigger a reload.
			// Debounce per file — writes can fire multiple events in quick succession.
			clearTimeout(debounceTimers.get(filename))
			debounceTimers.set(filename, setTimeout(() => {
				debounceTimers.delete(filename)
				// Append ?t=timestamp so browsers bypass their script cache on updates
				const url = `${PLUGINS_URL_BASE}/${filename}?t=${Date.now()}`
				console.log(`[voxel-world] Plugin ${eventType}: ${filename}`)
				broadcastAllPlayers({ type: 'plugin_added', url, filename })
			}, 500))
		})
		console.log(`[voxel-world] Watching plugins folder: ${PLUGINS_DIR}`)
	} catch (err) {
		console.warn(`[voxel-world] Could not watch plugins folder: ${err.message}`)
	}
}


// File format: { seed: number, world?: string, modified: [[key, value], ...] }
//
// Usage:
//   node server.mjs world.json
//   node server.mjs world.json myworld
//   node server.mjs world.json default --range x1,z1,x2,z2
//
// --range filters modified blocks to only those within the XZ rectangle
// defined by two corners (inclusive).  Example:
//   --range -45,-100,30,150   keeps blocks where -45 ≤ x ≤ 30 AND -100 ≤ z ≤ 150
function loadWorldFile(filePath, worldNameOverride, range) {
	try {
		const raw = readFileSync(filePath, 'utf8')
		const data = JSON.parse(raw)
		const name = (worldNameOverride || data.world || 'default')
			.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_')
		const world = getWorld(name)
		if (typeof data.seed === 'number') world.seed = data.seed

		let loaded = 0, skipped = 0
		for (const [k, v] of data.modified || []) {
			if (range) {
				const parts = k.split('_')
				const bx = parseInt(parts[0], 10)
				const bz = parseInt(parts[2], 10)
				if (bx < range.x1 || bx > range.x2 || bz < range.z1 || bz > range.z2) {
					skipped++
					continue
				}
			}
			world.modifiedBlocks.set(k, v)
			loaded++
		}

		const rangeStr = range
			? `  range=[${range.x1},${range.z1}]..[${range.x2},${range.z2}]`
			: ''
		console.log(`[voxel-world] Loaded "${filePath}" → world "${name}"` +
			`  seed=${world.seed}  blocks=${loaded}${skipped ? `  skipped=${skipped}` : ''}${rangeStr}`)
	} catch (err) {
		console.error(`[voxel-world] Failed to load world file "${filePath}": ${err.message}`)
		process.exit(1)
	}
}

// ── Startup: restore worlds from disk, watch plugins, then apply CLI override
restoreAllWorlds()
watchPluginsFolder()

// ── Parse CLI arguments ───────────────────────────────────────────────────
// Supported forms:
//   node server.mjs save.json
//   node server.mjs save.json worldname
//   node server.mjs save.json --range x1,z1,x2,z2
//   node server.mjs save.json worldname --range x1,z1,x2,z2
const args = process.argv.slice(2)
const saveArg = args.find((a) => a.endsWith('.json'))
if (saveArg) {
	const saveIdx = args.indexOf(saveArg)
	// World name: next arg after the file if it doesn't start with --
	const nextArg = args[saveIdx + 1]
	const nameArg = (nextArg && !nextArg.startsWith('--')) ? nextArg : undefined

	// --range x1,z1,x2,z2
	let range = null
	const rangeIdx = args.indexOf('--range')
	if (rangeIdx !== -1 && args[rangeIdx + 1]) {
		const nums = args[rangeIdx + 1].split(',').map(Number)
		if (nums.length === 4 && nums.every((n) => !isNaN(n))) {
			range = {
				x1: Math.min(nums[0], nums[2]),
				x2: Math.max(nums[0], nums[2]),
				z1: Math.min(nums[1], nums[3]),
				z2: Math.max(nums[1], nums[3]),
			}
		} else {
			console.error('[voxel-world] --range requires 4 numbers: x1,z1,x2,z2')
			process.exit(1)
		}
	}

	loadWorldFile(saveArg, nameArg, range)
}

// ── Server-side terrain (mirrors client worker so mobs can walk on ground) ─
// Keep these formulas in sync with `_workerTerrain` in index.html.
const SEA_LEVEL = 8
const BEDROCK_Y = 0
const CHUNK_SIZE = 16
const BLOCK_AIR = 0
const BLOCK_WATER = 4

function _hash(n) { return Math.abs(Math.sin(n) * 43758.5453) % 1 }

function _smoothNoise(seed, x, z, scale, offset) {
	const x0 = Math.floor(x / scale), z0 = Math.floor(z / scale)
	const xf = x / scale - x0, zf = z / scale - z0
	const n00 = _hash(x0 * 57.13 + z0 + offset + seed)
	const n10 = _hash((x0 + 1) * 57.13 + z0 + offset + seed)
	const n01 = _hash(x0 * 57.13 + (z0 + 1) + offset + seed)
	const n11 = _hash((x0 + 1) * 57.13 + (z0 + 1) + offset + seed)
	const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf)
	return n00 * (1 - u) * (1 - v) + n10 * u * (1 - v) + n01 * (1 - u) * v + n11 * u * v
}

function terrainHeight(seed, x, z) {
	let h = _smoothNoise(seed, x, z, 40, 0) * 8 + _smoothNoise(seed, x, z, 120, 100) * 12
	h = Math.floor(SEA_LEVEL + h - 6)
	if (_smoothNoise(seed, x, z, 60, 200) < 0.28) h -= 3
	if (Math.abs(_smoothNoise(seed, x, z, 200, 500) - 0.5) < 0.03) h = SEA_LEVEL - 2
	return Math.max(h, BEDROCK_Y + 1)
}

function isSolidAt(world, x, y, z) {
	const k = `${x}_${y}_${z}`
	if (world.modifiedBlocks.has(k)) {
		const v = world.modifiedBlocks.get(k)
		return v !== BLOCK_AIR && v !== BLOCK_WATER
	}
	return y >= 0 && y <= terrainHeight(world.seed, x, z)
}

// Y of the surface (= 1 above the topmost solid block) at integer column (x, z).
// Search starts well above the natural terrain so player towers up to ~24
// blocks above the original surface still register.
function getGroundY(world, x, z) {
	const startY = Math.max(terrainHeight(world.seed, x, z) + 8, 32)
	for (let y = startY; y >= 0; y--) {
		if (isSolidAt(world, x, y, z)) return y + 1
	}
	return 1
}

// Sanitise a client-supplied damage value. Clients send the damage they want
// to deal (computed from the equipped tool) so weapons can be tweaked without
// server changes — but we still clamp to a sane range to prevent abuse.
const MAX_HIT_DAMAGE = 50
function clampHitDamage(value, fallback) {
	const n = Number(value)
	if (!Number.isFinite(n) || n <= 0) return fallback
	return Math.min(Math.floor(n), MAX_HIT_DAMAGE)
}

// ── Mob system ────────────────────────────────────────────────────────────
// Server-authoritative animals/mobs. Position, HP and AI all live here so
// every connected client sees identical movement. Clients receive
// spawn/despawn events plus batched position updates and animate locally.
//
// To add a new mob species:
//   1. Append a config entry to MOB_TYPES below.
//   2. Add a matching model factory to MOB_MODELS in index.html.
//
// All numeric knobs (density, speed, ranges) are settable per type.
//
// `behavior` selects one of MOB_BEHAVIORS below. Two are built-in:
//   • 'passive' — wanders, flees after being hit (chicken, bunny, …)
//   • 'hostile' — chases and bites players within aggro range (wolves, zombies…)
//
// Plugins extend this map at runtime via api.registerMob({ type, …config }).
// Anything missing falls back to passive defaults.
const MOB_TYPES = {
	chicken: {
		maxHp:           10,
		damage:          5,     // damage per player hit (2 hits = death) — used by hostile mobs
		speed:           1.8,   // blocks/sec
		regionSize:      5,     // chunks; XZ size of a "spawn region"
		countPerRegion:  2,     // target mob count per regionSize×regionSize chunk area
		spawnMinRadius:  10,    // don't spawn closer than this to a player (blocks)
		spawnRadius:     32,    // max spawn distance from a player (blocks)
		despawnRadius:   160,   // despawn if no player within this many blocks
		wanderMin:       4,     // pick wander targets between [min,max] blocks away
		wanderMax:       10,
		idleMinMs:       800,   // pause this long between targets
		idleMaxMs:       2500,
		stepMaxClimb:    1,     // max ±block step per move (chickens hop 1 block)
		respawnDelayMs:  1500,  // delay before another spawns to replace a kill
		behavior:        'passive',
		fleeBoostMs:     2000,  // when hit, boost speed for this long
		fleeBoostMul:    1.8,   // multiplier on speed during the flee window
	},
}

function makeMob(world, type, x, y, z) {
	const cfg = MOB_TYPES[type]
	const id = world.nextMobId++
	const mob = {
		id, type,
		x, y, z,
		yaw:       Math.random() * Math.PI * 2,
		hp:        cfg.maxHp,
		maxHp:     cfg.maxHp,
		tx:        x, tz: z,    // current wander target (XZ)
		idleUntil: 0,
		dirty:     true,
	}
	pickWanderTarget(world, mob, null)
	return mob
}

function serializeMob(m) {
	return {
		id: m.id, type: m.type,
		x: m.x, y: m.y, z: m.z, yaw: m.yaw,
		hp: m.hp, maxHp: m.maxHp,
	}
}

// Pick a new wander destination. If awayFrom is provided (e.g. the attacker)
// the mob heads roughly in the opposite direction.
function pickWanderTarget(world, mob, awayFrom) {
	const cfg = MOB_TYPES[mob.type]
	const dist = cfg.wanderMin + Math.random() * (cfg.wanderMax - cfg.wanderMin)
	let angle
	if (awayFrom) {
		const dx = mob.x - awayFrom.x, dz = mob.z - awayFrom.z
		angle = Math.atan2(dz, dx) + (Math.random() - 0.5) * 0.6
	} else {
		angle = Math.random() * Math.PI * 2
	}
	mob.tx = Math.round(mob.x + Math.cos(angle) * dist)
	mob.tz = Math.round(mob.z + Math.sin(angle) * dist)
	mob.idleUntil = 0
}

// One physics step toward (mob.tx, mob.tz). Returns true on success.
// On failure (cliff/wall/water) the caller decides whether to repick a target.
function stepMobToward(world, mob, dt) {
	const cfg = MOB_TYPES[mob.type]
	const speed = cfg.speed * (mob.speedMul || 1)
	const dx = mob.tx - mob.x
	const dz = mob.tz - mob.z
	const distSq = dx * dx + dz * dz
	if (distSq < 0.0025) return false
	const dist = Math.sqrt(distSq)
	const stepLen = Math.min(speed * dt, dist)
	const nx = mob.x + (dx / dist) * stepLen
	const nz = mob.z + (dz / dist) * stepLen
	const groundY = getGroundY(world, Math.floor(nx), Math.floor(nz))
	if (Math.abs(groundY - mob.y) > cfg.stepMaxClimb || groundY <= SEA_LEVEL) return false
	mob.x = nx
	mob.z = nz
	mob.y = groundY
	// Face direction of motion. yaw=0 means facing +Z; +yaw rotates toward +X.
	mob.yaw = Math.atan2(dx, dz)
	mob.dirty = true
	return true
}

// Default wander loop shared by every behavior — march toward (tx,tz),
// idle a bit when arrived, repick. Honours mob.idleUntil.
function tickWander(world, mob, dt, now) {
	const cfg = MOB_TYPES[mob.type]
	if (now < mob.idleUntil) return

	const dx = mob.tx - mob.x, dz = mob.tz - mob.z
	if (dx * dx + dz * dz < 0.25) {
		mob.idleUntil = now + cfg.idleMinMs + Math.random() * (cfg.idleMaxMs - cfg.idleMinMs)
		pickWanderTarget(world, mob, null)
		return
	}
	if (!stepMobToward(world, mob, dt)) {
		// Obstacle — repick a target.
		pickWanderTarget(world, mob, null)
	}
}

function nearestPlayer(world, mob) {
	let best = null, bestD2 = Infinity
	for (const p of world.players.values()) {
		const dx = p.x - mob.x, dz = p.z - mob.z
		const d2 = dx * dx + dz * dz
		if (d2 < bestD2) { best = p; bestD2 = d2 }
	}
	return best ? { player: best, distSq: bestD2 } : null
}

// ── Mob behaviors ─────────────────────────────────────────────────────────
// Each behavior is { onTick(world, mob, dt, now), onHit(world, mob, attacker) }.
// Mobs reference one via cfg.behavior. Plugins can register their own type by
// supplying a `behavior` string that matches an existing entry, or by adding
// a fresh behavior in their server-side init via api.registerMobBehavior().
const MOB_BEHAVIORS = {
	// Wanders aimlessly. After being hit it flees in the opposite direction
	// and gets a temporary speed boost (configurable per type).
	passive: {
		onTick(world, mob, dt, now) {
			mob.speedMul = (now < (mob.fleeUntil || 0))
				? (MOB_TYPES[mob.type].fleeBoostMul || 1.6)
				: 1
			tickWander(world, mob, dt, now)
		},
		onHit(world, mob, attacker) {
			const cfg = MOB_TYPES[mob.type]
			mob.fleeUntil = Date.now() + (cfg.fleeBoostMs || 1500)
			pickWanderTarget(world, mob, { x: attacker.x, z: attacker.z })
		},
	},

	// Chases the nearest player within `aggroRadius`, attacking when within
	// `attackRange`. Drops aggro when the player exits `deaggroRadius` and
	// the post-hit aggro window has elapsed.
	hostile: {
		onTick(world, mob, dt, now) {
			const cfg = MOB_TYPES[mob.type]

			// Resolve target — persistent attacker first, else nearest player in range.
			// Crucially, only consider players who have this plugin loaded.
			// Otherwise an unchecked-wolf player gets killed by an invisible
			// wolf they have no way to fight back against.
			let target = mob.targetPlayerId ? world.players.get(mob.targetPlayerId) : null
			if (target && !target.knownMobTypes?.has(mob.type)) target = null
			if (!target) mob.targetPlayerId = null
			if (!target) {
				let bestD2 = (cfg.aggroRadius || 12) ** 2
				for (const p of world.players.values()) {
					if (!p.knownMobTypes?.has(mob.type)) continue
					const dx = p.x - mob.x, dz = p.z - mob.z
					const d2 = dx * dx + dz * dz
					if (d2 < bestD2) { bestD2 = d2; target = p }
				}
			}

			// Player.y is eye height; mob.y is feet. Subtract approximate player
			// height so vertical comparisons are feet-to-feet.
			const PLAYER_FEET_OFFSET = 1.7
			// If the player's feet are this many blocks above the mob, the mob
			// gives up the chase — they can't climb that high anyway and otherwise
			// they'd pace forever under a flying creative-mode player.
			const VERTICAL_DEAGGRO = 8

			if (target) {
				const dx = target.x - mob.x, dz = target.z - mob.z
				const d2 = dx * dx + dz * dz
				const dyFeet = (target.y - PLAYER_FEET_OFFSET) - mob.y
				const deaggro = (cfg.deaggroRadius || (cfg.aggroRadius || 12) + 8) ** 2

				// Lost interest? Out of XZ range OR too far above us, AND past
				// the post-hit aggro window.
				const tooFar = d2 > deaggro || Math.abs(dyFeet) > VERTICAL_DEAGGRO
				if (tooFar && now > (mob.aggroUntil || 0)) {
					mob.targetPlayerId = null
					target = null
				}
			}

			if (target) {
				const dx = target.x - mob.x, dz = target.z - mob.z
				const d2 = dx * dx + dz * dz
				const dyFeet = (target.y - PLAYER_FEET_OFFSET) - mob.y
				const reach2 = (cfg.attackRange || 1.6) ** 2
				// Vertical bite reach in feet-to-feet blocks. Default 2 lets a
				// mob bite a player standing on a single ledge above; bigger
				// elevation differences need a separate fix (climb-up AI).
				const vReach = cfg.attackVerticalReach ?? 2

				if (d2 <= reach2 && Math.abs(dyFeet) <= vReach) {
					// In melee range — face the player and bite on cooldown.
					mob.yaw = Math.atan2(dx, dz)
					mob.dirty = true
					if (now >= (mob.attackCooldownUntil || 0)) {
						mob.attackCooldownUntil = now + (cfg.attackCooldownMs || 1000)
						const dmg = cfg.attackDamage ?? cfg.damage ?? 5
						// Reuse the same 500ms invincibility window as PvP so combat feels consistent.
						if (now - (target.lastHitTime || 0) >= 500) {
							target.lastHitTime = now
							target.hp = Math.max(0, target.hp - dmg)
							broadcastWorld(world, { type: 'hp_update', id: target.id, hp: target.hp, damage: dmg })
							console.log(`[mob bite] ${mob.type}#${mob.id} → ${target.nickname}  dmg=${dmg}  hp=${target.hp}`)
							if (target.hp <= 0) {
								target.hp = 100
								target.x = 0; target.y = 20; target.z = 0
								broadcastWorld(world, { type: 'player_died',
									id: target.id, killerName: mob.type, hp: target.hp })
							}
						}
					}
					return
				}

				// Chase — point wander target at the player and step.
				mob.tx = target.x
				mob.tz = target.z
				mob.idleUntil = 0
				mob.speedMul = cfg.chaseMul || 1.4
				stepMobToward(world, mob, dt)
				return
			}

			// No target — wander like a passive mob.
			mob.speedMul = 1
			tickWander(world, mob, dt, now)
		},
		onHit(world, mob, attacker) {
			const cfg = MOB_TYPES[mob.type]
			mob.targetPlayerId = attacker.id
			mob.aggroUntil = Date.now() + (cfg.aggroDurationMs || 8000)
		},
	},
}

function getMobBehavior(mob) {
	const name = MOB_TYPES[mob.type]?.behavior || 'passive'
	return MOB_BEHAVIORS[name] || MOB_BEHAVIORS.passive
}

function updateMobAI(world, mob, dt) {
	getMobBehavior(mob).onTick(world, mob, dt, Date.now())
}

// ── Plugin mob registration (untrusted, validated) ────────────────────────
// Plugins live in the browser. The client parses the plugin JS, takes the
// numeric/AI portion of the mob config, and ships it to us as JSON via the
// `register_mob_type` message. We never execute plugin code server-side —
// what we accept here is *only* a flat object of whitelisted, range-clamped
// fields.
//
// Two protections:
//   • allow-list of fields → unknown keys are dropped silently
//   • numeric range clamps → bad values can't crash AI / DoS spawn caps
//   • behavior is a string enum, not a function reference

// type names: short lowercase identifiers, must not collide with built-ins.
const MOB_TYPE_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/
const BUILTIN_MOB_TYPES = new Set(['chicken'])

// [min, max] for every numeric field a plugin may set. Anything outside the
// range is clamped (not rejected) so a typo never breaks the world.
const MOB_FIELD_RANGES = {
	maxHp:            [1, 200],
	damage:           [0, 50],
	speed:            [0, 10],
	regionSize:       [1, 16],
	countPerRegion:   [0, 20],
	spawnMinRadius:   [0, 200],
	spawnRadius:      [1, 500],
	despawnRadius:    [1, 1000],
	wanderMin:        [0, 50],
	wanderMax:        [0, 50],
	idleMinMs:        [0, 30000],
	idleMaxMs:        [0, 30000],
	stepMaxClimb:     [0, 3],
	respawnDelayMs:   [0, 60000],
	fleeBoostMs:      [0, 30000],
	fleeBoostMul:     [1, 5],
	aggroRadius:      [0, 50],
	deaggroRadius:    [0, 100],
	aggroDurationMs:  [0, 60000],
	attackRange:         [0, 10],
	attackVerticalReach: [0, 10],
	attackDamage:        [0, 50],
	attackCooldownMs:    [100, 30000],
	chaseMul:            [1, 5],
}

const MOB_BEHAVIOR_NAMES = new Set(['passive', 'hostile'])

function clampNum(v, [lo, hi], fallback) {
	const n = Number(v)
	if (!Number.isFinite(n)) return fallback
	return Math.max(lo, Math.min(hi, n))
}

// Returns a validated copy of cfg or null on hard rejection (bad name).
function validateMobConfig(cfg) {
	if (!cfg || typeof cfg !== 'object') return null
	const type = String(cfg.type || '')
	if (!MOB_TYPE_NAME_RE.test(type)) return null
	if (BUILTIN_MOB_TYPES.has(type)) return null   // never overwrite core mobs

	const out = { type }
	out.behavior = MOB_BEHAVIOR_NAMES.has(cfg.behavior) ? cfg.behavior : 'passive'
	for (const [field, range] of Object.entries(MOB_FIELD_RANGES)) {
		if (cfg[field] === undefined) continue
		out[field] = clampNum(cfg[field], range, undefined)
	}
	return out
}

function nearestPlayerDist(world, mob) {
	const np = nearestPlayer(world, mob)
	return np ? Math.sqrt(np.distSq) : Infinity
}

// Region key for a position — used to count mobs per `regionSize×regionSize`
// chunk area when enforcing density caps.
function regionKey(x, z, regionSize) {
	const cx = Math.floor(x / CHUNK_SIZE)
	const cz = Math.floor(z / CHUNK_SIZE)
	return Math.floor(cx / regionSize) + ',' + Math.floor(cz / regionSize)
}

// Broadcast a mob-related event only to clients that have registered the
// type. Stops "invisible" plugin mobs from leaking events (and damage) to
// players who unchecked the plugin.
function broadcastWorldByMobType(world, mobType, obj, excludeId) {
	const data = JSON.stringify(obj)
	for (const p of world.players.values()) {
		if (excludeId !== undefined && p.id === excludeId) continue
		if (!p.knownMobTypes?.has(mobType)) continue
		if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data)
	}
}

// World-wide soft cap. Past this many mobs we stop topping up regardless of
// per-region density — keeps long-running worlds from filling up. Scales
// with player count so a busy world isn't choked.
const MAX_MOBS_PER_PLAYER = 14
const MIN_WORLD_MOB_CAP = 12
function worldMobCap(world) {
	return Math.max(MIN_WORLD_MOB_CAP, world.players.size * MAX_MOBS_PER_PLAYER)
}

function attemptSpawnMob(world, type, near) {
	if (world.mobs.size >= worldMobCap(world)) return null
	const cfg = MOB_TYPES[type]
	for (let attempt = 0; attempt < 10; attempt++) {
		const angle = Math.random() * Math.PI * 2
		const r = cfg.spawnMinRadius + Math.random() * (cfg.spawnRadius - cfg.spawnMinRadius)
		const x = Math.round(near.x + Math.cos(angle) * r)
		const z = Math.round(near.z + Math.sin(angle) * r)
		const y = getGroundY(world, x, z)
		if (y <= SEA_LEVEL) continue   // don't spawn in/under water
		const mob = makeMob(world, type, x, y, z)
		world.mobs.set(mob.id, mob)
		// Spawn event only goes to players who can actually render this type.
		broadcastWorldByMobType(world, type, { type: 'mob_spawn', mob: serializeMob(mob) })
		console.log(`[mob spawn] ${type}#${mob.id} in "${world.name}" @ ${x},${y},${z}`)
		return mob
	}
	return null
}

// Top up each player's spawn region to the configured density. Runs on a
// slow timer (every few seconds) to avoid spawning storms.
function maintainMobPopulation(world) {
	if (world.players.size === 0) return
	const cap = worldMobCap(world)
	for (const [type, cfg] of Object.entries(MOB_TYPES)) {
		if (world.mobs.size >= cap) break
		const counts = new Map()
		for (const mob of world.mobs.values()) {
			if (mob.type !== type) continue
			const key = regionKey(mob.x, mob.z, cfg.regionSize)
			counts.set(key, (counts.get(key) || 0) + 1)
		}
		for (const p of world.players.values()) {
			// Don't spawn plugin-only types around players who haven't loaded
			// the plugin — they couldn't see them anyway and would just take
			// damage from invisible attackers.
			if (!p.knownMobTypes?.has(type)) continue
			const key = regionKey(p.x, p.z, cfg.regionSize)
			const have = counts.get(key) || 0
			if (have < cfg.countPerRegion) {
				if (attemptSpawnMob(world, type, p)) counts.set(key, have + 1)
				if (world.mobs.size >= cap) break
			}
		}
	}
}

function despawnDistantMobs(world) {
	for (const mob of [...world.mobs.values()]) {
		const cfg = MOB_TYPES[mob.type]
		if (nearestPlayerDist(world, mob) > cfg.despawnRadius) {
			world.mobs.delete(mob.id)
			broadcastWorldByMobType(world, mob.type, { type: 'mob_despawn', id: mob.id })
			continue
		}
		// Orphan cleanup: nobody in the world has this plugin loaded. The
		// mob would otherwise sit there invisibly until despawnRadius kicks in.
		let knownToAnyone = false
		for (const p of world.players.values()) {
			if (p.knownMobTypes?.has(mob.type)) { knownToAnyone = true; break }
		}
		if (!knownToAnyone) {
			world.mobs.delete(mob.id)
			broadcastWorldByMobType(world, mob.type, { type: 'mob_despawn', id: mob.id })
		}
	}
}

// AI tick — moves every mob a small step, marks dirty ones for broadcast.
// Worlds with no players are skipped: no observers means no point simulating
// (and the mob_updates broadcast would have no recipients anyway). When the
// last player leaves we just freeze the mobs in place; they'll be despawned
// later by the maintenance tick.
const MOB_TICK_MS = 100
let _lastMobTick = Date.now()
setInterval(() => {
	const now = Date.now()
	const dt = (now - _lastMobTick) / 1000
	_lastMobTick = now
	for (const world of worlds.values()) {
		if (world.players.size === 0) continue
		for (const mob of world.mobs.values()) updateMobAI(world, mob, dt)
	}
}, MOB_TICK_MS)

// Broadcast tick — batch all dirty mobs into one update message per player.
// Per-player so we can filter by knownMobTypes (no positions for plugins
// the client hasn't loaded).
const MOB_BROADCAST_MS = 200
setInterval(() => {
	for (const world of worlds.values()) {
		if (world.players.size === 0) continue
		// Group dirty mobs by type once, then per-player skip the ones they don't know.
		const dirtyByType = new Map()
		let any = false
		for (const mob of world.mobs.values()) {
			if (!mob.dirty) continue
			const update = { id: mob.id, x: mob.x, y: mob.y, z: mob.z, yaw: mob.yaw }
			let arr = dirtyByType.get(mob.type)
			if (!arr) { arr = []; dirtyByType.set(mob.type, arr) }
			arr.push(update)
			mob.dirty = false
			any = true
		}
		if (!any) continue
		for (const p of world.players.values()) {
			if (p.ws.readyState !== WebSocket.OPEN) continue
			const list = []
			for (const [type, arr] of dirtyByType) {
				if (!p.knownMobTypes?.has(type)) continue
				for (const u of arr) list.push(u)
			}
			if (list.length) p.ws.send(JSON.stringify({ type: 'mob_updates', mobs: list }))
		}
	}
}, MOB_BROADCAST_MS)

// Spawn-maintenance tick — keeps populations topped up around active players.
const MOB_MAINTAIN_MS = 3000
setInterval(() => {
	for (const world of worlds.values()) {
		maintainMobPopulation(world)
		despawnDistantMobs(world)
	}
}, MOB_MAINTAIN_MS)

// ── 20 Hz move broadcast tick (all worlds) ─────────────────────────────────
setInterval(() => {
	for (const world of worlds.values()) {
		const dirty = []
		for (const p of world.players.values()) {
			if (p.dirty) { dirty.push(serializePlayer(p)); p.dirty = false }
		}
		if (!dirty.length) continue
		const data = JSON.stringify({ type: 'moves', players: dirty })
		for (const p of world.players.values())
			if (p.ws.readyState === 1) p.ws.send(data)
	}
}, 50)

// ── Exported factory ───────────────────────────────────────────────────────
export default function attachVoxelWorld(httpServer) {
	const wss = new WebSocketServer({ server: httpServer })
	console.log('[voxel-world] WebSocket handler attached  →  /voxel-world')

	wss.on('connection', (ws, req) => {
		if (req.url?.split('?')[0] !== '/voxel-world') { ws.close(1008, 'Not found'); return }

		let player = null, world = null

		ws.on('message', (raw) => {
			let msg; try { msg = JSON.parse(raw) } catch { return }

			switch (msg.type) {
				case 'join': {
					const worldName = (msg.world || 'default').slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_')
					const nickname = (msg.nickname || 'Player').slice(0, 20)
					world = getWorld(worldName)
					const id = world.nextId++
					player = { id, nickname, x:0, y:20, z:0, yaw:0, pitch:0, ws, dirty:false,
					           hp:100, lastHitTime:0, held:null, swing:false,
					           // Mob types this client knows about (built-ins + everything
					           // their loaded plugins have registered). Plugin types arrive
					           // via register_mob_type after init.
					           knownMobTypes: new Set(BUILTIN_MOB_TYPES) }
   					world.players.set(id, player)
					send(ws, {
						type:'init', id, seed:world.seed, world:worldName,
						blocks: [...world.modifiedBlocks.entries()].map(([k, v])=>({k, v})),
						players: [...world.players.values()].filter((p)=>p.id !== id).map(serializePlayer),
						// Only ship mobs the joining player can already render. The rest
						// are sent on demand when register_mob_type confirms the plugin.
						mobs:    [...world.mobs.values()]
							.filter((m) => player.knownMobTypes.has(m.type))
							.map(serializeMob),
					})
					broadcastWorld(world, { type:'player_join', player:serializePlayer(player) }, id)
					console.log(`[+] "${nickname}" -> "${worldName}" (${id})  online=${world.players.size}`)
					break
				}

				case 'register_mob_type': {
					if (!player) return
					// JSON-only registration — every field passes through
					// validateMobConfig (allow-list + numeric clamps). Plugin
					// code never runs server-side. Reuses the same mob_type
					// across worlds, since MOB_TYPES is a global registry.
					const safe = validateMobConfig(msg.config)
					if (!safe) {
						console.warn(`[register_mob_type] rejected from ${player.nickname}: ${JSON.stringify(msg.config?.type)}`)
						return
					}

					const before = MOB_TYPES[safe.type]
					const merged = { behavior: 'passive', ...before, ...safe }
					// Detect a real change so we don't recycle mobs every time a
					// new player joins and re-announces the same plugin config.
					const beforeKey = JSON.stringify(before || null)
					const mergedKey = JSON.stringify(merged)
					const changed = beforeKey !== mergedKey

					MOB_TYPES[safe.type] = merged
					player.knownMobTypes.add(safe.type)

					if (changed && before) {
						// Config update — despawn existing mobs of this type so the
						// maintenance tick respawns them with the new HP/speed/etc.
						// (mob.maxHp is baked at spawn, so without this you'd need
						// to wait for the old generation to die naturally.)
						let recycled = 0
						for (const w of worlds.values()) {
							for (const id of [...w.mobs.keys()]) {
								const m = w.mobs.get(id)
								if (m.type !== safe.type) continue
								w.mobs.delete(id)
								broadcastWorldByMobType(w, m.type, { type: 'mob_despawn', id })
								recycled++
							}
						}
						console.log(`[register_mob_type] updated "${safe.type}" (behavior=${merged.behavior}) by ${player.nickname}, recycled ${recycled} mob(s)`)
					} else if (!before) {
						console.log(`[register_mob_type] added "${safe.type}" (behavior=${merged.behavior}) by ${player.nickname}`)
					}

					// Backfill mobs the player didn't get in their `init` because
					// they hadn't registered this type yet.
					for (const m of world.mobs.values()) {
						if (m.type !== safe.type) continue
						send(ws, { type: 'mob_spawn', mob: serializeMob(m) })
					}
					break
				}
				case 'hit_mob': {
					if (!player) return
					const mob = world.mobs.get(msg.mobId)
					if (!mob) return
					// Distance check matches player combat (max 4 blocks).
					const dx = player.x - mob.x, dy = player.y - mob.y, dz = player.z - mob.z
					if (dx * dx + dy * dy + dz * dz > 16) return
					const cfg = MOB_TYPES[mob.type]
					const damage = clampHitDamage(msg.damage, cfg.damage)
					mob.hp = Math.max(0, mob.hp - damage)
					broadcastWorldByMobType(world, mob.type, { type:'mob_hp', id:mob.id, hp:mob.hp, damage })
					// Behavior decides how to react (passive→flee, hostile→aggro, etc.).
					getMobBehavior(mob).onHit(world, mob, player)
					console.log(`[mob hit] ${player.nickname} → ${mob.type}#${mob.id}  dmg=${damage}  hp=${mob.hp}`)
					if (mob.hp <= 0) {
						world.mobs.delete(mob.id)
						broadcastWorldByMobType(world, mob.type, { type:'mob_die',
							id: mob.id, killerName: player.nickname })
						console.log(`[mob kill] ${player.nickname} killed ${mob.type}#${mob.id}`)
						// Replacement spawn after a short delay (random spot near killer).
						const killer = { x: player.x, z: player.z }
						setTimeout(() => {
							if (world.players.size > 0) attemptSpawnMob(world, mob.type, killer)
						}, cfg.respawnDelayMs + Math.random() * 1000)
					}
					break
				}
				case 'hit_player': {
					if (!player) return
					const target = world.players.get(msg.targetId)
					if (!target || target.id === player.id) return
					// Distance check (prevent cheating — max 4 blocks)
					const dx = player.x - target.x, dy = player.y - target.y, dz = player.z - target.z
					if (dx * dx + dy * dy + dz * dz > 16) return
					// Invincibility frames — 500ms between hits on same target
					const now = Date.now()
					if (now - target.lastHitTime < 500) return
					target.lastHitTime = now

					const damage = clampHitDamage(msg.damage, 20)
					target.hp = Math.max(0, target.hp - damage)
					broadcastWorld(world, { type:'hp_update', id:target.id, hp:target.hp, damage })
					console.log(`[hit] ${player.nickname} → ${target.nickname}  dmg=${damage}  hp=${target.hp}`)

					if (target.hp <= 0) {
						target.hp = 100
						target.x = 0; target.y = 20; target.z = 0
						broadcastWorld(world, { type:'player_died',
							id: target.id, killerName: player.nickname, hp: target.hp })
						console.log(`[kill] ${player.nickname} killed ${target.nickname}`)
					}
					break
				}
				case 'move': {
					if (!player) return
					player.x = msg.x; player.y = msg.y; player.z = msg.z
					player.yaw = msg.yaw; player.pitch = msg.pitch
					player.held = msg.held ?? null; player.swing = !!msg.swing
					player.dirty = true
					break
				}
				case 'remove_blocks': {
					if (!player) return
					// msg: { blockId: number|null, px, py, pz, radius }
					// blockId null means ALL blocks (any type)
					const { blockId, px, py, pz, radius } = msg
					const r2 = radius * radius
					let removed = 0
					for (const [k] of [...world.modifiedBlocks.entries()]) {
						const v = world.modifiedBlocks.get(k)
						// Match: specific block ID, or ALL (blockId===null)
						if (blockId !== null && v !== blockId) continue
						const parts = k.split('_')
						const bx = parseInt(parts[0], 10)
						const bz = parseInt(parts[2], 10)
						const dx = bx - px, dz = bz - pz
						if (dx * dx + dz * dz > r2) continue
						world.modifiedBlocks.delete(k)
						// Broadcast each removal as AIR to all players (including sender)
						broadcastWorld(world, { type: 'block_update', k, v: 0 })
						removed++
					}
					console.log(`[/remove] ${player.nickname} removed ${removed} block(s) within r=${radius}`)
					break
				}
				case 'block_update': {
					if (!player) return
					world.modifiedBlocks.set(msg.k, msg.v)
					broadcastWorld(world, { type:'block_update', k:msg.k, v:msg.v }, player.id)
					break
				}
				case 'set_nickname': {
					if (!player) return
					player.nickname = (msg.nickname || '').trim().slice(0, 20) || player.nickname
					broadcastWorld(world, { type:'player_rename', id:player.id, nickname:player.nickname })
					break
				}
				case 'world_reset': {
					if (!player) return
					// Only "vasek" gets to nuke the world. Authoritative check —
					// the client also gates this, but treat that as a hint, not security.
					if (player.nickname.trim().toLowerCase() !== 'vasek') {
						console.log(`[!] world_reset rejected — ${player.nickname} is not vasek`)
						return
					}
					world.modifiedBlocks.clear()
					broadcastWorld(world, { type:'world_reset' })
					console.log(`[!] "${world.name}" reset by ${player.nickname}`)
					break
				}
				case 'chat': {
					if (!player) return
					const text = String(msg.text || '').trim().slice(0, 200)
					if (!text) return
					broadcastWorld(world, { type:'chat', nickname:player.nickname, text })
					console.log(`[chat/${world.name}] ${player.nickname}: ${text}`)
					break
				}
			}
		})

		ws.on('close', () => {
			if (player && world) {
				world.players.delete(player.id)
				broadcastWorld(world, { type:'player_leave', id:player.id })
				console.log(`[-] ${player.nickname} left "${world.name}"  online=${world.players.size}`)
			}
		})
		ws.on('error', (err) => console.warn('[ws error]', err.message))
	})
}

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }
function broadcastWorld(world, obj, excludeId) {
	const data = JSON.stringify(obj)
	for (const p of world.players.values())
		if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(data)
}
function serializePlayer(p) {
	return { id:p.id, nickname:p.nickname, x:p.x, y:p.y, z:p.z, yaw:p.yaw, pitch:p.pitch,
    	         held:p.held ?? null, swing:!!p.swing, hp:p.hp ?? 100 }
}
