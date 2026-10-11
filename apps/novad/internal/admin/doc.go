// Package admin is the standing admin path (S30b): on unix a sudoers drop-in
// naming a root-owned copy of the agent (admin_unix.go); on Windows an
// elevated scheduled task (\Nova\NovaAdmin) for the owner's own account,
// fed through a request directory only he, SYSTEM and Administrators can
// open (request.go, task.go: the pure parts; task_windows.go: the glue).
// The agent's user runs `sudo -n <copy> admin exec -- argv` on unix; on
// Windows it drops a request file, starts the task, and reads the result.
package admin
