**Conchilla 0.3.1**: no more black bars with ultrawide hosts

- **Host:** the shared screen is now always captured at its real size and shape. Before, an ultrawide screen could get squeezed into a 16:9 frame with black bars baked in, so zooming couldn't remove them. Lowering the resolution now happens in the encoder, which keeps the exact shape.
- **Viewers: new "Cut bars"** (on by default). Black bars that are part of the picture (a letterboxed movie, a 16:9 game on an ultrawide screen) are detected and cut off, so **Fill / Zoom 100%** fills your screen with real picture. Press F7 to see what's being cut.
- Dark scenes aren't mistaken for bars: bars are only added after staying put for a few seconds, and are removed right away if picture shows up there.
