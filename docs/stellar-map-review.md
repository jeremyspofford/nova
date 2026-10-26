# Stellar Map: review note

The Stellar Map is your memory drawn as a star system, in the Nova theme only.
Open **Memory** and press **Map** at the top right. **List** takes you back to
the list, and Nova remembers which one you last used.

Everything on the map comes from the files in your Nova folder, and nothing
is stored separately. If you delete a file, its body disappears from the
map. If you forget a memory on the map, it is forgotten in the file, with the
same Undo the list has.

## What you're looking at

| On the map | Comes from | Example |
| --- | --- | --- |
| The bright core in the middle | Nova itself. Its moons are IDENTITY.md, SOUL.md and AGENTS.md | Always at the centre when the map opens |
| A ringed planet | You, from USER.md. The ring means pinned | "Sam Rivera · Planet · Person, you" |
| Planets | People, one file each in `memory/people/` | `memory/people/ana-rivera.md` |
| Gas giants | Enduring topics such as an employer, project or place, in `memory/topics/` | `memory/topics/northwind.md` |
| Stars, with diffraction spikes | Goals, from `workspace/goals/<goal>/GOAL.md` | "Remote platform role, $150k+" |
| Moons | Memories. Each one orbits the first person, topic or goal it names | "Leo uses a blue inhaler…" orbits Leo |
| Comets | Days from the last 30, from `memory/YYYY-MM-DD.md`. The tail shortens as the day ages | "Thu, Oct 22" |
| Asteroids at the edge | Older notes that name no one, shown as unconnected | "Paid the electric bill" |
| A coloured nebula with a small caps name | A group, from `memory/groups/`. Its members are the people its file names | FAMILY |
| Curved threads of light | One file naming another body, or two bodies named in the same note | Sam to Leo, from `leo-rivera.md` |

A memory in MEMORY.md that names no one counts as being about you, so it
orbits your planet. Size reflects how often something comes up: mentions,
threads, moons, and how recently it was touched. Click any body and the
inspector shows the numbers behind its size and why it sits where it does.

## Trying it

- **Drag** to pan. The far stars, the nebulae and the planets move at
  different speeds, so dragging shifts your viewpoint.
- **Scroll** or pinch to travel between three scales: Galaxy (the whole
  map), System (one planet and its moons) and Orbit (one body close up).
- **Hover** a body to light its threads and neighbours. The rest of the map
  dims.
- **Click** a body to open the inspector, which shows the source file, when
  it was learned, why it's there, its threads and its moons. For a moon you
  can read the memory, **Edit** it or **Forget** it there.
- **Double-click** a body, or press **Enter**, to dive in. Press **Esc** to
  back out one scale. **⌂** or **Home** flies you back to Nova.
- **⌘K** opens search. Type a name and the camera flies there.
- **Arrow keys** step along threads to linked bodies.

When it's idle the sky barely moves: a slow drift over about 2 minutes,
faint twinkling and very slow orbits. All of that pauses while you interact,
and it stops completely with reduced motion turned on, where flights also
become instant. The glass panels fade after about 3 seconds without the
mouse moving and come back when it moves.

## Screenshots (Nova theme, made-up data)

`nova-map-galaxy.png`, `nova-map-hover.png`, `nova-map-selected.png`,
`nova-map-system.png`, `nova-map-orbit.png`, `nova-map-moon.png`,
`nova-map-search.png`, `nova-map-reduced.png`, `nova-map-empty.png`,
`mobile-map.png`, `mobile-map-selected.png`. They're in `docs/screenshots/` and
in the project's `nova-previews/` folder. The people in them are invented,
because this repo is public.

## Decisions for you

1. **People, groups, topics and goals now have files**, laid out the way Muse
   does it: `memory/people/`, `memory/groups/`, `memory/topics/` and
   `workspace/goals/`. Before this, Nova only kept MEMORY.md and day notes, so
   on your real data the map will start out mostly as your planet and its
   moons. I told Nova (in its system prompt) to keep these files as people
   and goals come up, and let `write_file` write them. If you'd rather Nova
   didn't start creating them, say so and I'll take that out. The map still
   works without them.
2. **List | Map, not Files | Map | Split.** The spec puts the map next to the
   Files explorer, but the explorer hasn't been built yet. For now the map
   sits next to the Memory list, which is also the accessible version the spec
   asks for. When the explorer is built, the switch gets its three options
   and selection syncs both ways.
3. **Left out on purpose:** the timeline scrubber (the spec marks it
   optional), confirm/remove for "inferred" threads (Nova doesn't infer any
   threads yet; every thread comes from a file), and depth of field on
   foreground bodies.

## Checks

- `npm run check`: unit and API tests (including `tests/map.test.js`:
  rebuildable from files, deleting a file removes its body, names and links,
  salience, density stacking, the empty home, no overlapping bodies), token
  lint, theme contract.
- `node scripts/shots-map.js`: drives the real UI in Chromium and checks every
  interaction above, then saves the screenshots. Its results are in
  `docs/screenshots/map-results.json`.
- Performance: the build machine has no GPU, so WebGL runs on SwiftShader, a
  software renderer. There a frame takes seconds (the walkthrough logs about
  3.5 s), which says nothing about your mini-pc's GPU, but it does mean I
  couldn't measure real frame rates. Please open the map on the mini-pc and
  tell me if dragging feels sluggish; the next step would be a cheaper
  planet shader at Galaxy scale.
  When the map is idle it only redraws 15 times a second, because the drift
  is too slow to need more. If frames slip while you interact, drift and
  twinkle stop first and then the render resolution drops until you stop
  moving. Interaction itself never waits.
