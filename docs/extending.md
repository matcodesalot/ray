# Building a game on this engine

The engine is finished; the game is not written. This is the map of where the two meet.

Nothing here is a framework. There is no plugin system, no registry, no lifecycle to
implement — the seams are ordinary functions and mutable fields, because that is what a
codebase this size actually needs. What follows is where they are and why they are shaped
the way they are.

**The short version:**

| you want to | the seam |
| --- | --- |
| make something act | `entity.behaviour` |
| put something in the world, or take it out | `map.spawnEntity` / `map.despawnEntity` |
| react to what the world does | `map.events` |
| ask what can be seen from where | `lineOfSight` |
| stop things walking through each other | `slideMove`, `circleHitsSolid` |
| draw a HUD or a weapon | `OverlayStack`, `drawTexture` |
| play a sound | emit an event; the mixer is already listening |

---

## 1. Behaviours: making something act

Every entity has an optional callback, run once per fixed tick:

```ts
import { type Behaviour, startAnimation, Animation } from './world/entities';

const guard: Behaviour = (self, ctx) => {
  const dx = ctx.player.x - self.x;
  const dy = ctx.player.y - self.y;

  if (lineOfSight(ctx.map, self.x, self.y, ctx.player.x, ctx.player.y)) {
    self.angle = Math.atan2(dy, dx);
    startAnimation(self, Animation.Walk);
    slideMove(ctx.map, self, Math.cos(self.angle) * 1.4 * ctx.seconds,
                          Math.sin(self.angle) * 1.4 * ctx.seconds, PLAYER_RADIUS, self);
  }
};

map.sprites[0]!.behaviour = guard;
```

There is no command queue and nothing to register. Position, facing and current animation are
plain mutable fields; a behaviour assigns to them. The context hands over the whole map and
the player rather than a curated subset, deliberately — guessing in advance at what enemies
will need to see is how an interface ends up widened once per feature.

[`src/world/demo-patrol.ts`](../src/world/demo-patrol.ts) is a worked example, marked as demo
code and safe to delete.

**Two rules worth keeping.** Move with `slideMove`, passing the entity itself as the last
argument, or it collides with its own blocking circle and never moves. And do everything in
`update`, never in `render` — the fixed timestep is the only reason anything in this engine
behaves the same on a 60 Hz laptop and a 240 Hz monitor.

### Where behaviours run

`updateEntities(map.sprites, context, timing)` in `main.ts` runs every behaviour and then
advances animation. A game will want more than that eventually — enemies that think in
groups, a spawn director — and none of it needs to happen inside this call. Add your own
system next to it.

---

## 2. Spawning and despawning

```ts
const key = map.spawnEntity(makeEntity(x, y, SpriteKind.Key));
// ...later
map.despawnEntity(key);
```

Collision and rendering both read `map.sprites` directly, so a spawned entity blocks and
draws on the very next tick with nothing to rebuild.

Two things to know. Nothing checks whether the position is inside a wall — dropping an item
where a body just died is a normal thing to do, and `circleHitsSolid` is there if you want to
be fussier. And `SpriteKind` is a closed list in
[`entities.ts`](../src/world/entities.ts): a new kind is a line there, a size in
`SPRITE_SIZES`, and an entry in the texture manifest.

---

## 3. Events

The world announces; anyone can listen.

```ts
import { GAME_EVENT_BASE, WorldEvent } from './core/events';

export const GameEvent = {
  EnemyDied: GAME_EVENT_BASE,
  KeyPicked: GAME_EVENT_BASE + 1,
} as const;

map.events.subscribe((event, x, y) => {
  if (event === GameEvent.EnemyDied) score += 100;
});

map.events.emit(GameEvent.EnemyDied, enemy.x, enemy.y);
```

Codes below `GAME_EVENT_BASE` belong to the engine; everything from there up is yours. The
gap between the two is room for the engine to grow without renumbering anybody.

The payload is `(kind, x, y)` and not an object, because events are emitted from inside the
fixed timestep and a steady tick in this project allocates nothing at all. If your game needs
a richer payload, widening this is a deliberate decision with a measurable cost, not a
detail — keep a side table keyed by entity if you can, and widen it if you cannot.

**Sound is already wired to this.** [`world-audio.ts`](../src/audio/world-audio.ts) is a
table from event codes to sounds plus one `subscribe` call; adding a sound for a game event
is a line in that table. Nothing in `world/` knows the mixer exists, and nothing should.

---

## 4. Asking the world questions

```ts
lineOfSight(map, guard.x, guard.y, player.x, player.y)   // can it see me?
circleHitsSolid(map, x, y, radius)                       // would a body here be stuck?
slideMove(map, body, dx, dy, radius, ignore?)            // move it, sliding along whatever it meets
map.isSolid(cellX, cellY)                                // grid-level, for coarse questions
map.doorAt(cellX, cellY) / map.pushwallAt(cellX, cellY)  // the live state of one cell
```

`lineOfSight` is the same DDA the renderer uses, and it costs about what one screen column
costs — you can afford it per enemy per tick without thinking about it. Doors and pushwalls
need no special handling: a closed door blocks sight, an open one does not, because the ray
already knows.

For a hitscan weapon, use `castRay` directly and read the whole `RayHit`: what was hit, at
what distance, and where on the face. **Normalise the direction you pass it.** Distances come
back in ray lengths — multiples of the vector you supplied — which is the trick that makes the
renderer's distances perpendicular for free, and a trap everywhere else.

`slideMove`'s last argument is an entity to ignore, which is what a moving body passes for
itself. Bodies do not push each other: two entities that end up overlapping will each slide
out of the other, and while overlapping neither is blocked by *entities* — but both are still
blocked by walls, always.

---

## 5. Drawing on top: HUD, weapon, damage flash

The frame is world passes, then overlays, then present:

```
  raycast → walls → floors → sprites → edge AA → [ your overlays ] → present
```

```ts
import { drawTexture, type OverlayPass } from './render/overlay';

const weapon: OverlayPass = (fb, player, options) => {
  const scale = fb.height / 100;
  drawTexture(fb, textures.sprites[SpriteKind.Pistol]!,
              (fb.width - 64 * scale) / 2, fb.height - 64 * scale,
              64 * scale, 64 * scale);
};

overlays.add(weapon);
```

`drawTexture` is nearest-neighbour and honours transparency, so it matches everything else on
screen — a smoothed weapon sprite over a 320×200 world looks pasted in from another game. It
takes an optional brightness that runs through the same `shade` the world uses, so a HUD can
be dimmed consistently.

For bars, panels and crosshairs, `Framebuffer` has `fillRect`, `drawLine` and `verticalSpan`,
and every pixel is yours: `fb.pixels[y * fb.width + x]`.

**A full-screen flash** is an overlay that blends a colour over everything:

```ts
const flash: OverlayPass = (fb) => {
  if (damageFlash <= 0) return;
  const tint = rgb(200, 30, 30);
  for (let i = 0; i < fb.pixels.length; i++) {
    fb.pixels[i] = blend(fb.pixels[i]!, tint, damageFlash * 255);
  }
};
```

Note what overlays are *not* given: the map. An overlay that needs the world is describing a
world-space effect and belongs earlier in the frame, before the sprite pass.

---

## 6. The things the engine deliberately does not do

Not oversights. Each is a decision with a reason, and each is where a game does its own work.

**Game state.** There is no menu, no pause, no level transition, no save. `main.ts` boots one
level and runs one loop. A game wraps that: a state machine around `startLoop`, and
`parseMap` called again for the next level.

**Health, damage, ammo, score, keys.** None of it exists, and none of it is the engine's
business. Locked doors are the interesting one: `DoorSystem.activate` returns a boolean, so a
game gates it on a key check by wrapping the call rather than by editing the door.

**Enemy AI.** The behaviour hook and `lineOfSight` are the foundation; sight cones, hearing,
pathfinding and group behaviour are yours. Note there is no pathfinding at all — the grid is
a `Uint8Array` and A* over it is fifty lines, but this engine does not have an opinion about
it.

**Looking up and down, room over room, sloped floors.** These are not "not yet". The fixed
camera height is what makes wall columns constant-depth, screen rows constant-depth, and
billboards indistinguishable from cylinders. Almost every shortcut in the renderer traces
back to it, and so does every limitation.

**Front-to-back audio.** Stereo carries one axis. Telling ahead from behind needs
head-related transfer functions, which cost more than everything else here put together.

---

## 7. Where things live

```
src/
  config.ts        every tunable constant, in one file, commented with what it trades against
  main.ts          the only file that touches the DOM — your entry point to replace or wrap
  player.ts        position, direction, camera plane, movement
  core/            fixed-timestep loop, world event bus
  engine/          framebuffer and pixel packing — knows nothing about the game
  world/           map, doors, pushwalls, collision, entities, behaviours
  render/          raycast, walls, floors, sprites, lighting, minimap, overlays
  audio/           manifest, loader, mixer, positional maths
  assets/          the texture manifest and loader, plus the PNGs and Ogg files
```

Three rules the layering keeps, and that are worth keeping:

- `engine/` and `core/` never import from `world/`.
- `render/` never mutates game state.
- `world/` knows nothing about `audio/` — it announces on the event bus, and audio listens.

---

## 8. How to know you have not broken it

`npm run verify` runs the checks; `npm run verify -- --all` adds the ones needing a browser.
They import the real modules and assert against them, and they are worth reading before you
change something — each one is written up in the stage document it belongs to.

The habit they encode, learned the hard way several times in this project's history:

> **Assert what should have happened, not that something happened.** Every serious bug here
> passed the invariants that only asked "is the state still valid?" — the mirrored textures,
> the corner that froze the player, the sprite drawn at the wrong place off-axis. Each was
> caught by a check that said where something should *be*, and each of those checks carries a
> negative control proving it can fail.

And its corollary: **when a new check fails, suspect the check first.** It has been the
check's fault more often than the engine's.
