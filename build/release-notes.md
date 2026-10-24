**Conchilla 0.4.1**: smarter delay buffer

- **Auto is now an on/off toggle, on by default.** It keeps adjusting the buffer to your connection: up right away when it gets shaky, slowly back down when it calms. Turn it off to set the buffer yourself with the slider.
- **The watch controls tell you where stutter comes from** (only while they're showing; they hide while you watch):
  - *smooth*: nothing to fix
  - *shaky connection · smoothed*: your connection hiccups and the buffer is hiding it
  - *host's PC is stuttering*: the host's PC or game is skipping frames. A buffer can't fix that; the host can lower the frame rate or resolution, or cap the game's FPS.
- **The host gets a warning** when their PC or upload can't keep up (on the host screen and the F8 menu, never over the game).
- **F7 shows details**: hiccups per minute from your connection (with vs. without the buffer) and stutters per minute from the host's side.
- Stream info (F7) is now **hidden by default** for a cleaner picture.
