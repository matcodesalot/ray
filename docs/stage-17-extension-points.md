# Stage 17 — Extension points

**Tag:** `stage-17-extension-points`
**Diff:** `git diff stage-16-audio stage-17-extension-points`

The last stage, and the smallest. The engine is finished; this is about the places a *game*
attaches to it.

The deliverable is [**docs/extending.md**](extending.md) — the guide that names every seam
and says what it is for. What follows here is the five changes to the code that had to
happen first, and why each one was not already right.

---

## The test for whether a seam exists

A seam is not a comment saying "a game would do X here". It is code you can call from
outside without editing the engine. Applying that test honestly to what stages 13–16 left
behind turned up five places where the answer was no, and one of them was actively harmful.

---

## 1. The world could not gain or lose anything

`map.sprites` was `readonly SpriteEntity[]`, fixed at parse time. Every game spawns things —
a dropped key, a corpse, an explosion — and none of it was possible.

```ts
const key = map.spawnEntity(makeEntity(x, y, SpriteKind.Key));
map.despawnEntity(key);
```

Collision and rendering both read the list directly, so a spawned entity blocks and draws on
the next tick with nothing to rebuild. Removal is a `splice` rather than a swap-and-pop:
nothing in the engine depends on the order, but game code holding an index would notice
things shuffling underneath it, and the lists are tens of entries long.

## 2. …and the renderer would have silently dropped them anyway

This one was a real bug rather than a missing feature:

```ts
const count = Math.min(sprites.length, this.order.length);   // before
```

`SpriteRenderer` allocated its sort scratch once, from the level's sprite count, and then
**clamped to it**. Spawn one entity more than the level file contained and that entity would
never be drawn: no error, no warning, just an object that is not there. The worst kind of
limit — silent, and discovered late.

It now grows, doubling, on the tick where the population reaches a new high-water mark and
never again. The per-frame path allocates nothing, exactly as before.

The check is that a renderer built for **one** sprite draws a frame pixel-identical to one
built for twenty-four, with a control confirming that drawing fewer sprites really does
change the frame — otherwise the comparison could not fail.

## 3. Events had no room for a game's own

The bus carried a closed union of engine events, which is precisely the thing that cannot be
extended from outside. It now carries plain numbers, with a documented base:

```ts
export const GAME_EVENT_BASE = 64;
```

Engine events are the small numbers, a game's are anything from 64 up, and the gap is room to
add engine events later without renumbering anybody's game.

## 4. There was no way to ask what can be seen

Every enemy needs it, and every hitscan weapon needs it, and the DDA has been able to answer
it since stage 3 — but only as part of drawing a frame.

```ts
export function lineOfSight(map, fromX, fromY, toX, toY): boolean
```

Worth noticing what this says about the whole technique: **a raycaster's central routine is a
visibility query**, and the renderer is only its most demanding customer. The same function
answers "what does this screen column see" and "can the guard see the player".

It exists mostly to hide one trap. `perpDist` is measured in **ray lengths** — multiples of
whatever direction vector you passed — which is exactly the trick that makes the renderer's
distances perpendicular for free. Write the obvious thing with an unnormalised direction and
you get a boolean that looks reasonable and is wrong by the vector's length. The verification
asserts the naive version *disagrees* on a line you can plainly see along.

Doors and pushwalls needed no work: a closed door blocks sight and an open one does not,
because the ray already knew.

## 5. Nothing could draw in screen space

`Framebuffer` could fill rectangles and spans; `SpriteRenderer` could place a billboard in
the *world*. Nothing could put a picture at a place on the **screen**, which is what a weapon
overlay and every HUD element are made of.

[`render/overlay.ts`](../src/render/overlay.ts) adds two things: `drawTexture`, a
nearest-neighbour scaled blit with transparency and the engine's own `shade`, and an
`OverlayStack` that marks the one place in the frame where such passes belong:

```
raycast → walls → floors → sprites → edge AA → [ overlays ] → present
```

The stack ships empty, because this is an engine and not a game. What it buys is that the
*place* is now a named thing rather than a line in `main.ts` you have to find.

Overlays are given the framebuffer, the player and the render options — and deliberately
**not** the map. An overlay that needs the world is describing a world-space effect and
belongs earlier in the frame.

---

## Cost

Nothing measurable. The overlay stack is one loop over an empty array per frame; `reserve`
compares two integers; `spawnEntity` is a `push`. The frame stays at **0.158 ms** with **0 KB**
retained heap growth.

---

## Verification

`node/extending.ts` — 32 checks. They are here because "the extension point works" is exactly
the claim nobody notices is false until someone is halfway through relying on it:

- spawning blocks and draws immediately; despawning stops both; order survives removal
- the one-capacity renderer draws the same frame as the roomy one, with the non-vacuity control
- line of sight through gaps, walls, and doors in both states — plus the unnormalised control
- `drawTexture` covers exactly its rectangle, clips at the edges, samples pixel centres,
  respects transparency, and reads its texture column-major (with the off-diagonal control
  that makes that checkable)
- overlay passes run in order and unsubscribe cleanly
- engine and game event codes share one bus

---

## That is the engine

Seventeen stages: a framebuffer, a grid, a DDA, a projection, shading, textures, floors,
collision, doors, sprites, polish, real artwork, solid objects, eight-way animation,
pushwalls, sound, and the seams.

What it does not have is a game, and [extending.md](extending.md) is the document that makes
writing one a matter of adding code rather than fighting the engine.
