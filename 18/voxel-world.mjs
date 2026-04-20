/**
 * Voxel World — Multiplayer WebSocket module
 * Players join named world rooms: { type:'join', nickname, world:'default' }
 * Each world is isolated: own seed, own blocks, own players.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, watch } from 'fs'
import { join } from 'path'

const WORLDS_DIR  = './worlds'
const PLUGINS_DIR = './plugins'
const PLUGINS_URL_BASE = 'https://purchart.cloud/voxel-world'   // adjust to your domain

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
	try { files = readdirSync(WORLDS_DIR).filter(f => f.endsWith('.json')) }
	catch { return }
	for (const file of files) {
		const filePath = join(WORLDS_DIR, file)
		try {
			const data  = JSON.parse(readFileSync(filePath, 'utf8'))
			const name  = (data.world || file.replace(/\.json$/, ''))
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

process.on('exit',    ()  => shutdown('exit'))        // Windows shutdown, kill -9, etc.
process.on('SIGINT',  ()  => { shutdown('SIGINT');  process.exit(0) })
process.on('SIGTERM', ()  => { shutdown('SIGTERM'); process.exit(0) })
// Windows Ctrl+Break / terminal close
process.on('SIGHUP',  ()  => { shutdown('SIGHUP');  process.exit(0) })

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
		const raw  = readFileSync(filePath, 'utf8')
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
const args     = process.argv.slice(2)
const saveArg  = args.find(a => a.endsWith('.json'))
if (saveArg) {
	const saveIdx  = args.indexOf(saveArg)
	// World name: next arg after the file if it doesn't start with --
	const nextArg  = args[saveIdx + 1]
	const nameArg  = (nextArg && !nextArg.startsWith('--')) ? nextArg : undefined

	// --range x1,z1,x2,z2
	let range = null
	const rangeIdx = args.indexOf('--range')
	if (rangeIdx !== -1 && args[rangeIdx + 1]) {
		const nums = args[rangeIdx + 1].split(',').map(Number)
		if (nums.length === 4 && nums.every(n => !isNaN(n))) {
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
const SEA_LEVEL  = 8
const BEDROCK_Y  = 0
const CHUNK_SIZE = 16
const BLOCK_AIR  = 0
const BLOCK_WATER = 4

function _hash(n) { return Math.abs(Math.sin(n) * 43758.5453) % 1 }

function _smoothNoise(seed, x, z, scale, offset) {
	const x0 = Math.floor(x / scale), z0 = Math.floor(z / scale)
	const xf = x / scale - x0,        zf = z / scale - z0
	const n00 = _hash(x0 * 57.13       + z0       + offset + seed)
	const n10 = _hash((x0 + 1) * 57.13 + z0       + offset + seed)
	const n01 = _hash(x0 * 57.13       + (z0 + 1) + offset + seed)
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
const MOB_TYPES = {
	chicken: {
		maxHp:           10,
		damage:          5,     // damage per player hit (2 hits = death)
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
	},
}

function makeMob(world, type, x, y, z) {
	const cfg = MOB_TYPES[type]
	const id  = world.nextMobId++
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
	const cfg  = MOB_TYPES[mob.type]
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

function updateMobAI(world, mob, dt) {
	const cfg = MOB_TYPES[mob.type]
	const now = Date.now()
	if (now < mob.idleUntil) return

	const dx = mob.tx - mob.x
	const dz = mob.tz - mob.z
	const distSq = dx * dx + dz * dz

	// Reached target — idle, then pick a new one
	if (distSq < 0.25) {
		mob.idleUntil = now + cfg.idleMinMs + Math.random() * (cfg.idleMaxMs - cfg.idleMinMs)
		pickWanderTarget(world, mob, null)
		return
	}

	const dist    = Math.sqrt(distSq)
	const stepLen = Math.min(cfg.speed * dt, dist)
	const nx      = mob.x + (dx / dist) * stepLen
	const nz      = mob.z + (dz / dist) * stepLen

	// Check ground at the next step. Mobs only hop ±stepMaxClimb blocks.
	const groundY = getGroundY(world, Math.floor(nx), Math.floor(nz))
	if (Math.abs(groundY - mob.y) > cfg.stepMaxClimb || groundY <= SEA_LEVEL) {
		// Obstacle (cliff/wall/water) — give up and pick somewhere else.
		pickWanderTarget(world, mob, null)
		return
	}

	mob.x = nx
	mob.z = nz
	mob.y = groundY
	// Face direction of motion. yaw=0 means facing +Z; +yaw rotates toward +X.
	mob.yaw  = Math.atan2(dx, dz)
	mob.dirty = true
}

function nearestPlayerDist(world, mob) {
	let best = Infinity
	for (const p of world.players.values()) {
		const dx = p.x - mob.x, dz = p.z - mob.z
		const d2 = dx * dx + dz * dz
		if (d2 < best) best = d2
	}
	return Math.sqrt(best)
}

// Region key for a position — used to count mobs per `regionSize×regionSize`
// chunk area when enforcing density caps.
function regionKey(x, z, regionSize) {
	const cx = Math.floor(x / CHUNK_SIZE)
	const cz = Math.floor(z / CHUNK_SIZE)
	return Math.floor(cx / regionSize) + ',' + Math.floor(cz / regionSize)
}

function attemptSpawnMob(world, type, near) {
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
		broadcastWorld(world, { type: 'mob_spawn', mob: serializeMob(mob) })
		console.log(`[mob spawn] ${type}#${mob.id} in "${world.name}" @ ${x},${y},${z}`)
		return mob
	}
	return null
}

// Top up each player's spawn region to the configured density. Runs on a
// slow timer (every few seconds) to avoid spawning storms.
function maintainMobPopulation(world) {
	if (world.players.size === 0) return
	for (const [type, cfg] of Object.entries(MOB_TYPES)) {
		const counts = new Map()
		for (const mob of world.mobs.values()) {
			if (mob.type !== type) continue
			const key = regionKey(mob.x, mob.z, cfg.regionSize)
			counts.set(key, (counts.get(key) || 0) + 1)
		}
		for (const p of world.players.values()) {
			const key  = regionKey(p.x, p.z, cfg.regionSize)
			const have = counts.get(key) || 0
			if (have < cfg.countPerRegion) {
				if (attemptSpawnMob(world, type, p)) counts.set(key, have + 1)
			}
		}
	}
}

function despawnDistantMobs(world) {
	for (const mob of [...world.mobs.values()]) {
		const cfg = MOB_TYPES[mob.type]
		if (nearestPlayerDist(world, mob) > cfg.despawnRadius) {
			world.mobs.delete(mob.id)
			broadcastWorld(world, { type: 'mob_despawn', id: mob.id })
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
	const dt  = (now - _lastMobTick) / 1000
	_lastMobTick = now
	for (const world of worlds.values()) {
		if (world.players.size === 0) continue
		for (const mob of world.mobs.values()) updateMobAI(world, mob, dt)
	}
}, MOB_TICK_MS)

// Broadcast tick — batch all dirty mobs into one update message per world.
const MOB_BROADCAST_MS = 200
setInterval(() => {
	for (const world of worlds.values()) {
		if (world.players.size === 0) continue
		const dirty = []
		for (const mob of world.mobs.values()) {
			if (!mob.dirty) continue
			dirty.push({ id: mob.id, x: mob.x, y: mob.y, z: mob.z, yaw: mob.yaw })
			mob.dirty = false
		}
		if (dirty.length) broadcastWorld(world, { type: 'mob_updates', mobs: dirty })
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
					const nickname  = (msg.nickname || 'Player').slice(0, 20)
					world = getWorld(worldName)
					const id = world.nextId++
					player = { id, nickname, x:0, y:20, z:0, yaw:0, pitch:0, ws, dirty:false,
					           hp:100, lastHitTime:0, held:null, swing:false }
   					world.players.set(id, player)
					send(ws, {
						type:'init', id, seed:world.seed, world:worldName,
						blocks: [...world.modifiedBlocks.entries()].map(([k,v])=>({k,v})),
						players: [...world.players.values()].filter(p=>p.id!==id).map(serializePlayer),
						mobs:    [...world.mobs.values()].map(serializeMob),
					})
					broadcastWorld(world, { type:'player_join', player:serializePlayer(player) }, id)
					console.log(`[+] "${nickname}" -> "${worldName}" (${id})  online=${world.players.size}`)
					break
				}

				case 'hit_mob': {
					if (!player) return
					const mob = world.mobs.get(msg.mobId)
					if (!mob) return
					// Distance check matches player combat (max 4 blocks).
					const dx = player.x - mob.x, dy = player.y - mob.y, dz = player.z - mob.z
					if (dx*dx + dy*dy + dz*dz > 16) return
					const cfg = MOB_TYPES[mob.type]
					const damage = clampHitDamage(msg.damage, cfg.damage)
					mob.hp = Math.max(0, mob.hp - damage)
					broadcastWorld(world, { type:'mob_hp', id:mob.id, hp:mob.hp, damage })
					// Hit → flee in the opposite direction.
					pickWanderTarget(world, mob, { x: player.x, z: player.z })
					console.log(`[mob hit] ${player.nickname} → ${mob.type}#${mob.id}  dmg=${damage}  hp=${mob.hp}`)
					if (mob.hp <= 0) {
						world.mobs.delete(mob.id)
						broadcastWorld(world, { type:'mob_die',
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
					if (dx*dx + dy*dy + dz*dz > 16) return
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
					player.x=msg.x; player.y=msg.y; player.z=msg.z
					player.yaw=msg.yaw; player.pitch=msg.pitch
					player.held=msg.held ?? null; player.swing=!!msg.swing
					player.dirty=true
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
						if (dx*dx + dz*dz > r2) continue
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
					player.nickname = (msg.nickname||'').trim().slice(0,20)||player.nickname
					broadcastWorld(world, { type:'player_rename', id:player.id, nickname:player.nickname })
					break
				}
				case 'world_reset': {
					if (!player) return
					world.modifiedBlocks.clear()
					broadcastWorld(world, { type:'world_reset' })
					console.log(`[!] "${world.name}" reset by ${player.nickname}`)
					break
				}
				case 'chat': {
					if (!player) return
					const text = String(msg.text||'').trim().slice(0,200)
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
		ws.on('error', err => console.warn('[ws error]', err.message))
	})
}

function send(ws, obj) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)) }
function broadcastWorld(world, obj, excludeId) {
	const data = JSON.stringify(obj)
	for (const p of world.players.values())
		if (p.id!==excludeId && p.ws.readyState===WebSocket.OPEN) p.ws.send(data)
}
function serializePlayer(p) {
	return { id:p.id, nickname:p.nickname, x:p.x, y:p.y, z:p.z, yaw:p.yaw, pitch:p.pitch,
    	         held:p.held??null, swing:!!p.swing, hp:p.hp??100 }
}
