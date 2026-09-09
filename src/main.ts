import {
  DISPLAY_ASPECT,
  DOOR_REACH,
  MOVE_SPEED,
  PLAYER_RADIUS,
  RUN_MULTIPLIER,
  TURN_SPEED,
  VIEW_H,
  VIEW_W,
} from './config';
import { loadTextures } from './assets/loader';
import { animationTiming } from './assets/decode';
import { Stride } from './audio/footsteps';
import { loadSounds } from './audio/loader';
import { Sound } from './audio/manifest';
import { Mixer } from './audio/mixer';
import { connectAudio } from './audio/world-audio';
import { WorldEvent } from './core/events';
import type { TextureSet } from './assets/decode';
import { FpsCounter, startLoop } from './core/loop';
import { Framebuffer } from './engine/framebuffer';
import { Keyboard } from './input/keys';
import { Mouse } from './input/mouse';
import { SCHEMES, otherScheme, type SchemeName } from './input/scheme';
import { Player } from './player';
import { drawDepthProfile } from './render/depthprofile';
import { drawFloorAndCeiling } from './render/floors';
import {
  drawMap,
  drawPlayer,
  drawRays,
  drawSprites,
  layoutMinimap,
  type Rect,
} from './render/minimap';
import { DEFAULT_RENDER_OPTIONS } from './render/options';
import { OverlayStack } from './render/overlay';
import { RayFan } from './render/raycast';
import { SpriteRenderer } from './render/sprites';
import { antialiasWallEdges, createWallSpans, drawWalls, type WallSpans } from './render/walls';
import { attachDemoBehaviours } from './world/demo-patrol';
import { SpriteKind, updateEntities } from './world/entities';
import { LEVEL_1 } from './world/levels/level1';

/** Look up a required element, failing loudly rather than propagating a null. */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`index.html is missing ${selector}`);
  return element;
}

/**
 * Acquire the drawing context, failing loudly rather than propagating a null.
 *
 * A function rather than an inline check for the same reason `requireElement` is one: the
 * render loop now lives inside a hoisted function, and TypeScript will not carry a
 * narrowing from module scope into a function that could — as far as it knows — have been
 * called earlier. Returning a non-nullable type settles it at the boundary instead.
 */
function require2dContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not acquire a 2D context for the screen');
  return context;
}

const canvas = requireElement<HTMLCanvasElement>('#screen');
const overlay = requireElement<HTMLPreElement>('#overlay');
const ctx = require2dContext(canvas);

// ---------------------------------------------------------------------------------------
// World and input
// ---------------------------------------------------------------------------------------

const map = LEVEL_1;
const player = Player.atSpawn(map);

const keys = new Keyboard();
const mouse = new Mouse(canvas);

let schemeName: SchemeName = 'modern';
mouse.enabled = SCHEMES[schemeName].usesMouseLook;

function setScheme(name: SchemeName): void {
  schemeName = name;
  mouse.enabled = SCHEMES[name].usesMouseLook;
  if (!SCHEMES[name].usesMouseLook) mouse.release();
}

// ---------------------------------------------------------------------------------------
// Render state
// ---------------------------------------------------------------------------------------

/** Renderer switches, all of them teaching aids rather than settings. */
const render = { ...DEFAULT_RENDER_OPTIONS };

/**
 * How the world is presented.
 *
 * The top-down view has been here since Stage 2 because it is the only place you can see
 * where the rays actually go. It now also has a corner form, which is the shape it would
 * take in an actual game.
 */
type ViewMode = 'first-person' | 'minimap' | 'top-down';
const VIEW_MODES: readonly ViewMode[] = ['first-person', 'minimap', 'top-down'];
let viewModeIndex = 0;
const viewMode = (): ViewMode => VIEW_MODES[viewModeIndex]!;

let noclip = false;
let showHelp = false;

/** How many columns to skip when drawing the fan: 320 lines at once is an opaque wedge. */
const RAY_STRIDES = [8, 4, 2, 1, 32, 16];
let strideIndex = 0;

/**
 * Internal resolution, as a multiple of the 320x200 base.
 *
 * Changing it reallocates everything sized off the framebuffer, which is why those are
 * `let`. Worth having as a switch: dropping to 0.5 makes the pixel steps that edge
 * anti-aliasing addresses impossible to miss, and 2 shows how much of the retro look is
 * resolution rather than technique.
 */
const RESOLUTION_SCALES = [1, 0.5, 2];
let scaleIndex = 0;

let framebuffer!: Framebuffer;
let fan!: RayFan;
let spans!: WallSpans;
let spriteRenderer!: SpriteRenderer;
let mapBounds!: Rect;
let profileBounds!: Rect;
let cornerBounds!: Rect;

/** Set on resize so the letterbox bars get repainted once rather than every frame. */
let needsClear = true;

function setResolution(scale: number): void {
  const width = Math.round(VIEW_W * scale);
  const height = Math.round(VIEW_H * scale);

  framebuffer = new Framebuffer(width, height);
  fan = new RayFan(width);
  spans = createWallSpans(width);
  spriteRenderer = new SpriteRenderer(map.sprites.length);

  const profileHeight = Math.round(height * 0.26);
  mapBounds = { x: 0, y: 0, w: width, h: height - profileHeight };
  profileBounds = { x: 0, y: height - profileHeight, w: width, h: profileHeight };

  // Corner minimap: a square in the top right.
  const corner = Math.round(height * 0.34);
  cornerBounds = { x: width - corner - 4, y: 4, w: corner, h: corner };

  needsClear = true;
}

setResolution(RESOLUTION_SCALES[scaleIndex]!);

// ---------------------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------------------

/**
 * Whether the player's body overlaps a cell.
 *
 * Doors consult this before closing. Testing the player's *circle* against the cell rather
 * than just which cell their centre is in matters: standing in a doorway with your centre
 * barely over the line into the next cell would otherwise let the door shut through you.
 */
function playerOccupies(cellX: number, cellY: number): boolean {
  const nearestX = Math.min(Math.max(player.x, cellX), cellX + 1);
  const nearestY = Math.min(Math.max(player.y, cellY), cellY + 1);
  const dx = player.x - nearestX;
  const dy = player.y - nearestY;
  return dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS;
}

/**
 * Use whatever is in front of the player: open a door, or shove a secret wall.
 *
 * One key for both, as in the original, and for a good reason — a pushwall is meant to be
 * indistinguishable from a wall, so there can be no separate "push" control to reach for.
 * You find secrets by trying the use key on walls that look promising.
 *
 * A pushwall slides along one axis, so the push direction is the player's facing rounded to
 * a cardinal. Rounding rather than using the raw direction keeps a wall from creeping off
 * diagonally when you lean on it at an angle.
 */
function useInFront(): void {
  const cardinalX = Math.abs(player.dirX) >= Math.abs(player.dirY) ? Math.sign(player.dirX) : 0;
  const cardinalY = cardinalX === 0 ? Math.sign(player.dirY) : 0;

  for (const reach of [0, DOOR_REACH * 0.5, DOOR_REACH]) {
    const cellX = Math.floor(player.x + player.dirX * reach);
    const cellY = Math.floor(player.y + player.dirY * reach);
    if (map.doors.activate(cellX, cellY)) return;
    if (map.push(cellX, cellY, cardinalX, cardinalY)) return;
  }
}

// ---------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------

/** Where the upscaled image sits inside the canvas, in device pixels. */
let viewport = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

/**
 * Size the canvas's pixel grid to real device pixels, then fit the largest DISPLAY_ASPECT
 * rectangle inside it, centred. See Stage 1 for why the two sizes are not the same thing.
 */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const pixelW = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const pixelH = Math.max(1, Math.round(canvas.clientHeight * dpr));

  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  let w = pixelW;
  let h = pixelW / DISPLAY_ASPECT;
  if (h > pixelH) {
    h = pixelH;
    w = pixelH * DISPLAY_ASPECT;
  }

  viewport = {
    x: Math.round((pixelW - w) / 2),
    y: Math.round((pixelH - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };

  needsClear = true;
}

window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------------------

const fps = new FpsCounter();

/**
 * The overlay is rebuilt a few times a second rather than every frame.
 *
 * Building this string allocates — template literals, number formatting, concatenation —
 * and it was the last remaining source of garbage in the loop now that every render pass
 * writes into preallocated buffers. At 8Hz it still reads as live and the render path
 * allocates nothing at all.
 */
const OVERLAY_INTERVAL = 0.125;
let overlaySince = OVERLAY_INTERVAL;

const HELP = [
  'CONTROLS',
  '  Space     open a door, or push a wall that gives',
  '  V         mute sound',
  '  `         switch control scheme',
  '  H         close this help',
  '',
  'VIEW',
  '  M         first-person / minimap / top-down',
  '  R         ray density (top-down only)',
  '  [ ]       field of view',
  '  - =       internal resolution',
  '',
  'RENDERER  (each stage of the walkthrough, switchable)',
  '  T         wall textures            (stage 6)',
  '  L         distance shading         (stage 5)',
  '  C         floor/ceiling casting    (stage 7)',
  '  P         sprites                  (stage 10)',
  '  X         edge anti-aliasing       (stage 11)',
  '  F         euclidean distance -> fisheye  (stage 3)',
  '',
  'MOVEMENT',
  '  N         noclip',
].join('\n');

function buildOverlay(): string {
  const scheme = SCHEMES[schemeName];

  if (showHelp) return `${HELP}\n  ${scheme.help}`;

  const heading = ((Math.atan2(player.dirY, player.dirX) * 180) / Math.PI + 360) % 360;
  const fov = ((2 * Math.atan(player.planeLength) * 180) / Math.PI).toFixed(0);

  return (
    `${fps.value.toFixed(0)} fps   ${framebuffer.width}x${framebuffer.height}   fov ${fov}°\n` +
    `pos ${player.x.toFixed(2)}, ${player.y.toFixed(2)}   heading ${heading.toFixed(0)}°\n` +
    `view ${viewMode()}` +
    (render.edgeAntialiasing ? '   edge-AA' : '') +
    (noclip ? '   NOCLIP' : '') +
    (render.useEuclidean ? '   FISHEYE' : '') +
    (render.lighting ? '' : '   unlit') +
    (render.textured ? '' : '   untextured') +
    (render.castFloors ? '' : '   flat-floors') +
    (render.sprites ? '' : '   no-sprites') +
    '\n\nH for help' +
    (scheme.usesMouseLook && !mouse.isLocked ? ' · click to capture the mouse' : '')
  );
}

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------

/**
 * The textures, once they have loaded.
 *
 * Assigned exactly once, before the loop starts. The definite-assignment `!` is honest
 * here: nothing can read it earlier, because `startLoop` is not called until the await
 * below has resolved.
 */
let textures!: TextureSet;

/**
 * Reused between ticks, like everything else on the hot path.
 *
 * A fresh context object each tick would be a few dozen bytes sixty times a second — not a
 * problem in itself, but the project's claim is that a steady frame allocates nothing at
 * all, and that claim is only worth making if it stays true.
 */
const behaviourContext = { map, player, seconds: 0 };

/**
 * Passes that draw over the finished world: a HUD, a weapon, a damage flash.
 *
 * Empty, because this is an engine and not a game. It exists so there is one obvious place
 * to attach those things, and so that place is *after* the world and *before* the frame is
 * presented — see docs/extending.md.
 */
const overlays = new OverlayStack();

/**
 * The mixer, once the sounds have loaded. Undefined if they could not be.
 *
 * Unlike textures, audio failing is **not** fatal. A world with no textures is a black
 * screen and a bug report; a world with no sound is a world with no sound, and refusing to
 * start over it would be a worse outcome than playing silently.
 */
let mixer: Mixer | undefined;

/** Counts out footsteps by distance covered. */
const stride = new Stride();

/** Where entity animation timings come from. Hoisted so it is not a fresh closure per tick. */
const entityTiming = (kind: number, animation: string) => animationTiming(textures, kind, animation);

/**
 * Bring up sound, and arrange for it to actually start playing.
 *
 * Browsers create an `AudioContext` suspended and will not start one except from a user
 * gesture — an autoplay rule, and a reasonable one. So the context is built and everything
 * is decoded into it up front, which works fine while suspended, and the first click or key
 * press resumes it and starts the ambience.
 *
 * `{ once: true }` on both listeners: whichever gesture comes first wins and neither fires
 * again. It is usually the click that captures the mouse.
 */
async function startAudio(): Promise<void> {
  try {
    const context = new AudioContext();
    mixer = new Mixer(context, await loadSounds(context));
  } catch (error) {
    console.warn('Sound is unavailable, carrying on without it:', error);
    return;
  }

  const wake = (): void => {
    mixer?.resume();
    if (mixer && !mixer.musicPlaying) mixer.playMusic(Sound.Ambience);
  };

  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });

  connectAudio(map.events, mixer, player);
}

/**
 * Load the artwork, then start the engine.
 *
 * This is where the project's asynchronous code lives. Every texture used to be arithmetic
 * evaluated at module load; images and sounds have to be fetched and decoded, and both are
 * unavoidably async. Confining it to a single await before the first frame keeps that fact
 * out of the render path, which stays exactly as synchronous — and as allocation-free — as
 * it was in Stage 11.
 *
 * A texture failure here is fatal and says so: carrying on with missing artwork produces a
 * black or garbled world and buries the actual cause. **Sound is different** — it neither
 * blocks the first frame nor stops the game if it fails.
 */
async function boot(): Promise<void> {
  overlay.textContent = 'loading textures…';

  try {
    textures = await loadTextures();
    // Demo only. Removing this line, and the file it comes from, leaves the engine intact
    // and the monsters standing still. See src/world/demo-patrol.ts.
    attachDemoBehaviours(map, SpriteKind.Monster);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    overlay.textContent =
      `Could not start: ${message}\n\n` +
      `Textures are listed in src/assets/manifest.ts and must be ` +
      `${VIEW_W === 320 ? '64x64' : 'TEX_SIZE-square'} PNGs in src/assets/images/.`;
    console.error(error);
    return;
  }

  /**
   * Sound is started but **not waited for**.
   *
   * Textures block the first frame because there is nothing to draw without them. Sound
   * cannot be missed for the second and a half it takes to fetch and decode a megabyte of
   * ambience, and blocking on it would mean staring at a loading message for something
   * optional. It connects itself when it is ready; events emitted before then are simply
   * not heard by anyone.
   */
  void startAudio();

  startLoop({
  update(dt) {
    if (keys.wasPressed('Backquote')) setScheme(otherScheme(schemeName));
    if (keys.wasPressed('KeyH')) showHelp = !showHelp;
    if (keys.wasPressed('KeyM')) viewModeIndex = (viewModeIndex + 1) % VIEW_MODES.length;
    if (keys.wasPressed('KeyR')) strideIndex = (strideIndex + 1) % RAY_STRIDES.length;
    if (keys.wasPressed('KeyF')) render.useEuclidean = !render.useEuclidean;
    if (keys.wasPressed('KeyL')) render.lighting = !render.lighting;
    if (keys.wasPressed('KeyT')) render.textured = !render.textured;
    if (keys.wasPressed('KeyC')) render.castFloors = !render.castFloors;
    if (keys.wasPressed('KeyP')) render.sprites = !render.sprites;
    if (keys.wasPressed('KeyV') && mixer) mixer.setMuted(!mixer.isMuted);
    if (keys.wasPressed('KeyX')) render.edgeAntialiasing = !render.edgeAntialiasing;
    if (keys.wasPressed('KeyN')) noclip = !noclip;

    if (keys.wasPressed('BracketLeft')) player.setPlaneLength(player.planeLength - 0.08);
    if (keys.wasPressed('BracketRight')) player.setPlaneLength(player.planeLength + 0.08);

    if (keys.wasPressed('Minus') || keys.wasPressed('Equal')) {
      scaleIndex = (scaleIndex + 1) % RESOLUTION_SCALES.length;
      setResolution(RESOLUTION_SCALES[scaleIndex]!);
    }

    const intent = SCHEMES[schemeName].poll(keys, mouse);

    // Turning has two sources with different units. `turn` is an axis, so it becomes a
    // rate — multiplied by dt, it turns at a steady speed for as long as the key is held.
    // `turnDelta` is already an angle: the mouse has *moved* that far, and scaling it by
    // dt would make sensitivity depend on frame rate.
    player.rotate(intent.turn * TURN_SPEED * dt + intent.turnDelta);

    // Normalise diagonals. Holding forward and strafe together gives a vector of length
    // sqrt(2), so without this you would move 41% faster diagonally than straight ahead.
    let { forward, strafe } = intent;
    const length = Math.hypot(forward, strafe);
    if (length > 1) {
      forward /= length;
      strafe /= length;
    }

    const speed = MOVE_SPEED * (intent.run ? RUN_MULTIPLIER : 1) * dt;

    const wasX = player.x;
    const wasY = player.y;
    player.move(forward * speed, strafe * speed, noclip ? undefined : map);

    if (stride.moved(player.x - wasX, player.y - wasY)) {
      map.events.emit(WorldEvent.Footstep, player.x, player.y);
    }

    if (intent.use) useInFront();

    // Doors advance after movement, so the occupancy test sees where the player actually
    // ended up this tick rather than where they were at the start of it.
    map.updateDoors(dt, playerOccupies);
    map.updatePushwalls(dt, playerOccupies);

    /**
     * Entities: behaviour, then animation, on the fixed timestep.
     *
     * In `update` rather than `render` on purpose. Animation driven off the render loop
     * runs at whatever rate the display happens to refresh at — a walk cycle would be
     * twice as fast on a 120 Hz monitor — which is the same reason door travel is here.
     */
    behaviourContext.seconds = dt;
    updateEntities(map.sprites, behaviourContext, entityTiming);

    overlaySince += dt;
    keys.endTick();
  },

  render() {
    fan.cast(map, player);

    if (viewMode() === 'top-down') {
      const layout = layoutMinimap(map, mapBounds);
      drawMap(framebuffer, map, layout, mapBounds);
      drawRays(framebuffer, player, fan.hits, layout, RAY_STRIDES[strideIndex]!);
      if (render.sprites) drawSprites(framebuffer, map.sprites, layout);
      drawPlayer(framebuffer, player, layout);
      drawDepthProfile(framebuffer, fan.hits, profileBounds, render.useEuclidean);
    } else {
      // Walls first, recording which pixels they cover, so the floor pass can skip them
      // rather than being painted over.
      drawWalls(framebuffer, fan.hits, spans, textures, render);
      drawFloorAndCeiling(framebuffer, player, spans, textures, render);

      // Sprites read the wall distances the ray fan already holds, and paint over whatever
      // the first two passes left.
      if (render.sprites) {
        spriteRenderer.draw(framebuffer, player, map.sprites, fan.hits, textures, render);
      }

      // Edge softening is last of the world passes: it blends wall edges against the
      // ceiling and floor, so both have to be painted already.
      if (render.edgeAntialiasing) {
        antialiasWallEdges(framebuffer, fan.hits, render);
      }

      if (viewMode() === 'minimap') {
        const layout = layoutMinimap(map, cornerBounds);
        drawMap(framebuffer, map, layout, cornerBounds);
        if (render.sprites) drawSprites(framebuffer, map.sprites, layout);
        drawPlayer(framebuffer, player, layout);
      }
    }

    // The game's own drawing: after everything with a position, before the frame goes out.
    overlays.draw(framebuffer, player, render);

    if (needsClear) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      needsClear = false;
    }

    framebuffer.present(ctx, viewport.x, viewport.y, viewport.w, viewport.h);

    fps.tick();
    if (overlaySince >= OVERLAY_INTERVAL) {
      overlaySince = 0;
      overlay.textContent = buildOverlay();
    }
  },
  });
}

void boot();
