# Stage 13 — Blocking sprites

**Tag:** `stage-13-blocking-sprites`
**Diff:** `git diff stage-12-image-textures stage-13-blocking-sprites`

Objects stop being scenery you walk through. No renderer changes at all — the whole stage
is two loops added to [`src/world/collision.ts`](../src/world/collision.ts).

This is the first of the stages that finish the engine rather than extend the renderer: the
remaining gaps before a game can sit on top are solid objects, sprites that face and animate,
pushwalls, and sound.

---

## A radius, not half the width

```ts
[SpriteKind.Barrel]: { width: 0.62, height: 0.68, blocking: 0.26 },
[SpriteKind.Plant]:  { width: 0.72, height: 0.8,  blocking: 0    },
```

`blocking` is a collision radius, and zero means walk straight through — so foliage stays
passable while barrels and columns do not. Having it per kind rather than a flag is what
makes that distinction expressible at all.

It is deliberately *smaller* than half the visual width. Matching the two exactly makes
objects feel bigger than they look, because you stop before you appear to touch them. A
barrel that reads as solid a little inside its own silhouette feels right; one that stops
you at the exact edge of its sprite feels like it has an invisible shell.

---

## Two loops, and nothing else

`circleHitsSolid` and `opposingContactNormal` each gain a sweep over the entity list. Circle
against circle is the easy case — overlap when the centres are closer than the sum of the
radii, which needs no square root to decide.

**The resolver needed no changes whatsoever**, and that is worth dwelling on. A
circle-versus-circle contact normal is *radial*, which is exactly the shape a cell **corner**
produces. Stage 8 spent three attempts getting radial contacts right; every one of those
lessons applied here for free, and sliding around a barrel worked the first time.

One detail carried over deliberately:

```ts
const depth = gap > 1e-6 ? gap : 1e-6;
```

A body that has somehow ended up inside an entity still needs a direction to escape along.
Left at zero the contact vector collapses, the caller is told there is nothing to slide
against, and you are welded in place — the Stage 8 corner failure wearing a different hat.

---

## This revises what Stage 9 claimed

Stage 9 says, of collision:

> Stage 8's collision code is untouched and never learns that doors exist.

Half of that still holds. Doors remain a pure `isSolid` integration, because bisection asks
what is solid *now* and a cell that stops being solid needs no special handling. But entities
are not cells, so they could not go through `isSolid` at all, and this file stopped knowing
only about the grid. Both that document and the module header now say so, rather than leaving
the two quietly contradicting each other.

---

## Cost

Per movement tick, measured over 400,000 moves through the real level:

| | per move |
| --- | --- |
| grid only | 0.096 µs |
| grid + 17 entities | 0.140 µs |

A 46% increase on a number that is 0.0008% of a 16.67 ms frame. The sweep is linear over
every sprite in the level and runs inside all ten bisection steps, which sounds careless and
is not: at a couple of dozen entities it is far cheaper than the spatial index that would
avoid it. Bucketing entities by cell is the fix if a level ever holds hundreds.

Rendering is untouched, so frame cost is unchanged at 0.166 ms.

---

## Verification

[`tools/verify/node/collision.ts`](../tools/verify/node/collision.ts), which also picks up
the Stage 8 properties — making sprites solid touches the same two functions the corner bugs
lived in, so the old guarantees are re-checked every run rather than assumed.

- Contact geometry: overlapping just inside the summed radii, clear just outside, and exactly
  touching counts as clear.
- Resting distance is exactly `PLAYER_RADIUS + blocking`, and does not depend on approach
  speed (spread 4.9 × 10⁻⁵ across speeds from 0.005 to 0.09).
- **360 off-centre approaches** slide past without freezing and without ending up inside.
- Non-blocking kinds are still walked straight through.
- Escaping from inside an entity works.
- All 360 directions still slide correctly out of an inside corner, and 400,000 random moves
  never end inside a wall *or* an entity.

The sliding sweep needed rewriting once. The first version aimed every approach at the
barrel's centre and reported all 180 as frozen — but a dead-centre push is purely radial and
stopping is the correct answer, exactly as it is when pushing straight into a corner. The
test now sweeps *impact parameters*, how far off centre the approach is aimed, and keeps the
dead-centre case as an explicit control so the distinction is asserted rather than assumed.

---

## What changed

```
+ tools/verify/node/collision.ts   grid and entity collision properties
~ src/world/entities.ts            SpriteSize gains a blocking radius
~ src/world/collision.ts           entity sweeps in both tests; header revised
```

---

## Next

**Stage 14** gives sprites a facing and animation frames — the feature every enemy in
Wolfenstein depends on, and the one that needs real sprite sheets.
