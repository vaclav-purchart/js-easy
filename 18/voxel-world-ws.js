/**
 * Voxel World — Multiplayer WebSocket module
 *
 * Usage (attach to your existing http.Server):
 *
 *   import { attachVoxelWorld } from './voxel-world-ws.js'
 *   attachVoxelWorld(myHttpServer)
 *
 * The WebSocket endpoint lives at the same host/port as your HTTP server,
 * on the path /voxel-world  →  wss://purchart.cloud/voxel-world
 * Connections arriving on any other path are rejected immediately.
 */

import { WebSocketServer, WebSocket } from 'ws'

// ── World state ────────────────────────────────────────────────────────────
const SEED           = Math.floor(Math.random() * 1_000_000)
const modifiedBlocks = new Map()   // "x_y_z" → blockType  (0 = AIR)
const mobs           = []          // reserved for future mob sync

// ── Player registry ────────────────────────────────────────────────────────
let nextId = 1
const players = new Map()   // id → { id, nickname, x, y, z, yaw, pitch, ws }

// ── Exported factory ───────────────────────────────────────────────────────
export function attachVoxelWorld(httpServer) {
  const wss = new WebSocketServer({ server: httpServer })
  console.log('[voxel-world] WebSocket handler attached  →  /voxel-world')

  wss.on('connection', (ws, req) => {
    // Only accept connections on /voxel-world
    const path = req.url?.split('?')[0]
    if (path !== '/voxel-world') {
      ws.close(1008, 'Not found')
      return
    }

    const id = nextId++
    let player = null   // set after 'join' message

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      switch (msg.type) {

        // ── Client introduces itself ────────────────────────────────────
        case 'join': {
          const nickname = (msg.nickname || `Player${id}`).slice(0, 20)
          player = { id, nickname, x: 0, y: 20, z: 0, yaw: 0, pitch: 0, ws }
          players.set(id, player)

          // Send full world state to the new client only
          send(ws, {
            type   : 'init',
            id,
            seed   : SEED,
            blocks : [...modifiedBlocks.entries()].map(([k, v]) => ({ k, v })),
            mobs,
            players: [...players.values()]
              .filter(p => p.id !== id)
              .map(serializePlayer),
          })

          // Announce arrival to everyone else
          broadcast({ type: 'player_join', player: serializePlayer(player) }, id)

          console.log(`[+] ${nickname} (${id}) connected  total=${players.size}`)
          break
        }

        // ── Position / look update ──────────────────────────────────────
        case 'move': {
          if (!player) return
          player.x = msg.x;  player.y = msg.y;  player.z = msg.z
          player.yaw = msg.yaw;  player.pitch = msg.pitch
          broadcast({ type: 'move', id,
                      x: msg.x, y: msg.y, z: msg.z,
                      yaw: msg.yaw, pitch: msg.pitch }, id)
          break
        }

        // ── Block placed or removed ─────────────────────────────────────
        case 'block_update': {
          if (!player) return
          const { k, v } = msg   // k = "x_y_z", v = blockType
          modifiedBlocks.set(k, v)
          broadcast({ type: 'block_update', k, v }, id)
          break
        }

        // ── Nickname change ─────────────────────────────────────────────
        case 'set_nickname': {
          if (!player) return
          const name = (msg.nickname || '').trim().slice(0, 20) || player.nickname
          player.nickname = name
          broadcast({ type: 'player_rename', id, nickname: name })
          break
        }

        // ── World reset ──────────────────────────────────────────────────
        case 'world_reset': {
          if (!player) return
          modifiedBlocks.clear()
          broadcast({ type: 'world_reset' })   // broadcast to all including sender
          console.log(`[!] World reset by ${player.nickname} (${player.id})`)
          break
        }
      }
    })

    ws.on('close', () => {
      if (player) {
        players.delete(player.id)
        broadcast({ type: 'player_leave', id: player.id })
        console.log(`[-] ${player.nickname} (${player.id}) disconnected  total=${players.size}`)
      }
    })

    ws.on('error', (err) => console.warn('[voxel-world ws error]', err.message))
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj))
}

function broadcast(obj, excludeId) {
  const data = JSON.stringify(obj)
  for (const p of players.values()) {
    if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(data)
  }
}

function serializePlayer(p) {
  return { id: p.id, nickname: p.nickname,
           x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch }
}
