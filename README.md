# ray

A Wolfenstein 3D–style raycaster in TypeScript, built in eleven stages you can check out
and run individually.

Everything is drawn by hand into a 320×200 buffer of 32-bit pixels — no WebGL, no canvas
drawing calls beyond a single scaled blit per frame. Every texture is generated in code at
startup, so there are no binary assets anywhere in the repository.

```bash
npm install
npm run dev
```

Press <kbd>H</kbd> in the browser for controls.

![Textured walls, cast floors, sprites and a corner minimap](docs/images/sprites.png)

---

## The walkthrough

Each stage is one commit and one tag, with a document explaining what it added and why.
`git diff stage-03-dda stage-04-first-3d` shows exactly what one idea costs in code.

| | stage | what it adds |
| --- | --- | --- |
| 1 | [skeleton](docs/stage-01-skeleton.md) | The software framebuffer, the upscale pipeline, a fixed-timestep loop |
| 2 | [map and movement](docs/stage-02-map-and-movement.md) | ASCII levels, the camera as direction + plane, both control schemes |
| 3 | [DDA](docs/stage-03-dda.md) | Casting 320 rays through the grid, exactly and cheaply |
| 4 | [first 3D view](docs/stage-04-first-3d.md) | `VIEW_H / perpDist` — the entire projection |
| 5 | [distance shading](docs/stage-05-shading.md) | Depth from brightness, and cheap per-pixel colour arithmetic |
| 6 | [textures](docs/stage-06-textures.md) | `wallX`, fixed-point column stepping, procedural artwork |
| 7 | [floors and ceilings](docs/stage-07-floors-and-ceilings.md) | Row-based casting — the first genuinely per-pixel pass |
| 8 | [collision](docs/stage-08-collision.md) | Circle-vs-grid with contact-normal sliding |
| 9 | [doors](docs/stage-09-doors.md) | Recessed sliding slabs, and the one cell the DDA passes through |
| 10 | [sprites](docs/stage-10-sprites.md) | Billboards, depth testing, painter ordering |
| 11 | [polish](docs/stage-11-polish.md) | Minimap, help overlay, edge anti-aliasing, performance |

---

## The shape of the engine

A frame is four passes over a 320×200 buffer:

```
  cast 320 rays          one per screen column, DDA through the grid
        │
        ▼
  walls                  one vertical span per column, recording what each covers
        │
        ▼
  floors and ceilings    per row, skipping whatever the walls already claimed
        │
        ▼
  sprites                sorted far to near, depth-tested against the ray fan
```

Three ideas do most of the work:

**The camera is a direction vector and a perpendicular plane, not an angle.** Rays are
spread along a straight line rather than evenly in angle, which is why there is no fisheye
distortion to correct — see [stage 3](docs/stage-03-dda.md).

**Distances are measured in ray lengths.** Because `rayDir · dir == 1` for every column,
"distance along the ray" and "perpendicular distance to the camera plane" are the same
number. Wall heights, floor rows, sprite depths and the depth test all share one unit,
with nothing to convert between them.

**The camera cannot tilt.** That single constraint makes wall columns constant-depth,
screen rows constant-depth, and billboards indistinguishable from cylinders. Almost every
shortcut in the renderer traces back to it, and so does every limitation.

---

## Cost

Measured at 320×200, median of 3000 frames, against a 16.67 ms budget:

| pass | time |
| --- | --- |
| raycast, 320 rays | 0.016 ms |
| walls | 0.049 ms |
| floors and ceilings | 0.114 ms |
| sprites (17 objects) | 0.003 ms |
| edge anti-aliasing | 0.009 ms |
| **full frame** | **0.191 ms** |

Heap growth over 300 frames: **0 KB**. Nothing in the render path allocates.

---

## Layout

```
src/
  config.ts             tunable constants
  main.ts               the only file that touches the DOM
  player.ts             position, direction, camera plane, movement
  core/loop.ts          fixed-timestep loop
  engine/               framebuffer and pixel packing — knows nothing about the game
  world/                map, doors, collision, entities
  render/               raycast, walls, floors, sprites, lighting, minimap
  assets/textures.ts    every texture, generated at startup
docs/                   one document per stage
```

`engine/` and `core/` never import from `world/`; `render/` never mutates game state.

---

## Things it deliberately does not do

- **No sloped floors, room-over-room, or looking up and down.** All ruled out by the fixed
  camera height, which is what everything else is built on.
- **Sprites do not block movement** and do not animate. Both are noted with the hook for
  adding them in [stage 10](docs/stage-10-sprites.md).
- **No combat, enemies, or game logic.** This is the renderer and the world it moves
  through, not a game.
- **No test framework.** Each stage was verified with throwaway scripts driving the real
  modules; what those checked is written up in each stage document.
