### Fixed
- When Nova's server can't be reached, Home and the right column no longer say "Nothing in progress",
  "Only this device for now", "Nothing kept yet" or "No brief yet". Each part says it couldn't be
  loaded, with Try again, and while a part is still on its way it says it is loading.
- On a slow server, a page shows its title, its heading, where you are in the navigation and a
  loading line at once, instead of a blank column.
- Health no longer jumps down the page when its problems arrive on a slow connection.
- A conversation that can't be opened because the network is down now says so, with Try again,
  instead of loading forever. A conversation whose title isn't known yet is no longer called
  "Untitled".
