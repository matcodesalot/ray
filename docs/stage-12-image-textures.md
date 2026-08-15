# Stage 12 — Real image textures

**Tag:** `stage-12-image-textures`
**Diff:** `git diff stage-11-polish stage-12-image-textures`

Every texture up to Stage 11 was arithmetic: 488 lines of brick courses, value noise and
ellipse tests, evaluated at module load. This stage replaces all of it with PNG files.

That is a bigger change than swapping pixel sources. Image decoding is asynchronous, so
the project acquires its first `await`. Real artwork has an alpha channel, so sprites gain
proper blending. And real artwork has *orientation*, which turned out to matter more than
anything else here.

![The engine running on image textures, placeholder labels reading correctly](images/image-textures.png)

---

## What the artwork has to satisfy

The renderer indexes every texture with the global `TEX_SIZE`, so this is not negotiable:

- **Exactly 64×64**, or whatever `TEX_SIZE` is set to in `src/config.ts`. Power of two,
  because the inner loops wrap coordinates with `& TEX_MASK` rather than a modulo. The
  loader rejects anything else, naming the file.
- **Wall textures repeat once per cell horizontally.** The left and right edges must meet,
  or every cell boundary along a wall shows a seam.
- **Floor and ceiling tile in both axes** — they repeat across the world grid in x and y.
- **Sprites need transparent margins** and should stand on the bottom edge of the image,
  because sprites are anchored by their feet (Stage 10).

To swap in your own art, replace the PNG in `src/assets/images/` and leave everything else
alone. The committed placeholders are deliberately ugly, and they are also correct examples
of all four rules — worth opening before drawing anything.

---

## The manifest earns its keep at build time

```ts
import wall1 from './images/wall-1.png?url';
```

Files are imported with Vite's `?url` suffix rather than named as path strings. A missing or
misspelled file is then a **build failure**, named, rather than a 404 at run time or — far
worse — a texture that silently falls back to the missing-texture checkerboard and ships
that way. Same instinct as `parseMap` refusing malformed levels back in Stage 2.

---

## Pure conversion, separate from IO

The loading code is split in two, and the split came out of a test failure rather than
foresight:

```
decode.ts   pixels -> Texture. No fetch, no DOM, no idea which files exist.
loader.ts   fetch, decode into a canvas, read back, assemble the TextureSet.
```

The headless verification bundles the real modules with rolldown, which does not understand
Vite's `?url`. Importing the transpose logic dragged in the entire asset list and the bundle
failed. That is a design smell as much as a tooling problem: the conversion has no business
knowing what the manifest contains. Separating them made the tests work *and* made the two
things most likely to be wrong testable against hand-built input, with no browser and no
network.

### The transpose

`getImageData` is row-major. `Texture.data` is column-major, because Stage 6 chose that so a
wall slice walks contiguous memory. So:

```ts
data[x * TEX_SIZE + y] = /* pixel at (x, y) in the source */
```

Get this backwards and the texture is mirrored along its diagonal — *plausibly* wrong rather
than obviously broken, and on a symmetric pattern nearly invisible. It is verified across all
4096 texels with a pattern where every texel encodes its own coordinates, plus a **negative
control** asserting that a row-major read matches only on the 64 diagonal texels. Without
that control the test would pass against a broken implementation, which is exactly how this
bug survives.

One thing that needed no conversion at all: an `ImageData` buffer viewed as a `Uint32Array`
already uses the same byte order as the framebuffer, so a decoded texel is a valid
framebuffer pixel as-is.

### Alpha

| source alpha | stored |
| --- | --- |
| 0 | exactly `TRANSPARENT`, **with RGB discarded** |
| 255 | opaque texel |
| 1–254 | straight alpha preserved |

Discarding the colour under fully transparent pixels is what keeps Stage 10's fast path
valid. The sprite loop skips on `texel === TRANSPARENT` — a single integer comparison — and
PNG exporters routinely leave stale colour beneath transparent areas, which would defeat it.

`getImageData` returns straight, un-premultiplied alpha, which is exactly what `blend()`
wants. Nothing to undo.

---

## Sprite alpha blending

The inner loop now has three cases, cheapest first:

```ts
if (texel === TRANSPARENT) continue;                        // one compare, the common case
const alpha = alphaOf(texel);                               // BEFORE shading
const lit = shade(texel, brightness);
pixels[index] = alpha === 255 ? lit : blend(pixels[index], lit, alpha + (alpha >> 7));
```

Only genuinely partial pixels — the anti-aliased rim, a few percent of a sprite — pay for a
destination read and a blend.

Two details that are easy to get wrong and are asserted directly:

**Alpha must be read before shading.** `shade()` forces its result opaque, so asking
afterwards always answers 255 and every partial pixel renders solid. The check asserts the
two orderings *differ*, so it would actually fail rather than passing either way.

**`alpha + (alpha >> 7)` maps 0–255 onto blend's 0–256.** Passing alpha straight through
stops one step short of opaque, so every "solid" sprite pixel would leak a 256th of the
background forever. The check asserts the naive version really would fail.

---

## The bug real artwork found

**Every wall in the level had been mirrored since Stage 6.**

The `wallX` flip condition was exactly inverted. Symmetric brick and noise look identical
mirrored, so nothing caught it for six stages — and Stage 6's own document had said, without
knowing it was describing a live bug:

> On a symmetric brick pattern you would never notice; on anything with writing, a handle,
> or a recognisable motif it is immediately wrong.

The moment a texture carried lettering, the walls read `EJJAW` instead of `WALL3`.

Working through one case: facing east, the camera plane points south, so screen-right
corresponds to increasing `y` — and `frac(hitY)` therefore already rises left-to-right across
the face. Flipping it is what breaks it. The other three orientations work out the same way,
so both comparisons invert:

```ts
if ((side === 0 && rayDirX < 0) || (side === 1 && rayDirY > 0)) wallX = 1 - wallX;
```

**Door slabs had the same latent bug**, with no flip at all, so a door read correctly from
one side and backwards from the other.

Neither was measured by eye. A "ruler" texture — each column a distinct colour — makes the
texture coordinate a screen column sampled recoverable from the rendered image. All four wall
orientations read falling before and rising after; both door orientations likewise, from both
sides. Those measurements are now permanent checks in
[`tools/verify/node/renderer.ts`](../tools/verify/node/renderer.ts).

Stages 6–11 are immutable tags and keep the old behaviour. Only `main` is fixed.

---

## The first await

`startLoop` used to run at module evaluation. It now sits inside a bootstrap:

```ts
overlay.textContent = 'loading textures…';
try {
  textures = await loadTextures();
} catch (error) { /* fatal, on screen, naming the file */ }
startLoop({ ... });
```

All thirteen images load concurrently. **The render path is untouched** — still synchronous,
still allocation-free. The asynchrony is confined to one function that runs once.

A failure is fatal and says so. Carrying on with missing textures produces a black or garbled
world and buries the cause. Dropping in a 32×32 image gives:

> Could not start: wall-2.png: expected a 64x64 image, got 32x32. All textures share one
> size, set by TEX_SIZE in src/config.ts.
>
> Textures are listed in src/assets/manifest.ts and must be 64x64 PNGs in
> src/assets/images/.

---

## A seam warning that can actually fire

Development builds compare each tiling texture's wrap against its own internal detail.
Comparing the two edges to each other is the wrong question — a diagonal pattern makes them
legitimately different and still tiles perfectly. What matters is whether the join is *worse
than a step the texture already contains*.

A warning rather than an error, since seamlessness is a judgement call. And the check is
itself verified: a horizontal gradient is flagged, period-16 stripes are not. "No warnings
from the real textures" would mean nothing if the check were dead code.

---

## Cost

| | Stage 11 | Stage 12 |
| --- | --- | --- |
| full frame, no AA | 0.182 ms | 0.157 ms |
| full frame, edge AA | 0.191 ms | 0.166 ms |
| heap growth, 300 frames | 0 KB | 0 KB |

Slightly *faster*, which is not a real improvement — the placeholder art is flatter than the
generated textures were, and flat data compresses better in cache. The honest reading is
that nothing measurable was lost, and the sprite loop's extra branch costs nothing at these
sprite counts.

Startup is now ~665 ms from navigation to first frame in development, most of it Vite
serving modules; the thirteen textures decode in about 16 ms.

---

## Running it

```bash
npm run dev
npm run verify -- --all      # the checks, including the browser ones
node tools/make-placeholders.mjs   # regenerate the placeholder art
```

### Verify

1. **Wall labels read left to right** from every angle — `WALL1`, not `1LLAW`.
2. **Open a door and look at it from both sides.** The slab reads correctly either way.
3. **Sprite edges are soft**, blended against whatever is behind them, not a hard cutout.
4. **Stand where two cells of the same wall meet.** No seam.
5. **Replace a PNG with a wrong-sized one.** The page refuses to start and names the file.
6. **Replace one with your own 64×64 art.** It should just appear, no code change.
7. **Delete a file named in the manifest.** The *build* fails, not the page.
8. **Watch the fps.** Unchanged from Stage 11.

---

## What changed

```
+ src/assets/images/*.png        thirteen placeholders
+ src/assets/manifest.ts         slot -> ?url import, and which slots tile
+ src/assets/decode.ts           pixels -> Texture, TextureSet, seam warning
+ src/assets/loader.ts           fetch, decode, canvas readback
+ tools/make-placeholders.mjs    regenerates the placeholder art
~ src/engine/color.ts            rgba(), alphaOf()
~ src/render/sprites.ts          alpha blending
~ src/render/{walls,floors}.ts   take a TextureSet
~ src/render/raycast.ts          wallX and door slab orientation fixed
~ src/main.ts                    async boot, loading and error states
- src/assets/textures.ts         488 lines of generators
```

---

## Still deliberately missing

Animated and directional sprites (both a second manifest axis rather than a renderer
change), swappable texture packs, and mixed texture sizes — which would need the inner loops
to read `texture.size` instead of a constant, costing the masking trick that Stage 6 leans
on.
