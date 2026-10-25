**Conchilla 0.5.4**: stay in the room in the background, and getting back in is easier

- **Android: you stay in the room when you switch to another app** or turn the screen off. While you're in a room there's an "In a Conchilla room" notification. New messages show up in it, and tapping it brings you back. The first time, Android asks if Conchilla may show notifications: allow it.
- A phone that freezes for a moment gets 30 seconds before the host drops it (was 15).

- **Lock joins only keeps out *new* people.** Anyone who was already in the room can come back after dropping, even while joins are locked. (The lock is off when a room opens, as before.)
- **Getting back in after you drop:** if the room is sealed when you tap Join, Conchilla keeps trying for 3 minutes ("ask the host to press 🔓 Unseal — still trying…") and lets you in as soon as the host unseals. You don't have to time it.
- **Host:** Unseal now checks the room really is back on the lobby server. It retries by itself and says **🔓 Open — waiting for them to come back** once it works. The room stays open for 5 minutes (was 3).

- **Android:** the lobby chat is now laid out like a chat app:
  - **⛶** puts the chat in full screen. *Chat only* opens straight into it.
  - The box you type in stays above the keyboard, so you can see what you're typing, and the newest messages stay in view.
  - **➤** send button; the keyboard stays open between messages.
  - **👥** shows who's in the room, and **▶ Watch** opens the stream when someone's live.
- Joiners no longer see the host's own notes (like "Room open — press Copy…") in their chat.

**Installing on Android:** tap **Check for updates** in the app, or download `Conchilla-0.5.1.apk` below.
