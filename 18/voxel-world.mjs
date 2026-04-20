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
					})
					broadcastWorld(world, { type:'player_join', player:serializePlayer(player) }, id)
					console.log(`[+] "${nickname}" -> "${worldName}" (${id})  online=${world.players.size}`)
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

					const damage = 20   // 5 hits to kill
					target.hp = Math.max(0, target.hp - damage)
					broadcastWorld(world, { type:'hp_update', id:target.id, hp:target.hp })
					console.log(`[hit] ${player.nickname} → ${target.nickname}  hp=${target.hp}`)

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
