### Changed
- Nova's status icon redraws its moving states 20 times a second rather than on every screen
  refresh, so scrolling a long conversation does far less work. The icon looks the same, a change
  of state still shows at once, and with reduced motion on it stays still as before.
