### Security
- Switching to local-only now takes effect at once, even for a request already under way: if your
  local model fails after you tighten the setting, the work waits on your devices instead of falling
  back to the cloud on the setting it started with. Every cloud call is checked against your setting
  at the moment it would be sent.
