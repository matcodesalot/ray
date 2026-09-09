# Stage 16 — Audio

**Tag:** `stage-16-audio`
**Diff:** `git diff stage-15-pushwalls stage-16-audio`

Sound, and the seam that lets it exist without the world knowing about it. Doors slide,
secrets grind open, footsteps land where you are standing, and a dungeon drones underneath
it all — positioned in the stereo field by the same camera plane the renderer has been using
since stage 2.

---

## The world announces; it does not play sounds

The obvious way to add sound is to call the mixer when a door opens. That is also the way
that ends with `world/doors.ts` importing an audio module, and the dependency points exactly
the wrong way: **the world does not care whether anyone is listening.**

So there is a bus. The world emits; whoever is interested subscribes:

```ts
this.events.emit(WorldEvent.DoorOpening, door.cellX + 0.5, door.cellY + 0.5);
```

Audio is the first subscriber, and `src/audio/world-audio.ts` is the entire coupling between
the two halves — a table mapping events to sounds, and one `subscribe` call. A game will
want other subscribers: a HUD that flashes, a score, an enemy that hears you. None of them
require touching the code that emits.

### Why the payload is three numbers

```ts
emit(kind: WorldEvent, x: number, y: number)
```

Not `emit({ kind, x, y })`, because footsteps are emitted from inside the fixed timestep and
this project's claim is that a steady tick allocates *nothing*. An object literal per event
would be a few dozen bytes of garbage a second — harmless in itself, and it would quietly
make the claim false. Every engine event is "something happened, over there", so a position
is the whole payload. `docs/extending.md` is where widening it gets discussed.

---

## The two functions with maths in them

Almost all of an audio layer can only be exercised in a browser, which makes it exactly the
kind of code that goes untested and then turns out to have left and right swapped. So the
decisions live in pure functions, in `src/audio/positional.ts`, and node asserts them
directly.

**Attenuation** is two curves multiplied, because neither does the job alone:

```
  1 ┤─────╮
    │      ╰──╌╌╌╌╌╌╮          inverse distance past a reference radius,
  0 ┤                ╰────     times a linear fade over the last few units
    └─────┬─────────┬┬─────
         ref     fade max
```

Inverse distance is how sound behaves and is what gives a room a sense of size, but it never
reaches zero, so every emitter in the level would go on contributing forever. A linear fade
alone sounds wrong — a source at half range would still be at half volume — but it takes the
tail to exactly zero, gradually. A hard cutoff clicks. Inside the reference radius it is flat
at 1, which is what stops a sound at your own feet being infinitely loud.

The guard is written `if (!(distance < AUDIO_MAX_DISTANCE)) return 0;` — negated, so that
`NaN` falls through to silence rather than to full volume. Stage 5 shipped precisely that bug
in the shading table, where `Infinity * 8 | 0` came out as 0 and the most distant walls
rendered at full brightness.

**Panning** is a dot product with the camera plane, and no trigonometry at all:

```ts
const rightward = (deltaX * planeX + deltaY * planeY) / planeLength;
return clamp(rightward / (distance + AUDIO_PAN_SOFTENING), -1, 1);
```

The plane has been the player's *right* vector since stage 2 — that is what makes
screen-right correspond to increasing plane offset — so the stereo balance is already
available without computing an angle.

Dividing by distance alone would normalise the vector, so a source a centimetre to your
right would pan hard right: technically correct, horrible to listen to, because a sound at
your feet swings between the speakers as you turn. The softening term means a source one
softening-distance to the side is panned halfway.

**A source directly behind you is centred**, exactly like one directly ahead. That is a real
limitation rather than a bug: stereo carries one axis, and front-versus-back is a difference
of delay and filtering that two speakers cannot express without head-related transfer
functions. WebAudio's `PannerNode` will do that; it costs far more than the flat, cheap thing
the rest of this renderer is built from.

---

## The sign is the whole thing, again

Which side is right is a *convention*, and getting it backwards is inaudible in a screenshot
and completely wrong in play. That is the same shape of bug as the mirrored wall textures
(six stages) and the flipped sprite rotations, so it gets the same treatment: derived from a
known geometry, then asserted with a negative control.

Facing east, the plane points south. So a source to the south is on your right — and
`node/audio.ts` asserts that the *opposite* sign convention agrees straight ahead and
straight behind while disagreeing on both sides, which is the only place the difference can
show. It also asserts that using the facing vector instead of the plane — a plausible
mistake — would centre everything that ought to be off to one side.

Then the browser suite renders the whole graph offline and measures the two channels:

```
PASS  a source to the south is heard on the right (R/L 94.6)
PASS  a source to the north is heard on the left (L/R 94.6)
```

Pure function and wiring, checked separately.

---

## The graph

```
 one-shot ──► gain (distance) ──► panner ──► sfx bus ──┐
                                                        ├──► master ──► speakers
 ambience ─────────────────────────────────► music bus ─┘
```

Two buses because the two kinds of sound want independent control — a player who turns the
music off has not asked to stop hearing doors. The per-shot gain and panner are built fresh
each time because an `AudioBufferSourceNode` is single-use by specification: you cannot
restart one, and the browser collects the little chain when it finishes.

Muting sets the master gain to zero rather than suspending the context, so the ambience keeps
its place in the loop and unmuting does not restart the bed from the beginning.

Sounds beyond the maximum distance are dropped rather than played at zero volume. A silent
source still occupies a voice, and a game with a hundred distant emitters would spend its
entire budget on things nobody can hear.

---

## Loading, and two deliberate differences from textures

The pipeline is the same on purpose: `?url` imports so a missing file is a **build failure**
with a name on it, one async phase, and errors that say which file and what was wrong with
it. Two things differ, and both are choices rather than oversights:

**Sound does not block the first frame.** Textures do, because there is nothing to draw
without them. Nobody can miss sound for the second it takes to fetch and decode a megabyte
of ambience, and blocking on it would mean staring at a loading message for something
optional.

**Sound failing is not fatal.** A world with no textures is a black screen and a bug report;
a world with no sound is a world with no sound. The loader's decode error names the file and
the likely cause — Ogg Vorbis works everywhere except older Safari — and the game carries on
silently.

Two things happen at load time rather than per playback, because both are constant per
sound:

- **The manifest's gain is baked into the samples.** The stone door peaks at 0.15 in the
  source file while the metal door peaks at 0.93, about 16 dB apart. Correcting it here keeps
  the original files exactly as downloaded, which makes for a much simpler provenance note
  in [CREDITS.md](../CREDITS.md).
- **Effects are folded to mono.** A stereo source fights the panner: the file already has its
  own left/right image, and panning it produces a muddle rather than a position. Ambience
  stays stereo, because it has no position to have.

The fold is an average rather than a sum, so a file whose channels are identical keeps its
level instead of clipping.

---

## Autoplay, and the gesture that starts everything

Browsers create an `AudioContext` suspended and refuse to start one except from a user
gesture. Decoding works fine while suspended, so everything is loaded up front and the first
click or key press resumes the context and starts the ambience:

```ts
window.addEventListener('pointerdown', wake, { once: true });
window.addEventListener('keydown', wake, { once: true });
```

`{ once: true }` on both — whichever gesture comes first wins and neither fires again. It is
usually the click that captures the mouse.

---

## Footsteps come from distance, not from time

```ts
if (stride.moved(player.x - wasX, player.y - wasY)) {
  map.events.emit(WorldEvent.Footstep, player.x, player.y);
}
```

Both easier options are wrong in the same visible way. Keying off the movement keys means
walking into a wall taps out steps forever while you stand pressed against it; a timer does
the same. Distance covered is the honest measure, and it makes running produce faster steps
for free rather than needing a second cadence kept in sync with the first. The remainder
carries across strides, so a long move does not lose the fraction it overshot by — the same
rule `advanceAnimation` follows.

---

## Cost

| pass | time |
| --- | --- |
| world update (entities, doors, pushwalls, events) | 0.001 ms |
| **full frame** | **0.158 ms** |

Unchanged, and retained heap growth is still 0 KB over 300 frames — with the event bus in
the loop and the attenuation and panning maths running on every event. Emitting costs under
a byte per event, which is a measurement rather than an assertion: `node/audio.ts` emits
200,000 times and weighs the heap.

The cost that is *not* on this table is the three WebAudio nodes each sound creates. Those
are on the browser's audio thread, they happen a few times a second at most, and they are
what the platform requires — there is no way to replay a buffer source.

---

## Verification

`node/audio.ts` — 37 checks with no WebAudio involved:

- **Attenuation**: full at the listener, exactly zero at and beyond the cutoff, never louder
  with distance across a fine sweep, no step discontinuity, `NaN` and `Infinity` silent
  rather than deafening — and a check that it actually *varies* in between, since a function
  returning zero everywhere would pass most of the rest.
- **Panning**: which side is right, from a known geometry, with the two negative controls
  above; centred ahead and behind; bounded; softened in the near field.
- **The bus**: listeners called in order, unsubscribing removing exactly one, emitting into
  an empty bus being harmless, and the allocation measurement.
- **The world announcing**: opening a door emits once at the cell centre and leaning on the
  key does not re-emit; closing emits; pushing a secret emits at the start and again where it
  arrives.
- **Footsteps**: ten strides give ten steps, a wall gives none, running gives more than
  walking, and one long move lands where many short ones do.

`browser/audio.mjs` adds what only a browser can answer: every manifest sound fetches and
decodes, effects come out mono and ambience stereo, the gain is baked in without clipping,
and the offline render of the whole graph puts the sound in the correct ear.

---

## What is left

The engine is done. Stage 17 is the seams — the places a game attaches, and a document
explaining them.
