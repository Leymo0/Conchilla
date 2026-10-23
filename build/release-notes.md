**Conchilla 0.4.0**: sealed rooms 🔒

- **The room seals itself when you start streaming.** The host drops off the lobby server, so the room no longer exists for anyone else. Even someone with the real code gets "no room with that code", and nobody new can reach the host or see their IP. Everyone already inside stays connected.
- Everything keeps working while sealed: chat, changing quality or codec, stopping and starting the stream, friends going between lobby and watching. All of it now goes over the direct connection instead of the lobby server.
- **Someone dropped?** Press **🔓 Unseal** next to the room code. Their app reconnects by itself (or they rejoin with the same code), and the room seals again as soon as they're in, or after 3 minutes.
- You can also seal by hand with **🔒 Seal**, or turn off auto-sealing (tickbox in the People panel).
- Everyone sees a 🔒 sealed note in the lobby.

⚠ Everyone needs to update. Older versions can't watch a 0.4.0 host.
