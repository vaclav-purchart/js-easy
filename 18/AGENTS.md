# AGENTS.md — Voxel World

This folder contains a small browser-based voxel ("Minecraft-like") game and its
multiplayer server module. It is designed for quick iteration: a single static
`index.html` for the client and a single `voxel-world.mjs` ES module that is
attached to an external Node `http.Server`.

The notes below tell coding agents what to read first, how the pieces fit
together, and the conventions to follow when extending the code.

## Files

- `index.html` — the entire browser client (HTML + CSS + JS in one file).
  - Loads `three.js` via CDN (`THREE` is a global).
  - Renders, simulates, networks, and exposes a small **plugin API** under
    `window.VoxelWorld`.
- `voxel-world.mjs` — Node WebSocket server module.
  - Exports `default function attachVoxelWorld(httpServer)` which mounts a
    `WebSocketServer` on the path `/voxel-world`.
  - Persists worlds to `./worlds/*.json` and hot-watches `./plugins/*.js`.
  - The HTTP server itself is **not** in this folder — this module is meant to
    be `import`ed from a separate entrypoint.

## High-level architecture

```
Browser (index.html)                Server (voxel-world.mjs)
  THREE.js renderer                   ws WebSocketServer
  Chunk Web Workers     <── WS ─>     World rooms (Map<name, world>)
  Plugin API            broadcast     Per-world: seed + modifiedBlocks + players
  Block / Tool atlases                Persistence: worlds/*.json
  Lobby / Plugin loader               Plugin watcher: plugins/*.js
```

- The world is **procedurally generated from a seed** on the client. The server
  only stores the seed plus the *diff* of modified blocks — it never sends
  terrain itself.
- Multiplayer messages are small JSON objects with a `type` discriminator.
- World rooms are isolated: each room has its own seed, modified blocks, and
  player list. Players join a room with `{ type:'join', nickname, world }`.

## Client (`index.html`)

The file is ~3700 lines of vanilla JS, organised into clearly delimited
sections such as:

```
RENDERER SETUP / CLOUDS / CONSTANTS / BLOCK REGISTRY & PLUGIN API /
TEXTURE ATLAS / MATERIALS / NOISE-TERRAIN / PLANTS / BLOCK WORLD /
CHUNK GEOMETRY / CHUNK WORKER POOL / RAYCASTING / HITBOX OUTLINE /
REMOTE PLAYERS / MOBS / PLAYER & CAMERA / MINING-BUILDING / TOUCH CONTROLS /
TOOLS / HOTBAR / TOAST / BLOCK REGISTRY / GAME GUI / NICK-COMMAND /
NETWORKING / HEALTH SYSTEM / CHAT SYSTEM / MAIN LOOP
```

Use these banner comments (`/* ====== SECTION ====== */`) as table-of-contents
landmarks when editing — keep them when adding new sections.

### Key globals & registries

- `BLOCK` — core block-id map (`AIR=0, GRASS=1, …`). IDs `1–99` are reserved
  for core blocks; **plugins must use `100+`**, allocated via the API.
- `TRANSPARENT` — `Set` of block ids that need the transparent material/meshing
  path.
- `BLOCK_DEFS` — per-id draw functions that paint the texture atlas tile.
- `BLOCK_REGISTRY` — array consumed by the GUI block picker
  (`{ id, name, category }`).
- `ALL_BLOCK_IDS` / `blockAtlasRow` — atlas row bookkeeping. Live arrays —
  push to extend.
- `TOOL_DEFS` / `loadedTools` / `HOTBAR_ITEMS` — hotbar items (block or tool).
- `chunks` (`Map`) and `modified` (`Map`) — loaded chunk meshes and the diff
  of player-modified blocks (`"x_y_z"` keys, plant overrides use
  `"plant_x_z"`).
- `remotePlayers` (`Map`) — interpolated remote player models.
- `mobs` (`Map`) and `mobPickMeshes` — server-authoritative animals (chickens,
  …) and their combat hit-boxes. `MOB_MODELS[type]` returns a factory function
  for each species (see *Mobs* below).

### Chunks & workers

- Chunk size: `CHUNK_SIZE = 16`, sea level `8`, render distance default `3`.
- Chunk meshes are built in **Web Workers** (see the *CHUNK WORKER POOL*
  section). Worker code is composed by `.toString()`-ing real top-level
  helpers (`_workerConstants`, `_workerTerrain`, …) so they are normally
  syntax-checked. If you add a worker helper, also pass it through the same
  serialisation pipeline.
- After mutating block-related state (atlas rows, `BLOCK_DEFS`, `TRANSPARENT`),
  call `rebuildAllChunks()` (or `api.rebuildAllChunks()` from a plugin) to
  re-mesh.

### Plugin API (`window.VoxelWorld`)

Plugins are remote `.js` files served by the host. The lobby fetches a list
from `PLUGINS_API`, the user picks which to enable, and selected scripts are
appended via `loadPluginScript()`. The hot-reload path is driven by the
server's `plugin_added` message.

A plugin **must** register itself like this:

```js
VoxelWorld.registerPlugin('MyPlugin', {
  init(api) {
    const ID = api.allocateBlockId()
    api.registerBlock({
      id: ID,
      name: 'Marble',
      category: 'Crafted',
      draw: { side(ctx, x, y, S) { /* paint into atlas tile */ } },
    })
    api.loadBlockTexture(ID, 'https://example.com/marble.png')
    api.registerGuiTab('marble', '◇ Marble', () => document.createElement('div'))
  },
})
```

API surface (see the JSDoc on `_makeApi()` in `index.html`):

- `PLUGIN_NAME`
- `allocateBlockId() → number` (deterministic from plugin name; do **not**
  hard-code IDs)
- `registerBlock(def)` — `{ id, name, category, transparent?, draw:{ side, top?, bottom? } }`
- `loadBlockTexture(id, url, face?)` — `'side' | 'top' | 'bottom' | 'all'`
- `registerGuiTab(id, label, renderFn)`
- `registerMob(cfg)` — model + hitbox stay client-side; the AI fields are
  shipped to the server as JSON (see *Mobs* below)
- `BLOCK` (read-only core map)
- `rebuildAllChunks()`

**Plugin code only ever runs in the browser** — the server never executes
plugin JS. `api.registerMob(cfg)` keeps the model/hitbox locally and ships
the JSON-safe AI subset of the config to the server via the
`register_mob_type` message; the server validates fields against an
allow-list and clamps numerics into safe ranges before storing them in
`MOB_TYPES`. This means a malicious or buggy plugin cannot run code on the
server, only nudge a few numbers within tight bounds.

The server also tracks a `knownMobTypes: Set<string>` per player (built-ins
+ everything they've sent via `register_mob_type`). Plugin-only mobs are
filtered out of every server→client mob event for players who don't have
the plugin loaded, **and** hostile AI ignores those players when picking
targets — so a player who unchecks the wolf plugin can't be killed by an
invisible wolf. Maintenance also won't spawn plugin types around players
who don't know them, and orphaned mobs (no remaining player knows the type)
are despawned the next maintenance tick.

When a `register_mob_type` *changes* the merged config (HP/speed/behavior
etc. — detected by JSON-fingerprinting the merged result against the prior),
existing mobs of that type are despawned so the maintenance tick respawns
them with the new config. Without this, `mob.maxHp` stays baked at spawn
time and live iteration on a plugin's stats appears not to work.

Plugin filenames follow `plugin---<author>---<name>.js`; this is parsed by
`parsePluginMeta()` for the lobby UI.

### Networking (client side)

- `WS_URL = 'wss://purchart.cloud/voxel-world'`
- `connect()` opens the WebSocket and sends `{ type:'join', nickname, world }`.
- `handleServerMessage()` switches on `msg.type` — keep all message handling
  there.
- `netSend{Move,BlockUpdate,Nickname}` are the outbound helpers — re-use
  them rather than calling `ws.send` directly.

### Commands

Chat slash-commands handled in `handleCommand()`:

- `/reset` — clear local + broadcast `world_reset`.
- `/nick <name>` — change nickname.
- `/remove <BLOCK|ALL> <radius>` — server-side bulk removal (or local-only
  in offline mode).

When adding new commands, route them through `handleCommand()` and update the
server `switch` if they require server-side state.

## Server (`voxel-world.mjs`)

Single-file ESM (`import` syntax, `.mjs`). Exports a default factory that
attaches a `WebSocketServer` to an existing HTTP server. The expected
deployment is something like:

```js
import http from 'http'
import attachVoxelWorld from './voxel-world.mjs'

const server = http.createServer(/* serve index.html etc. */)
attachVoxelWorld(server)
server.listen(8080)
```

CLI args (parsed at module load):

```
node entry.mjs save.json                           # restore + load save.json into 'default'
node entry.mjs save.json myworld                   # … into world 'myworld'
node entry.mjs save.json --range x1,z1,x2,z2       # only blocks inside the XZ rectangle
```

### World rooms

`getWorld(name)` lazily creates a world `{ name, seed, modifiedBlocks, players, nextId }`.
World names are sanitised to `[a-zA-Z0-9_-]{1,32}`. Rooms are isolated — never
broadcast across worlds. Use `broadcastWorld(world, obj, excludeId?)`; only use
`broadcastAllPlayers()` for global events such as `plugin_added`.

### Persistence

- `restoreAllWorlds()` runs at module load and reads every `./worlds/*.json`.
- `saveWorld(world)` writes the diff `{ world, seed, modified: [[k, v], …] }`.
- `shutdown(label)` is wired to `exit`, `SIGINT`, `SIGTERM`, `SIGHUP` and saves
  all worlds. **`process.on('exit')` only allows synchronous I/O** — keep
  `saveWorld` synchronous (`writeFileSync`).

### Mobs (server-authoritative)

Mobs are simulated entirely on the server so every client sees the same
position and HP. The server replicates the client's terrain noise function
(`terrainHeight`) so chickens can walk on procedurally-generated ground —
**keep `_smoothNoise` / `terrainHeight` in `voxel-world.mjs` in sync with
`_workerTerrain` in `index.html`**.

The AI is split into a *type config* (`MOB_TYPES`) and a *behavior* (`MOB_BEHAVIORS`).
Two behaviors ship by default:

- `passive` — wanders aimlessly; on hit, flees away from the attacker and
  gets a temporary speed boost (`fleeBoostMs` × `fleeBoostMul`). Used by
  chickens and bunnies.
- `hostile` — chases the nearest player within `aggroRadius` and bites in
  melee on `attackCooldownMs`. Drops aggro past `deaggroRadius` when the
  post-hit `aggroDurationMs` window has elapsed. Used by the example wolf.

A type's `behavior: 'passive'|'hostile'` field selects which one runs each
tick. Plugins can also call `api.registerMobBehavior(name, { onTick, onHit })`
to define an entirely new one.

`MOB_TYPES` is the per-species config (HP, speed, AI knobs, density caps):

```js
const MOB_TYPES = {
  chicken: {
    maxHp, damage, speed,
    regionSize,        // chunks; XZ size of a "spawn region"
    countPerRegion,    // density cap (e.g. 2 chickens per 5x5 chunks)
    spawnMinRadius, spawnRadius, despawnRadius,
    wanderMin, wanderMax, idleMinMs, idleMaxMs,
    stepMaxClimb,      // chickens hop ±1 block
    respawnDelayMs,
    behavior:        'passive',
    fleeBoostMs,       // speed-up duration after a hit
    fleeBoostMul,
    // Hostile-only fields (see MOB_BEHAVIORS.hostile):
    // aggroRadius, deaggroRadius, aggroDurationMs,
    // attackRange, attackDamage, attackCooldownMs, chaseMul,
  },
}
```

Each world has `mobs: Map<id, mob>` and `nextMobId`. Three timers drive the
system, all module-level `setInterval`s:

- **AI tick** (`MOB_TICK_MS = 100`) — each mob steps toward its current target;
  when it reaches the target (or hits an obstacle / a >1-block step / water)
  it picks a new wander destination. Every move marks the mob `dirty`.
- **Broadcast tick** (`MOB_BROADCAST_MS = 200`) — flushes all `dirty` mobs
  into one `mob_updates` message **per player**, filtered by their
  `knownMobTypes`. Most players know all types so this collapses to one
  payload; clients without a plugin just don't get its mob positions.
- **Maintenance tick** (`MOB_MAINTAIN_MS = 3000`) — for each player, ensures
  the player's spawn region has `countPerRegion` mobs of every type they
  know; despawns mobs farther than `despawnRadius` from any player and any
  whose type isn't loaded by anyone in the world. Soft-capped at
  `worldMobCap(world) = max(MIN_WORLD_MOB_CAP, players × MAX_MOBS_PER_PLAYER)`.

Client side, `tickMobs` hides any mob more than `(RENDER_DISTANCE + 0.5) ×
CHUNK_SIZE` blocks away (set `model.visible = false`, snap to the latest
server pose so it doesn't slide in when it returns). `Three.js` skips both
rendering and raycasting for hidden objects, and `tickAnim` is gated on
`model.visible`, so far-away mobs cost essentially nothing.

When a player hits a mob (`hit_mob`), the server validates distance (max
4 blocks, same as PvP), deducts `cfg.damage`, broadcasts `mob_hp`, and points
the mob's wander target *away* from the attacker (flee). On death it sends
`mob_die`, removes the mob, and schedules a replacement spawn near the killer.

**Adding a new mob species** (cow, pig, …):

The preferred path is a plugin — one `.js` file, one `api.registerMob(...)`
call. Plugins run only in the browser; the AI fields travel to the server
as JSON via the `register_mob_type` message and are validated/clamped there.
Renderer-only fields (`makeModel`, `hitBox`) stay local.

```js
VoxelWorld.registerPlugin('Cow', {
  init(api) {
    api.registerMob({
      type: 'cow',
      // AI fields (sent to the server as JSON):
      maxHp: 14, damage: 0, speed: 1.4,
      regionSize: 6, countPerRegion: 2,
      spawnMinRadius: 12, spawnRadius: 32, despawnRadius: 160,
      wanderMin: 3, wanderMax: 9, idleMinMs: 800, idleMaxMs: 2500,
      stepMaxClimb: 1, respawnDelayMs: 2000,
      behavior: 'passive',
      fleeBoostMs: 1500, fleeBoostMul: 1.6,

      // Renderer-only fields (stay in the browser):
      hitBox:    { sx: 0.9, sy: 1.0, sz: 1.2, oy: 0.55 },
      makeModel: makeCowModel,
    })
  },
})

function makeCowModel() { /* … return new THREE.Group() … */ }
```

The server's allow-list lives in `MOB_FIELD_RANGES` in `voxel-world.mjs`;
keep `_MOB_AI_FIELDS` in `index.html` in sync so the client doesn't waste
bytes sending fields the server will discard. Adding a new behavior or
behavior-specific field requires editing both files (the server still has
to know what `behavior: 'foo'` means).

The `makeModel` function must return a `THREE.Group` that:
- has its feet at local `y = 0` (so `model.position.y = serverY` rests it on
  the ground),
- faces `+Z` by default (yaw `0` ⇒ facing `+Z`; yaw rotation matches
  `Math.atan2(dx, dz)` from the server),
- assigns `userData.tickAnim = (dt, isMoving) => …` for legs/wings/etc.,
- assigns `userData.hpBar` to a `makeMobHpBar()` sprite if you want the
  floating HP indicator.

For a *hostile* mob, set `behavior: 'hostile'` and supply at minimum
`aggroRadius`, `attackRange`, `attackDamage`, `attackCooldownMs`. See
`plugins/plugin---vasik---wolf.js` for a full example. A peaceful example
lives at `plugins/plugin---vasik---bunny.js`.

To add a brand-new core species (built into the engine rather than a plugin),
the older path still works: append a config entry to `MOB_TYPES` in
`voxel-world.mjs` and a matching `MOB_MODELS[type]` factory in `index.html`.

Mobs are **not persisted**. They respawn dynamically from active player
positions when the server starts.

### Plugin hot-loading

- `watchPluginsFolder()` watches `./plugins` for new/changed `.js` files and
  broadcasts `{ type:'plugin_added', url, filename }` to every connected
  player. The URL is `${PLUGINS_URL_BASE}/${filename}?t=${Date.now()}` to bust
  the browser cache. Update `PLUGINS_URL_BASE` if you change deployment domain.
- Watch events are debounced 500 ms per filename.
- The server **never executes plugin JS**. When the browser loads a plugin
  and that plugin calls `api.registerMob(...)`, the renderer keeps the model
  factory locally and sends a `register_mob_type` JSON message to the server.
  The server validates the payload (allow-list + numeric clamps in
  `validateMobConfig`) before storing the type in `MOB_TYPES`. Hot-reloading
  works because reconnects flush every queued mob registration on `init`.

### Message protocol (client ↔ server)

Inbound (client → server):

| `type`           | payload                                                  |
|------------------|----------------------------------------------------------|
| `join`           | `nickname, world`                                        |
| `move`           | `x, y, z, yaw, pitch, held?, swing?`                     |
| `block_update`   | `k, v` (key `"x_y_z"` or `"plant_x_z"`, value = block id)|
| `remove_blocks`  | `blockId|null, px, py, pz, radius`                       |
| `hit_player`     | `targetId, damage` (clamped 1..50 server-side)           |
| `hit_mob`        | `mobId, damage` (clamped 1..50 server-side)              |
| `set_nickname`   | `nickname`                                               |
| `world_reset`    | —                                                        |
| `chat`           | `text`                                                   |
| `register_mob_type` | `config: { type, behavior?, …allow-listed AI fields }` |

Outbound (server → client):

| `type`          | payload                                                   |
|-----------------|-----------------------------------------------------------|
| `init`          | `id, seed, world, blocks:[{k,v}], players:[…], mobs:[…]`  |
| `player_join`   | `player`                                                  |
| `player_leave`  | `id`                                                      |
| `moves`         | `players: [{ id, x, y, z, yaw, pitch, held, swing, hp }]` |
| `block_update`  | `k, v`                                                    |
| `player_rename` | `id, nickname`                                            |
| `world_reset`   | —                                                         |
| `hp_update`     | `id, hp, damage` (damage = applied amount this hit)       |
| `player_died`   | `id, killerName, hp`                                      |
| `mob_spawn`     | `mob: { id, type, x, y, z, yaw, hp, maxHp }`              |
| `mob_despawn`   | `id`                                                      |
| `mob_updates`   | `mobs: [{ id, x, y, z, yaw }]` (batched, ~5 Hz)           |
| `mob_hp`        | `id, hp, damage` (damage = applied amount this hit)       |
| `mob_die`       | `id, killerName`                                          |
| `chat`          | `nickname, text`                                          |
| `plugin_added`  | `url, filename`                                           |

When adding a new message type:

1. Add a `case` in the server's `ws.on('message')` switch.
2. Add a matching `case` in the client's `handleServerMessage()`.
3. Use `broadcastWorld()` (server) or `netSend()` (client); never bypass them.
4. Keep payloads small — `move` is broadcast at 20 Hz to every peer.

### Combat / movement constraints

- Hits validated server-side: max distance² = 16 (4 blocks) and 500 ms
  invincibility per attacker. Damage = 20, HP cap = 100, respawn at `(0,20,0)`.
- The 20 Hz move broadcast tick aggregates dirty players into a single
  `moves` message per world — don't add per-player intervals.

## Conventions

Follow what's already in the files:

- **Indentation: tabs.** Both files use tabs. Don't mix in spaces.
- **No semicolons** at statement ends in most code — match the surrounding
  style of the function you're editing rather than reformatting.
- **Single quotes** for strings; backticks for templates.
- `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for module-level
  constants, `_leadingUnderscore` for "internal" helpers (e.g.
  `_workerConstants`, `_registerBlockNow`).
- Keep banner comments (`/* ====== SECTION ====== */`) when adding a new
  logical area; align with the existing headings.
- Server-side log lines use the `[voxel-world]`, `[+]`, `[-]`, `[chat/<world>]`,
  `[hit]`, `[kill]`, `[!]`, `[/remove]` prefixes — keep that style.
- Comments are for *why*, not *what*. Several existing comments document
  non-obvious trade-offs (e.g. why `process.on('exit')` must use `writeFileSync`,
  why pixel ratio is capped, why workers are serialised via `.toString()`) —
  preserve and follow that pattern.
- Sanitise any user-supplied string before using it in a key, filename, or
  broadcast (`.slice(0, N).replace(/[^a-zA-Z0-9_-]/g, '_')` is the pattern
  already in use).

## Things to be careful about

- The client expects **`THREE` as a global**, loaded from a CDN `<script>`.
  Don't switch to ES module imports without also updating the script tag.
- `BLOCK_REGISTRY`, `BLOCK_DEFS`, `ALL_BLOCK_IDS`, `blockAtlasRow`,
  `TRANSPARENT`, `BLOCK` are mutable singletons that plugins extend at
  runtime — never replace them, only push/assign.
- The atlas canvas is pre-allocated to `ATLAS_ROWS_MAX = 256` rows. If you
  raise the plugin block-id ceiling, raise this too.
- Modified blocks use string keys `"x_y_z"`. Coordinates are parsed back with
  `k.split('_').map(Number)`; keep coordinates as integers.
- The server **does not validate block placement** — it just rebroadcasts.
  Don't rely on it for anti-cheat beyond what `hit_player` already does.
- Per-frame work in `animate()` runs every RAF — avoid allocations and DOM
  queries in hot paths (cache `document.getElementById` lookups at module
  scope, like the existing code).

## Quick recipes

- **Add a new core block:** extend `BLOCK`, add a `BLOCK_DEFS` entry, push to
  `ALL_BLOCK_IDS` (or just rely on the existing `Object.values(BLOCK)` init if
  you add at module load), add to `BLOCK_REGISTRY`, mark as transparent if
  needed. For external-only blocks prefer the plugin API.
- **Add a new tool:** push to `TOOL_DEFS` (`{ name, url, damage? }` or
  `{ name, draw, damage? }`). `damage` defaults to `DEFAULT_TOOL_DAMAGE` and
  is sent with every `hit_player` / `hit_mob` (server clamps to 1..50).
- **Add a new mob species:** preferred — drop a plugin in `./plugins/` calling
  `api.registerMob({ type, behavior, …, makeModel })`. The same file
  registers the AI on the server and the model on the client. See
  `plugins/plugin---vasik---bunny.js` (peaceful) and
  `plugins/plugin---vasik---wolf.js` (hostile) for templates.
- **Add a new server message:** see *Message protocol* above.
- **Add a new chat command:** add a branch in `handleCommand()`; if it needs
  server state, also handle it in the server `switch`.
- **Add a GUI tab:** call `registerGuiTab(id, label, renderFn)` (also
  available to plugins via `api.registerGuiTab`). `renderFn` must return an
  `HTMLElement`.
