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
 *   .  floor        # 1 2 3 4  wall variants        D  door        >  spawn, facing east
 */
export const LEVEL_1 = parseMap(`
########################
#......................#
#..2222...3333....b....#
#..2..2...3..3.........#
#..2g.D..l3..3....44...#
#..2222...3333....44...#
#..........c...........#
#....>........b........#
#......................#
#..111111.....b........#
#.......#....222222....#
#.......#....2.gg.2....#
#..333..#....D....2....#
#....3..#....2.bb.2....#
#....3..222222....2....#
#....3.....l......2....#
#....33333D33333333....#
#......................#
#....l..4444...4444..l.#
#.......4....c....4....#
#.......4....b....4....#
#.......44444444444....#
#.........c...c........#
########################
`);
