# Stage 8 — Collision

**Tag:** `stage-08-collision`
**Diff:** `git diff stage-07-floors-and-ceilings stage-08-collision`

The walls get substance. After seven stages of flying through geometry this is a
surprisingly large change to how the world feels — it is the point at which the level stops
being a picture and starts being a place.

No new pixels. All the work is in [`src/world/collision.ts`](../src/world/collision.ts).

---

## The player is a circle

Not a point, and not a box.

**A point** slips through the diagonal seam where two blocks meet at a corner. Those two
blocks share exactly one point of contact, and a point-sized body passes straight through
it — a classic bug you can find in plenty of shipped games.

**A box** catches on corners. A square that rotates with the player sweeps a larger area
than the square itself, so you snag on things you thought you had cleared. Keeping the box
axis-aligned avoids that but then the collision shape does not match anything the player
can see.

**A circle** has neither problem: it is rotationally symmetric, so turning cannot change
what it collides with, and it has no zero-width point to squeeze through a seam.

And in a grid world the circle is the easy case, because everything solid is an
axis-aligned unit square:

```
     ┌─────────┐
     │  cell   │      nearest point on the cell to the centre is
     │        ●┼───   (clamp(x, cx, cx+1), clamp(y, cy, cy+1))
     └─────────┘  ╲
                   ○ centre     overlap  ⟺  |centre − nearest| < radius
```

The clamp handles all three cases at once — the centre beside the cell, above it, or
diagonally off a corner — which is what makes this the version worth remembering. Only the
cells the circle's bounding box touches are tested, so at most four.

`PLAYER_RADIUS` is 0.28. Comfortably under half a cell, so a one-unit doorway does not
require lining up on it; large enough that you cannot press into a corner and see through
the seam where two walls meet.

---

## Sliding: the obvious approach, and why it is not enough

The textbook method for a grid is to resolve one axis at a time:

```ts
if (!circleHitsSolid(map, x + dx, y, radius)) x += dx;   // x first
if (!circleHitsSolid(map, x, y + dy, radius)) y += dy;   // then y, from the new x
```

The motivation is sound. Test the combined move as a single vector and *any* contact stops
you completely — walk diagonally into a wall and you halt dead, which feels terrible.
Handling the axes separately means the blocked component is refused while the free one goes
through, so you slide along the wall. Most tile-based games do exactly this.

**But it fails at corners, and it is very noticeable.**

Axis separation can only ever move you along x or y. The tangent at a cell *corner* is
diagonal, so when you press into one, both axis moves are individually blocked and you stop
dead — even though you should be sliding smoothly around it. This is not a marginal case:
measured on an isolated block, every approach between roughly **40° and 55° froze solid**,
while more than half the player's speed was tangential and available.

## Projecting onto the contact normal

One rule handles faces and corners together. Find the direction that pushes the body out of
whatever it is touching, discard the part of the motion heading into the surface, and keep
the rest:

```
slide = motion − normal × (motion · normal)
```

```
         motion
           ↘
     ────────●────────   surface, normal ↑
             →  slide    the part heading into the surface is discarded,
                         the part along it survives at full speed
```

On a flat face the normal comes out axis-aligned and this reduces to *exactly* axis
separation — the behaviour that already worked is unchanged, and tangential speed is fully
preserved (measured: 2.000 units of 2.000 retained while pressed against a wall). At a
corner the normal is radial, and you slide around it, which axis separation cannot express
at all.

The move therefore goes: advance as far along the desired motion as possible, find what you
have come to rest against, redirect the leftover motion along it, repeat up to three times.
Three passes covers sliding along one surface into a second, which is what an inside corner
is.

Confirmed in the running game: sprinting north-east into the top wall, the player comes to
rest at **y = 1.28** — the wall face plus the radius — and then continues east at 3.75
units per second, exactly the tangential component of running speed.

### The subtlety that took a second attempt

The first version of this asked for the contact normal at the *target* position — the place
the body was trying to reach and could not.

That is wrong, and wrong in a way that looks like the fix simply not working. A corner's
normal turns as you move around it, so the normal sampled at the deeper, unreachable target
points somewhere slightly different from the one where you are actually resting. Project
against it and the supposedly tangential direction still curves a fraction into the corner:
it collides, the bisection returns approximately zero, and the player sits there apparently
stuck while the arithmetic insists it is sliding.

Sampling at the contact point needs one accommodation. Bisection deliberately stops a hair
*clear* of the surface, so a probe at exactly the radius reports nothing in contact at all;
the probe uses `radius + 1e-3`, comfortably above the bisection residual and far below
anything visible.

### And a third attempt, for inside corners

Standing in an inside corner puts the body in contact with **two** walls at once, at exactly
equal depth. Asking for "the deepest contact" is then a meaningless question, and the answer
comes down to whichever cell the scan reaches first.

That is fine while you are pushing into the corner. It is not fine when you try to leave:
if the arbitrarily chosen wall happens to be the one you are moving *away* from, the motion
is not opposing it, so the resolver concludes there is nothing to slide along and refuses to
move you at all.

The symptom is being welded into a corner. Measured in the north-west corner of a room,
pushing south-west: directions at 135°, 150° and 165° — away from the north wall, into the
west one — produced **exactly zero movement**, where they should have slid south. Their
mirror images all worked, and the difference between the two came down to loop order.

The fix is to make the choice mean something: consider only surfaces the motion actually
pushes into.

```ts
if (motionX * dx + motionY * dy >= 0) continue;   // travelling away from this one
```

The wall you are leaving has no business affecting the result. With that filter the
remaining ambiguity is harmless — when both walls oppose you, either is a valid first
projection, and the surrounding loop re-tests and handles the second.

This is a good argument for the loop existing at all. `MAX_SLIDES` being greater than one is
not defensive padding; a corner genuinely requires two projections.

---

## Stopping *at* the wall, not near it

Refusing a blocked step outright is simpler, and it leaves you up to one full step short of
the wall — about a tenth of a cell at running speed. Worse, how close you can get depends on
how fast you were going, which reads as sponginess.

So a blocked move gets bisected: ten halvings of the interval between "where I am" and
"where I wanted to go".

```ts
let clear = 0, blocked = 1;
for (let i = 0; i < 10; i++) {
  const mid = (clear + blocked) / 2;
  if (circleHitsSolid(map, x + dx * mid, y + dy * mid, radius)) blocked = mid;
  else clear = mid;
}
```

The exact contact point *is* solvable in closed form here, but it needs separate cases for
striking a face and for clipping a corner. Bisection needs no cases at all, works against
whatever `circleHitsSolid` happens to consider solid — which will matter in Stage 9, when
doors become solid only some of the time — and costs ten circle tests only on the ticks
where you are actually touching something.

Ten iterations narrow the step to a thousandth of its length: under a ten-thousandth of a
cell. Measured across approach speeds from 0.005 to 0.15 units per tick, the resting
position varies by **7.8 × 10⁻⁵** units and sits within 0.001 of the wall face plus radius.

---

## Tunnelling, and why the guard is there anyway

If a step is longer than the body is wide, it can jump clean over a wall — start clear on
one side, land clear on the other, never test anything in between.

It cannot happen here. The fastest tick moves 5.4/60 = 0.09 units against a radius of 0.28
and a minimum wall thickness of 1. There is an order of magnitude of headroom.

The guard is two lines regardless:

```ts
const steps = distance > radius ? Math.ceil(distance / radius) : 1;
```

Because this is precisely the bug that appears six months later when somebody adds a sprint
power-up, a knockback, or a lower tick rate — and by then nothing about the symptom points
at the cause. Verified against steps of up to 1000 units, which is longer than the level.

---

## Being stuck is worse than being somewhere wrong

```ts
if (circleHitsSolid(map, position.x, position.y, radius)) {
  position.x += dx;
  position.y += dy;
  return;
}
```

If the body is somehow already inside geometry, every direction is blocked and the player
is trapped permanently with no way out. Reachable if a level places a spawn too close to a
wall, or if `PLAYER_RADIUS` is raised at run time.

Letting the move through unchecked means you can simply walk out. It is not principled, but
the failure it replaces is unrecoverable and this one is invisible.

> **Amended in [stage 14](stage-14-directional-sprites.md).** "Already inside geometry" was
> safe while geometry could not move. Once monsters walk into you it happens constantly, and
> disabling collision against *everything* let you walk out through a wall. The escape now
> applies to the grid and the entity list separately: walls never stop blocking.

---

## Verification

Collision is a good fit for property testing: rather than checking specific positions, run
a lot of movement and assert an invariant that must never break.

- **400,000 random moves** through the real level, with random rotation and random
  forward/strafe each tick, never once ended inside a wall, and never left the level.
- **No approach angle freezes on a corner** — 81 angles from 5° to 85°, each run for 600
  ticks against an isolated block.
- **Every direction slides correctly out of an inside corner** — all four corners of a room,
  360 directions each, 1,440 in total, compared against exactly what the geometry permits
  rather than a vague "did it move". Plus a corner formed against a freestanding block, over
  repeated ticks.
- **Sliding preserves tangential speed** along a flat wall, so the projection removes only
  the component going into the surface.
- **A circle never crosses a diagonal seam** — 2,000 runs pushing directly at the corner
  where two blocks touch. A zero-radius body passes through the same gap, which is the
  control showing the test is measuring what it claims.
- **Doorways stay passable**, both straight on and approached off-centre so the body has to
  slide against the jamb rather than catch on it.
- **No tunnelling** at step sizes up to 1000 units.
- **Escape from inside geometry** works.

The corner bugs are what this stage should be remembered for. Every property above passed
against the axis-separated version — nothing was inside a wall, nothing tunnelled, doorways
worked — because none of them asked the question "having stopped, *should* I have?".
Invariants catch corruption well and lost functionality badly.

Both corner failures were found by a person walking into a corner, not by the tests, and
both needed a *comparison against what should have happened* to pin down. The tests that
now cover them assert an exact expected displacement rather than "the player moved", which
is the difference between a test that would have caught these and one that would not.

There is a pattern in all three attempts: each was correct about flat walls and wrong about
corners. Flat faces are forgiving — everything is axis-aligned and any reasonable approach
works. Corners are where the assumptions get tested, and they are worth deliberately
seeking out whenever you touch collision code.

Two further failures during this stage were both the *tests* being wrong, and both
instructive.
The corner test placed the block against the level border, where the adjacent north and
west walls are also within reach — so the code was right to report a collision and the test
was measuring three walls while claiming to measure one. The doorway test had the gap
perpendicular to the direction of travel, so it was walking into solid wall and complaining
that it could not get through. Geometry tests need their geometry checked too, which is why
the current version asserts what its maps contain before using them.

---

## Running it

```bash
npm run dev
```

<kbd>N</kbd> noclip · <kbd>Shift</kbd> run · <kbd>M</kbd> view

`N` keeps the old fly-through-walls behaviour available, because being able to leave the
level and look back at it is genuinely useful — and it is the quickest way to establish
that a rendering oddity is not a collision problem.

### Verify

1. **Walk into a wall.** You stop, flush against it, with no gap and no jitter.
2. **Walk into it diagonally.** You slide along it smoothly and keep your speed along the
   wall, rather than stopping dead or stuttering.
3. **Run at a wall with <kbd>Shift</kbd>.** Same resting position as walking into it slowly.
4. **Run diagonally at the corner of a pillar.** You slide round it. This is the case that
   axis-separated resolution gets wrong, so it is worth trying from several angles.
5. **Follow a wall around an outside corner.** You should carry round it, not catch.
6. **Walk into an inside corner.** You stop and stay stopped — no vibrating, no creeping.
7. **Aim at the diagonal gap** where two blocks touch at a corner in the top-left of the
   level, and try to squeeze through. You cannot.
8. **Walk through a doorway off-centre.** You slide against the jamb and through.
9. **Doors still block you.** They are ordinary solid tiles until Stage 9.
10. **Press <kbd>N</kbd> and walk out of the level**, then look back at it from outside.

---

## What changed

```
+ src/world/collision.ts   circleHitsSolid, contactNormal, slideMove,
                           bisection contact, normal-projection sliding
~ src/player.ts            move() takes an optional map; no map means no collision
~ src/config.ts            PLAYER_RADIUS
~ src/main.ts              N toggle
```

---

## Next

**Stage 9** makes doors open. It is the fiddliest stage in the walkthrough: a state machine,
a sliding animation, collision that changes with it, and a ray that has to step *into* the
cell to find a door recessed half a unit inside the wall line.
