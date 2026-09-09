import { parseMap } from '../map';

/**
 * The test level.
 *
 * It is shaped to exercise the renderer rather than to be fun: long sight-lines down the
 * open middle, tight corridors, freestanding pillar blocks, several wall variants next to
 * each other so texture changes are visible at the seams, and two door tiles. The narrow
 * gaps between the pillars in the top-left are the useful ones — thin slivers of wall seen
 * at a glancing angle are where off-by-one errors in the DDA show up first.
 *
 * The three doors are deliberately of both orientations: the two in the pillar rooms lie
 * along y (you walk through them heading east or west), and the one in the long southern
 * wall lies along x. A door only renders correctly if its axis is detected from the walls
 * holding its frame, so having one of each keeps that honest.
 *
 * The three monsters are the only entities that move. They exist to exercise the Stage 14
 * directional sprite path — you have to be able to walk round something to tell whether the
 * eight stored views are in the right order — and they are driven by demo code, not AI.
 *
 * The block on the right of the top room hides the level's one secret. From outside it is
 * four by three cells of solid Wall4; the west face of it has a pushwall in the middle, and
 * behind that a three-cell alcove that nothing else reaches. Walk up to it and press use.
 *
 *   .  floor        # 1 2 3 4  wall variants        D  door        >  spawn, facing east
 *   b g l c  scenery        m  monster        P  secret pushwall
 */
export const LEVEL_1 = parseMap(`
########################
#...........m..........#
#..2222...3333....b....#
#..2..2...3..3....4444.#
#..2g.D..l3..3....P..4.#
#..2222...3333....4444.#
#..........c...........#
#....>........b........#
#................m.....#
#..111111.....b........#
#.......#....222222....#
#.......#....2.gg.2....#
#..333..#....D....2....#
#....3..#....2.bb.2....#
#....3..222222....2....#
#....3.....l......2....#
#....33333D33333333....#
#...m..................#
#....l..4444...4444..l.#
#.......4....c....4....#
#.......4....b....4....#
#.......44444444444....#
#.........c...c........#
########################
`);
