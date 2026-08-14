# Stage 2 — The map, the camera, and getting around

**Tag:** `stage-02-map-and-movement`
**Diff:** `git diff stage-01-skeleton stage-02-map-and-movement`

Still no 3D. This stage builds the world the rays will travel through and the camera that
will shoot them, and puts a top-down view on screen so you can watch both.

That order is deliberate. The rays in Stage 3 are easy to get subtly wrong and almost
impossible to debug from the first-person view — a wall that is one cell too far away looks
exactly like a wall that is the wrong size. Seen from above, in the same space the maths is
written in, the same bug is obvious at a glance. So we build the debugging tool first and
the thing it debugs second.

---

## The grid world

[`src/world/map.ts`](../src/world/map.ts)

The level is a flat `Uint8Array` of tile values, row-major, one byte per cell, with **one
world unit per cell**.

That last part is the decision worth dwelling on. The original engine used 64 units per
cell, because it worked in fixed-point integers and needed the headroom below the decimal
point. We have doubles, so we can afford the much nicer convention:

```
world x = 5.37   →   grid column 5, and 37% of the way across it
                     ────┬────       ───┬───
                    Math.floor(x)    x - Math.floor(x)
```

A position and a grid coordinate are *the same number*. `Math.floor` moves between them.
This identity is why the ray-stepping loop in Stage 3 is as short as it is, and why the
texture coordinate in Stage 6 comes out of the arithmetic almost for free.

### Out of bounds is solid

`tileAt` returns a wall for any coordinate outside the array:

```ts
if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Tile.Wall1;
```

This is not defensive tidiness, it is load-bearing. The ray loop steps cell by cell until it
hits something solid. If the edge of the array read as empty floor, a ray fired through a
gap in the outer wall would step forever — and because that loop runs 320 times a frame,
"forever" means the tab locks up. Making the outside of the world infinitely solid
guarantees termination, which is why the loop in Stage 3 needs no iteration cap.

### The parser refuses to be lenient

[`parseMap`](../src/world/map.ts) throws on ragged rows, unknown characters, a missing or
duplicated spawn, and any hole in the outer wall. Every one of those failures is quiet if
you allow it, and every one shows up much later as something that looks like a *rendering*
bug:

| the mistake | what you'd actually see |
| --- | --- |
| a row one character short | the whole map skewed diagonally from that row down |
| a stray character | one cell silently floor, a wall with a hole in it |
| an unsealed edge | walk outside and view the level from the void |

Each of those costs an hour to diagnose in the renderer and nothing to catch here. Strict
parsing at the boundary is worth far more than it costs.

### The format

```
.  or space   floor
#             wall
1 2 3 4       wall variants — different textures from Stage 6
D             door (solid for now; Stage 9 makes it open)
^ v < >       player spawn, facing north / south / west / east
@             player spawn, facing east
```

[`level1.ts`](../src/world/levels/level1.ts) is shaped to stress the renderer rather than to
be fun: long sight-lines, tight corridors, freestanding pillars, adjacent wall variants so
texture seams are visible, and narrow gaps — thin slivers of wall at a glancing angle are
where off-by-one errors in the DDA surface first.

---

## Why y points down

Rows in the map file run top to bottom, and screen pixels run top to bottom, so the world
uses the same convention: **+y is south**. Keeping one orientation everywhere avoids a
flip somewhere in the middle of the pipeline, which is a genuinely nasty class of bug.

The cost is that the usual maths habits are mirrored. A positive rotation turns *right*,
not left. And the perpendicular you want is the other one — which brings us to the camera.

---

## The camera: direction and plane

[`src/player.ts`](../src/player.ts)

The player's orientation is two vectors, not an angle:

```
dir     unit vector — where they are facing
plane   perpendicular to dir, length PLANE_LENGTH (0.66)
```

`plane` is the **camera plane**: a line segment held one unit in front of the player,
across their view. Rays are fired at points spread evenly along it.

```
            plane
        ◀─────┼─────▶
         ╲    │    ╱
          ╲   │dir╱
           ╲  │  ╱
            ╲ │ ╱
             ╲│╱
              ●  player
```

The ray for screen column `x` is then just:

```
cameraX = 2 * x / VIEW_W - 1        // -1 at the left edge, +1 at the right
rayDir  = dir + plane * cameraX
```

That is the entire projection. One line, no trigonometry, nothing per-ray more expensive
than two multiplies and two adds.

**And it is the reason there is no fisheye to correct.** The obvious alternative — sweep an
angle from `heading - FOV/2` to `heading + FOV/2` in equal angular steps — spreads the rays
evenly around an *arc*. A flat wall in front of you is at a constant distance from that arc
only at its centre; toward the edges of the screen the distance grows, the wall gets shorter,
and it bows away from you. Spacing the rays along a straight line instead means they land
on a flat surface, exactly as a flat screen does. Stage 3 shows the broken version so you
can see the difference.

Field of view is therefore just the length of the plane: `FOV = 2 * atan(PLANE_LENGTH)`.
0.66 gives about 66°. Try 1.5 and you get the wide-angle stretch of a real lens, because it
is the same geometry.

You can see all of this on screen: the blue segment ahead of the player is the plane, and
the two blue lines to its ends are the extreme rays. Note that the far edge of the wedge is
a straight line, not an arc.

### Keeping the two vectors honest

`rotate()` turns `dir` and then **rebuilds `plane` from it**, rather than rotating both:

```ts
this.planeX = -this.dirY * PLANE_LENGTH;
this.planeY =  this.dirX * PLANE_LENGTH;
```

Two things fall out of that.

First, `(-dirY, dirX)` is the correct perpendicular for a y-down world. Facing east
`(1, 0)` gives a plane along `(0, 1)` — south, which is indeed on your right when you face
east. Take the other perpendicular and the entire world renders mirrored, which is
remarkably easy to stare straight past.

Second, it eliminates drift. Rotating both vectors independently accumulates floating-point
error, and after a long session the plane is no longer quite perpendicular and no longer
quite the right length. The symptom is a field of view that very slowly changes, or a view
with a faint shear — miserable to track down, and free to prevent. The verification for
this stage rotates 200,000 times and checks the invariants still hold exactly.

---

## Input

Three files, because three separate concerns.

**[`keys.ts`](../src/input/keys.ts) — what is held right now.** The DOM only reports
changes, so we maintain a `Set`. Two details:

- Keys are tracked by `event.code` (the physical position) and never `event.key` (the
  character produced). On an AZERTY keyboard the W position produces `'z'`. WASD is a
  *shape*, not a set of letters.
- The set is cleared on `blur`. Hold a movement key, alt-tab away, release it — the keyup
  goes to the other window and never arrives. Come back and the player is walking off on
  their own, forever. This one bites everybody once.

**[`mouse.ts`](../src/input/mouse.ts) — pointer lock.** Ordinary mouse events give a
position within the window, which is useless for looking around; the cursor hits the screen
edge and stops. Pointer lock switches to *relative* movement with no bound. Two rules come
from the browser rather than from us: lock can only be requested from a user gesture (hence
the click), and Escape always releases it with no way to prevent or immediately re-request.
Treat the lock as something you can lose at any moment.

Movement is accumulated between reads rather than sampled. Several `mousemove` events can
arrive within one frame, and keeping only the latest would silently discard real motion —
the camera would feel like it was dropping input, worse the faster your mouse polls.

**[`scheme.ts`](../src/input/scheme.ts) — bindings, resolved away.** Both control schemes
produce the same `MoveIntent`:

```ts
{ forward, strafe, turn, turnDelta, run }
```

`Player` never learns that W means forward, or that the classic scheme repurposes the arrow
keys when Alt is held. That separation is the only reason two schemes this different can
coexist without a single conditional leaking into the movement code.

Worth actually playing with the classic scheme for a minute (`` ` `` to switch). Turning is
a key you hold, so it happens at one fixed rate and you cannot snap around to face
something. Strafing needs a modifier because there were not enough keys. Both facts shaped
how the original's levels and encounters were built — the difference is not cosmetic.

### Two things in `update` that look like details and are not

**Turn rate versus turn delta.** `turn` is an axis, so it is multiplied by `dt`: hold the
key, turn at a steady speed. `turnDelta` is already an angle — the mouse has physically
moved that far — so it is applied as-is. Scale it by `dt` and mouse sensitivity starts
varying with frame rate.

**Diagonals are normalised.** Forward and strafe held together give a vector of length
√2, so without normalising you move 41% faster diagonally than straight ahead. Old enough
to have a name.

---

## Running it

```bash
npm run dev
```

Click the canvas to capture the mouse. `` ` `` switches control scheme. Escape releases the
pointer.

### Verify

1. **The map matches [`level1.ts`](../src/world/levels/level1.ts)** — compare the ASCII to
   what is drawn. Wall variants have distinct colours; the two `D` doors are yellow.
2. **Forward goes where you are pointing.** Turn 90° and walk; you should move along the
   white facing line, not sideways. If forward and strafe are swapped, `move()` has its
   perpendicular backwards.
3. **Turning right in the world turns right on screen.** Push the mouse right, or hold E:
   the wedge sweeps clockwise. If it goes anticlockwise, the sign convention is inverted
   somewhere and every later stage will render mirrored.
4. **Diagonals are not faster.** Hold W, watch the `pos` readout tick along; then hold W+D
   and confirm the total rate is the same.
5. **Both schemes work.** `` ` `` to switch; the overlay shows which is active and its
   bindings. Classic ignores the mouse entirely and releases the pointer.
6. **The alt-tab test.** Hold W, alt-tab away, release W, come back. The player must be
   stationary.
7. **Walls do not stop you.** Expected — there is no collision until Stage 8. Walk out
   through the outer wall and around the outside; it is a useful way to inspect the
   geometry, and it comes back in handy in Stage 3.
8. **Corrupt the map on purpose.** Delete one character from a row in `level1.ts`. The page
   should fail immediately with a clear message naming the row, not render something odd.

---

## What changed

```
+ src/world/tiles.ts             tile values, the character table
+ src/world/map.ts               GameMap, parseMap, enclosure check
+ src/world/levels/level1.ts     the test level
+ src/player.ts                  position, dir, plane, rotate, move
+ src/input/keys.ts              held-key set
+ src/input/mouse.ts             pointer lock, accumulated movement
+ src/input/scheme.ts            MoveIntent, modern and classic schemes
+ src/render/minimap.ts          the top-down view
~ src/engine/framebuffer.ts      added drawLine (Bresenham)
~ src/config.ts                  PLANE_LENGTH, speeds, sensitivity
~ src/main.ts                    wiring
- src/render/testpattern.ts      scaffolding, no longer needed
```

---

## Next

**Stage 3** casts the rays. The DDA algorithm walks a ray cell by cell through the grid,
using only addition and a comparison, and stops the instant it enters a solid one. We draw
all 320 of them onto this top-down view so you can watch them work — and see what happens
when you use the wrong distance measure.
