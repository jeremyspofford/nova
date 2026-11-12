### Fixed
- A coding run's preview no longer fails to start, or shows a link to some other program, when
  something else on the computer takes its port first. The preview now binds a port the computer
  gives it as it starts, and Nova shows the link only once it has confirmed, from the system's own
  list of open sockets, that the port belongs to the preview it started. Preview commands get
  PORT=0, which most servers read as "any free port". This is on Linux; elsewhere the preview
  starts as before.
- A service the supervisor runs is no longer taken as healthy when another program answers on the
  port it was given: its health and contract checks count only an answer from the service's own
  processes (on Linux).
