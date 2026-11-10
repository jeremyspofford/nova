### Changed
- A failed task, a scheduled one included, now shows as amber "needs you", not red: red means Nova
  itself is stopped. The status mark, the Health badge, Home's first line and health card, and
  Health now always say the same thing, and say it in words: "Nova is stopped" or how many things
  need you. Problems already open from failed tasks turn amber too.
- Stopped and needs-you no longer differ by colour alone: stopped carries a small stop sign on the
  status mark and the Health badge, and the badge's spoken name says how serious it is.

### Fixed
- When Nova couldn't load its list of problems, tasks or rules, it no longer says nothing needs you,
  "No problems are open", "No tasks yet" or "No rules yet": it says the list couldn't be loaded, with
  Try again for that list alone.
- Health checks that can't be loaded now say so with Try again instead of "Checking" forever;
  Skills, Schedules and Activity show a waiting line at once and give up with Try again; About,
  What's new and Where Nova stands have Try again; Health and Automations no longer flash their empty
  words before their lists arrive.
- A conversation that doesn't exist now says so, instead of claiming Nova's server isn't answering,
  and an address Nova doesn't have shows a page with a way back Home.
