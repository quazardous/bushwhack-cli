/**
 * bushwhack's mascot: an adventurer of the 80s' platform games, fedora and stubble, a
 * machete raised — 16×16 pixels, one letter a colour ('.' is transparent). The extension's
 * icons (extension/icons/gen-icons.ts) and the CLI's banner are both drawn from this grid.
 */
export const SPRITE: readonly string[] = [
  '....OOOOO.....MO',
  '...OHHHHHO...MmO',
  '...OhhhhhO..MmO.',
  '.OOHHHHHHHOOMmO.',
  'OHHHHHHHHHHOGO..',
  '.OOSSSSSSOO.GO..',
  '..OSESSESO.OSO..',
  '..OSSSSSSO.OSO..',
  '..OSSBBSSO.OKO..',
  '...OBSBSO..OKO..',
  '..OKKSSKKOOKKO..',
  '.OKKKKKKKKKKKO..',
  'OKKkKKKKKKKkKKO.',
  'OKKkKDDKKKKkKKO.',
  'OKKkKKKDDKKkKKO.',
  'OKKkKKKKKDDkKKO.',
];

export const PALETTE: Readonly<Record<string, string>> = {
  O: '#20140b', // outline
  H: '#7a4a24', // fedora
  h: '#3a2210', // its band
  S: '#f0c08a', // skin
  E: '#20140b', // eyes
  B: '#b07a4e', // stubble
  K: '#c9a55c', // khaki shirt
  k: '#9a7a38', // its shade
  D: '#5a3a1c', // strap
  M: '#e8edf2', // blade
  m: '#9aa4ae', // its edge
  G: '#4a2c14', // grip
};
