/**
 * Which parts of the renderer are switched on.
 *
 * These are teaching switches, not game settings — every one of them exists so a stage's
 * contribution can be turned off and looked at. They travel together as one object rather
 * than as a growing tail of boolean arguments, where `drawWalls(fb, hits, false, true,
 * true)` becomes impossible to read at the call site.
 */
export interface RenderOptions {
  /** Use straight-line distance instead of perpendicular, to demonstrate fisheye. */
  useEuclidean: boolean;
  /** Distance shading. */
  lighting: boolean;
  /** Textured walls, versus Stage 5's flat colours. */
  textured: boolean;
  /** Cast textured floors and ceilings, versus flat bands of colour. */
  castFloors: boolean;
  /** Draw billboard sprites. */
  sprites: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  useEuclidean: false,
  lighting: true,
  textured: true,
  castFloors: true,
  sprites: true,
};
