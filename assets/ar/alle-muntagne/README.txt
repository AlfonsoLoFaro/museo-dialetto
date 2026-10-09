AR files for "Alle muntagne" (in preparation)
==================================================

This poem is selected for the AR experience, but it is NOT ready yet: the
poem page shows "Esperienza AR in preparazione". No placeholder assets are
kept here on purpose.

Files expected in this folder (exact names):

  targets.mind  REQUIRED  The compiled image target of the printed page.
                          Same procedure as assets/ar/liberta/ (see
                          scripts/compile-target.mjs).

  figure.png    optional  Archival picture (PNG, ideally transparent), shown
                          faintly behind the floating words. About 1000 px wide.

Audio (optional): assets/audio/alle-muntagne.mp3
  then set "audio": "assets/audio/alle-muntagne.mp3" in data/poesie/alle-muntagne.json.

To switch the poem on, once the files exist:
  1. Create the AR page for the poem (copy poesia-liberta.html / ar-liberta.js
     and point them to assets/ar/alle-muntagne/).
  2. In data/poesie/alle-muntagne.json set:
         "arReady": true,
         "arPage": "<name of the AR page>.html"
     ("arEnabled": true, "arSlug" and "arFolder" are already set.)
  3. Run: npm run import:poesie   (rebuilds data/poesie/index.json)
