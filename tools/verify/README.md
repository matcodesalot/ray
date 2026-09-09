# Verification scripts

```bash
npm run verify              # the node checks
npm run verify -- --all     # plus the browser checks (needs `npm run dev` running)
```

Not a test framework — the project deliberately has none. These are plain scripts that
import the real engine modules, assert things about them, and exit non-zero when something
is wrong. `run.mjs` bundles the TypeScript ones with rolldown, which ships inside Vite, so
there is no extra dependency.

## Layout

```
lib/harness.ts        check/near helpers, the DOM stub, synthetic textures
node/decode.ts        image pixels -> Texture: transpose, alpha, size validation, seams
node/sprite-alpha.ts  sprite compositing maths
node/renderer.ts      cross-stage regressions: wallX, doors, sprites, orientation, whole frames
node/collision.ts     circle-vs-grid and circle-vs-entity: contacts, sliding, corners
node/sprites.ts       sheet slicing, direction selection, animation timing, the behaviour hook
browser/images.mjs    the PNGs decode and tile correctly; sheets divide into cells
browser/loader.mjs    fetch + decode + canvas readback, end to end
```

The node checks need no browser: `stubDocument()` supplies the handful of DOM calls
`Framebuffer` makes in its constructor, and nothing in the render path touches the DOM.

## What these are for

Every one of these exists because it caught something. Worth knowing, because it shapes how
to add more:

- **The transpose check** (`node/decode.ts`) carries a *negative control* — it asserts that
  a row-major read matches only on the diagonal. Without that, the test would pass against
  a broken implementation of any symmetric texture, which is precisely how that bug hides.
- **The orientation checks** (`node/renderer.ts`) exist because every wall in the level was
  mirrored from Stage 6 until Stage 12. Procedural brick and noise look identical mirrored;
  it took a texture with lettering to reveal it. They use a "ruler" texture where each
  column is a distinct colour, so the texture coordinate a screen column sampled can be
  read back out of the rendered image.
- **The alpha-ordering check** (`node/sprite-alpha.ts`) asserts that the two possible
  orderings *differ*, so it would actually fail if the code read alpha after shading.
- **The direction checks** (`node/sprites.ts`) assert that the *opposite* sign convention
  agrees on front and back and disagrees on both flanks. Front and back pass under either
  convention, so a check of those alone would be blind to a mirrored sheet — the same class
  of bug as the mirrored walls, in a new costume.

The pattern: assert what should have happened, not merely that something happened. Several
real bugs in this project — corners that silently stopped the player, sprites drawn at the
wrong place off-axis — passed every invariant that only asked "is the state still valid?".

A corollary worth remembering: when a new check fails, suspect the check first. The Stage 13
sweep reported all 180 approaches frozen because every one of them was aimed at the barrel's
dead centre, and the Stage 14 render check reported the renderer four cells out because it
placed every viewer on the wrong side of the monster. Both times the engine was right.

## Adding a check

Import from `../lib/harness`, call `stubDocument()` before anything that constructs a
`Framebuffer`, use `check`/`near`/`section`, and finish with `done()`. Drop the file in
`node/` and the runner will find it.

Use `defaultTextures()` or build your own with `textureSet()` rather than the real
artwork — these check the renderer, and should not start failing when the art changes.
