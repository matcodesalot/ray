# Stage 1 — Skeleton

**Tag:** `stage-01-skeleton`

Nothing in this stage is a raycaster. It builds the surface we will draw on, and proves that
surface works, so that when Stage 4 puts the first wall on screen we already know that a wrong
colour or a missing row is the raycaster's fault and not the plumbing's.

---

## What a raycaster actually needs from the canvas

The `<canvas>` 2D API offers two very different ways to put an image on screen.

The convenient one is the drawing API: `fillRect`, `drawImage`, paths and gradients. It is
hardware-accelerated and it is what most canvas tutorials use. A raycaster *can* be written with
it — each wall column becomes a 1-pixel-wide `drawImage` of a texture strip.

The other is to hand the canvas a block of raw bytes with `putImageData` and say "these are the
pixels". No drawing calls, no GPU: you compute every pixel yourself.

We take the second route, because three things we want later are awkward or impossible with the
first:

- **Textured floors and ceilings.** These are cast *per pixel*, along horizontal rows, with a
  different texture coordinate at every single pixel. There is no `drawImage` call that does that.
- **Distance shading.** Every pixel is darkened by its own depth. Doing that with the drawing API
  means compositing passes; doing it with raw pixels is one multiply.
- **Colour-keyed sprites.** Skipping transparent pixels while testing each column against a depth
  buffer is a per-pixel decision.

This is also what the original engine did. Wolfenstein 3D wrote bytes into VGA memory. Our
`Uint32Array` is the same idea with a modern allocation.

---

## The pixel pipeline

[`src/engine/framebuffer.ts`](../src/engine/framebuffer.ts)

```
Uint32Array  ──same bytes──▶  ImageData  ──putImageData──▶  320×200 canvas
                                                                 │
                                                            drawImage (scaled)
                                                                 ▼
                                                        visible canvas
```

Three details in that chain matter.

**The `Uint32Array` is a view, not a copy.** `new Uint32Array(imageData.data.buffer)` lays a
32-bit array over the very same memory the canvas will read. Writing `pixels[i] = colour` writes
directly into what gets uploaded — there is no copy step, and no separate "flush" beyond
`putImageData`. One 32-bit store per pixel instead of four 8-bit stores is a real difference in a
loop that runs 64,000 times a frame.

**`putImageData` cannot scale.** It is deliberately specified as a raw byte blit: it ignores the
context transform and has no scaling arguments. So we `putImageData` onto a small offscreen canvas
that is exactly 320×200, then `drawImage` *that* canvas onto the visible one at whatever size the
window is. `drawImage` is the call that can scale, and `imageSmoothingEnabled = false` is what
makes the scale-up produce hard pixel blocks instead of a blurry smear.

**The cost of a frame is fixed.** We always compute 320×200 = 64,000 pixels, whether the window is
a postage stamp or a 4K display. Only the final `drawImage` gets more expensive, and that one is on
the GPU. This is the single most valuable property of the original design and it is worth keeping.

---

## Byte order: the one genuinely fiddly bit

[`src/engine/color.ts`](../src/engine/color.ts)

The canvas reads its bytes as `R, G, B, A` in memory order. When you write a 32-bit integer into
that memory, which byte of the integer lands in which slot depends on the machine's byte order:

| host | integer layout |
| --- | --- |
| little-endian (x86, ARM — everywhere you will run this) | `0xAABBGGRR` |
| big-endian | `0xRRGGBBAA` |

So on your machine, **red lives in the low byte** and alpha in the high one. That is backwards from
how CSS hex colours read, and writing `0xFF0000` expecting red gets you blue instead. This is the
classic first bug in a software renderer.

`rgb()` handles it, detecting the host's order once at startup, and every other file in the project
just calls `rgb()` and never thinks about it again.

One more wrinkle in that function: the trailing `>>> 0`. Setting the alpha byte sets bit 31, and
JavaScript's bitwise operators work on *signed* 32-bit integers, so without the shift you get a
negative number back. `>>> 0` is the standard idiom for coercing to unsigned.

---

## The fixed-timestep loop

[`src/core/loop.ts`](../src/core/loop.ts)

`requestAnimationFrame` fires at whatever rate the display runs — 60Hz, 120Hz, 144Hz, or
irregularly under load. If movement were `position += speed * frameTime`, the game would *mostly*
behave the same across those, but collision, door timers and anything with a threshold would not.
The classic symptom is walking through a wall only on a fast machine.

So we separate the two clocks:

```
                elapsed real time
                       │
                       ▼
               ┌───────────────┐
               │  accumulator  │
               └───────┬───────┘
                       │  while (accumulator >= 1/60)
                       ▼
                  update(1/60)      ← always the same dt
                       │
                       ▼
                    render()        ← once per displayed frame
```

Real elapsed time goes into a bank; the simulation spends it in fixed 1/60s chunks and leaves the
remainder banked for the next frame. `update` therefore only ever sees one value of `dt`.

The `MAX_FRAME_TIME` clamp guards the failure mode this design otherwise has. Background the tab
for ten seconds and the next frame reports a ten-second delta, demanding 600 catch-up ticks — which
take longer than one frame, producing an even bigger delta next time, and the loop never recovers.
Clamping loses a little simulated time in exchange for never spiralling.

`render` receives an `alpha` — how far we are between ticks — which nothing uses yet. It is there
for later: if motion looks stepped on a high-refresh monitor, interpolating the camera by `alpha`
is the fix.

---

## Why the image is letterboxed at 4:3

VGA mode 13h was 320×200 pixels shown on a 4:3 monitor. 320/200 is 1.6, not 1.333 — so those pixels
were **not square**. Each was about 1.2× taller than it was wide, and the artists drew everything
knowing that. Displaying a 320×200 buffer at 1.6 today makes the original proportions look subtly
squashed.

`DISPLAY_ASPECT` in [`src/config.ts`](../src/config.ts) is therefore `4/3`, and `main.ts` fits the
largest 4:3 rectangle it can inside the window, centred, with black bars on the leftover. Set it to
`VIEW_W / VIEW_H` if you would rather have square pixels.

The other half of getting a crisp image is the difference between a canvas's **CSS size** (how big
the element looks) and its **backing-store size** (how many pixels it actually has). If you only set
the CSS size, the browser gives you a small backing store and stretches it — everything looks soft
on a HiDPI screen. `resize()` sets `canvas.width/height` from `clientWidth/Height × devicePixelRatio`
so one backing-store pixel is one physical pixel.

---

## Running it

```bash
npm run dev
```

### What you should see

An animated XOR interference pattern, three colour swatches along the bottom, a white one-pixel
border, magenta corner brackets, and an FPS readout in the top left.

### Verify

1. **The pattern animates.** A frozen image means the loop is not running.
2. **The swatches are red, green, blue — left to right.** If they come out blue, green, red, the
   byte order in `color.ts` is wrong for your machine.
3. **FPS sits at your display's refresh rate** (60, 120, 144…) and is stable.
4. **Resize the window.** The image stays pixel-crisp and chunky at every size — never blurry — and
   keeps its 4:3 proportions with black bars on the long edge.
5. **The border and corner brackets are fully visible on all four edges.** A clipped edge means the
   viewport rectangle is being computed or rounded wrong.
6. **The `display` line in the overlay** shows the upscale factor. At 1280×800 you should see a
   1066×800 viewport, about 3.33×.

---

## What is here

```
index.html              canvas + DOM overlay for debug text
src/config.ts           VIEW_W/VIEW_H, display aspect, tick rate
src/core/loop.ts        fixed-timestep loop, FPS counter
src/engine/color.ts     32-bit pixel packing, endianness
src/engine/framebuffer.ts   the buffer, vertical spans, present()
src/render/testpattern.ts   scaffolding — deleted in Stage 2
src/main.ts             DOM wiring, resize, letterboxing
```

`Framebuffer.verticalSpan` is worth noting now: filling one column between two y values is the
raycaster's fundamental drawing operation. One wall slice is exactly one call to it. Everything from
Stage 4 onward is built out of that primitive.

---

## Next

**Stage 2** introduces the world: an ASCII map format, the player's position and facing, keyboard
and mouse input with both control schemes — and a top-down view of it all. Still no 3D. Seeing the
map from above first makes the rays in Stage 3 much easier to reason about, because you can watch
them.
