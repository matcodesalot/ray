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
 *   .  floor        # 1 2 3 4  wall variants        D  door        >  spawn, facing east
 */
export const LEVEL_1 = parseMap(`
########################
#......................#
#..2222...3333.........#
#..2..2...3..3.........#
#..2..D...3..3....44...#
#..2222...3333....44...#
#......................#
#....>.................#
#......................#
#..111111..............#
#.......#....222222....#
#.......#....2....2....#
#..333..#....D....2....#
#....3..#....2....2....#
#....3..222222....2....#
#....3............2....#
#....33333333333333....#
#......................#
#.......4444...4444....#
#.......4.........4....#
#.......4.........4....#
#.......44444444444....#
#......................#
########################
`);
