# Voxel World — Plugin authoring cheatsheet

Paste this whole file into a chatbot prompt when you want it to write a
plugin for the voxel world game in `index.html` + `voxel-world.mjs`. It is
self-contained: everything a plugin author needs is below.

---

## What a plugin is

A single `.js` file dropped into `./plugins/`. Filename convention:

```
plugin---<author>---<name>.js          e.g. plugin---ada---marble.js
```

The lobby parses the filename for the UI and the host hot-loads the file in
the browser. **Plugin code runs only in the browser.** The server never
executes plugin JS — for mobs, AI numbers travel as a validated JSON message.

Every plugin has the exact same shape:

```js
VoxelWorld.registerPlugin('PluginName', {
  init(api) {
    // …call api.allocateBlockId(), api.registerBlock(), api.registerMob(), etc.
  },
})
```

The api object passed to `init`:

| Method                                | Purpose                                    |
|---------------------------------------|--------------------------------------------|
| `api.allocateBlockId()`               | Stable, collision-free block id (≥100)     |
| `api.registerBlock(def)`              | Add a new block type                       |
| `api.loadBlockTexture(id, url, face)` | Blit a PNG into the atlas for a block      |
| `api.registerMob(cfg)`                | Add a new mob species (model + AI config)  |
| `api.registerGuiTab(id, label, fn)`   | Add a tab to the inventory panel           |
| `api.BLOCK`                           | Read-only core block id map                |
| `api.rebuildAllChunks()`              | Force-refresh loaded chunks                |

The host provides `THREE` as a global (browser only) and a helper
`makeMobHpBar()` for floating HP sprites on mob models.

---

## Recipe 1 — Block with PNG textures (one or more faces)

For URL-loaded textures the image must be served with CORS allowed. Each
block gets up to three faces: `'side' | 'top' | 'bottom' | 'all'` (default
`'all'`). `top` / `bottom` fall back to `side` if not loaded.

```js
VoxelWorld.registerPlugin('Marble', {
  init(api) {
    const ID = api.allocateBlockId()

    // Register first with a placeholder draw so the atlas row is reserved.
    api.registerBlock({
      id:       ID,
      name:     'Marble',
      category: 'Crafted',
      draw: { side(ctx, x, y, S) { ctx.fillStyle = '#ddd'; ctx.fillRect(x, y, S, S) } },
    })

    api.loadBlockTexture(ID, 'https://example.com/marble-side.png', 'side')
    api.loadBlockTexture(ID, 'https://example.com/marble-top.png',  'top')
    // bottom omitted → falls back to side
  },
})
```

---

## Recipe 2 — Block drawn purely in canvas (no external image)

Tiles are 16×16. Draw functions receive `(ctx, tileX, tileY, S)` and **must
keep painting inside `[x, y]..[x+S, y+S]`**. `top` / `bottom` are optional —
if omitted they fall back to `side`. Set `transparent: true` for glass-like
blocks (engine routes them through the alpha-blended material).

```js
VoxelWorld.registerPlugin('BrickRed', {
  init(api) {
    const ID = api.allocateBlockId()

    api.registerBlock({
      id:       ID,
      name:     'Red Brick',
      category: 'Crafted',
      draw: {
        side(ctx, x, y, S) {
          ctx.fillStyle = '#a13a25'; ctx.fillRect(x, y, S, S)
          // Mortar lines — staggered rows
          ctx.fillStyle = '#3a2018'
          for (let row = 0; row < S; row += 4) {
            ctx.fillRect(x, y + row, S, 1)
            const offset = (row / 4) % 2 === 0 ? 0 : S / 2
            ctx.fillRect(x + offset, y + row, 1, 4)
          }
        },
        top(ctx, x, y, S) {
          ctx.fillStyle = '#8a2f1f'; ctx.fillRect(x, y, S, S)
        },
      },
    })
  },
})
```

---

## Recipe 3 — Mob (server-authoritative, with model)

`api.registerMob(cfg)` is one call. The renderer keeps `makeModel` and
`hitBox` locally; the rest is shipped to the server as JSON, validated, and
stored in `MOB_TYPES`. The server **clamps** every numeric field to a sane
range (see "Allowed mob fields" below) and rejects anything else, so a typo
never breaks the world.

The `makeModel` function must return a `THREE.Group` that:

- has its **feet at local `y = 0`** (so `model.position.y = serverY` rests
  it on the ground),
- **faces `+Z`** by default (yaw 0 ⇒ looking at +Z; yaw rotates toward +X),
- assigns `userData.tickAnim = (dt, isMoving) => …` for any animation,
- assigns `userData.hpBar = makeMobHpBar()` for the floating HP sprite.

Behaviors are a string enum, **not** a callback:

- `'passive'` — wanders, flees on hit; speed bursts during `fleeBoostMs` ×
  `fleeBoostMul`. Use for prey (chickens, bunnies, cows, …).
- `'hostile'` — chases the nearest player within `aggroRadius` and bites
  in melee. Drops aggro past `deaggroRadius` once the post-hit
  `aggroDurationMs` window has elapsed. Use for predators.

### Peaceful example — bunny

```js
VoxelWorld.registerPlugin('Bunny', {
  init(api) {
    api.registerMob({
      type: 'bunny',

      // AI (sent to server as JSON):
      maxHp: 6, damage: 0, speed: 2.4,
      regionSize: 5, countPerRegion: 2,
      spawnMinRadius: 10, spawnRadius: 32, despawnRadius: 160,
      wanderMin: 3, wanderMax: 8,
      idleMinMs: 300, idleMaxMs: 1200,
      stepMaxClimb: 1, respawnDelayMs: 2000,
      behavior: 'passive',
      fleeBoostMs: 3000, fleeBoostMul: 2.5,

      // Renderer-only (stays in the browser):
      hitBox:    { sx: 0.55, sy: 0.6, sz: 0.65, oy: 0.3 },
      makeModel: makeBunnyModel,
    })
  },
})

function makeBunnyModel() {
  const root = new THREE.Group()
  const matBody = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 })
  // …build a THREE.Group with feet at y=0 and facing +Z…
  root.userData.tickAnim = (dt, isMoving) => { /* legs/ears/etc */ }
  root.userData.hpBar = makeMobHpBar()
  root.userData.hpBar.position.y = 0.95
  root.add(root.userData.hpBar)
  return root
}
```

### Hostile example — wolf

```js
api.registerMob({
  type: 'wolf',
  maxHp: 30, damage: 8, speed: 2.6,
  regionSize: 8, countPerRegion: 1,
  spawnMinRadius: 16, spawnRadius: 40, despawnRadius: 180,
  wanderMin: 4, wanderMax: 12,
  idleMinMs: 400, idleMaxMs: 1500,
  stepMaxClimb: 1, respawnDelayMs: 4000,
  behavior: 'hostile',
  aggroRadius:     12,
  deaggroRadius:   22,
  aggroDurationMs: 8000,
  attackRange:     1.6,
  attackDamage:    8,
  attackCooldownMs:1000,
  chaseMul:        1.5,
  hitBox:          { sx: 0.85, sy: 0.95, sz: 1.2, oy: 0.5 },
  makeModel:       makeWolfModel,
})
```

### Allowed mob fields and ranges

Out-of-range numbers are **clamped**, unknown keys are dropped, and
`behavior` is forced to `'passive'` if it's not exactly `'passive'` or
`'hostile'`. Built-in `'chicken'` cannot be redefined. The mob `type` must
match `/^[a-z][a-z0-9_-]{0,23}$/`.

| Field             | Range          | Notes                                |
|-------------------|----------------|--------------------------------------|
| `maxHp`           | 1..200         |                                      |
| `damage`          | 0..50          | hit-back fallback if `attackDamage` unset |
| `speed`           | 0..10          | blocks/sec                           |
| `regionSize`      | 1..16          | chunks; XZ size of a "spawn region"  |
| `countPerRegion`  | 0..20          | density cap per region per type      |
| `spawnMinRadius`  | 0..200         | min spawn distance from a player     |
| `spawnRadius`     | 1..500         | max spawn distance from a player     |
| `despawnRadius`   | 1..1000        | despawn if no player within this     |
| `wanderMin`       | 0..50          | wander target distance min           |
| `wanderMax`       | 0..50          | wander target distance max           |
| `idleMinMs`       | 0..30000       | idle pause min between wanders       |
| `idleMaxMs`       | 0..30000       | idle pause max between wanders       |
| `stepMaxClimb`    | 0..3           | hop height in blocks                 |
| `respawnDelayMs`  | 0..60000       | delay after kill before replacement  |
| `fleeBoostMs`     | 0..30000       | passive: speed boost duration on hit |
| `fleeBoostMul`    | 1..5           | passive: speed multiplier during flee|
| `aggroRadius`     | 0..50          | hostile: chase trigger distance      |
| `deaggroRadius`   | 0..100         | hostile: chase exit distance         |
| `aggroDurationMs` | 0..60000       | hostile: chase persistence after hit |
| `attackRange`     | 0..10          | hostile: bite distance               |
| `attackDamage`    | 0..50          | hostile: damage per bite             |
| `attackCooldownMs`| 100..30000     | hostile: between bites               |
| `chaseMul`        | 1..5           | hostile: speed multiplier on chase   |

`hitBox` is `{ sx, sy, sz, oy }` — box width/height/depth and y-offset of
its centre (in blocks). It's the invisible click target the player attacks.

---

## Conventions (match existing files)

- **Tabs for indentation.** No spaces.
- **No semicolons** at statement ends.
- **Single quotes** for strings; backticks for templates.
- `camelCase` functions/variables, `UPPER_SNAKE_CASE` for module-level
  constants.
- Don't hard-code block IDs — always use `api.allocateBlockId()`.
- Don't write CLAUDE.md / README files unless asked.
