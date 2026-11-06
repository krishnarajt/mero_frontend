# mero (frontend)

Infinite whiteboards for pen and mouse, synced live. Plain TypeScript and
Canvas 2D on Vite, with no framework and a ~17 KB gzipped bundle. The backend
is in `mero`.

## Run locally

```bash
npm install
npm run dev        # http://localhost:1186, proxies /api and /ws to localhost:1184
```

Start the backend first (`python main.py` in `mero`).

## Deploy (Vercel)

- In the Vercel project, set `VITE_API_BASE_URL=https://mero_backend.krishnarajthadesar.in`. If it's unset, production builds default to that value anyway.
- Gitea repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Pushing to `main` deploys to production, and PRs get preview deploys.

## Using it

Tools are on the left edge: select, pen, highlighter, shapes, eraser, pan, then undo and redo. The bar at the top has the colours, a thickness slider (0.2–30 px for the pen, 4–60 px for the highlighter) and, for the highlighter, an opacity slider. By default thickness is measured at 100 % zoom and scales with the board, so the same pen draws twice as thick on screen at 200 %. The pin button beside the slider switches to thickness fixed on screen instead, so a 10 px pen always looks 10 px wide as you draw, at any zoom. The dot shows how thick the ink will look at the current zoom.

| Input                               | Does                                              |
| ----------------------------------- | ------------------------------------------------- |
| Pen / left mouse                    | Use the current tool                              |
| Pen eraser end / eraser button      | Erase                                             |
| One finger                          | Pan (or use the tool, if the finger toggle is on) |
| Two fingers                         | Pinch zoom and pan                                |
| Two-finger tap / three-finger tap   | Undo / redo                                       |
| Wheel / trackpad pinch              | Zoom                                              |
| Right or middle drag, Space+drag    | Pan                                               |
| `V` `P` `M` `S` `E` `H`             | Select, pen, highlighter, shapes, eraser, hand    |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | Undo, redo                                        |
| `0`, `+` / `-`                      | Zoom to 100 %, zoom in / out                      |

**Shapes:** rectangle, square, ellipse, circle, triangle or hexagon. Tap the shapes button again to choose a different one. Hold Shift to force equal width and height. Dragging upward flips the triangle.

**Select:**

- Tap a stroke to select it, Shift-tap to add one, or drag a box over empty space to select every stroke that lies entirely inside it.
- Drag inside the box to move the selection, drag a corner to scale it, or drag the round handle on top to rotate it. Rotation snaps to right angles, or to 15° steps with Shift held.
- With a selection, the colours and the thickness slider restyle it. The slider previews while you drag and records one undo step when you let go.
- The bar under the selection has Group (`Ctrl+G`), Ungroup (`Ctrl+Shift+G`), Duplicate (`Ctrl+D`) and Delete (`Del`). `Ctrl+A` selects everything and `Esc` clears the selection.
- **Groups:** tapping or dragging any stroke in a group selects and moves the whole group. Double-tap a stroke to select just that one. A box selects a group only if the whole group is inside it. Groups are saved with the board and shared live.

**Dark mode:** the sun/moon button switches it. Stroke colours are stored as drawn in light mode and only change on screen: black ink shows as white, and dark colours are lightened so they stay readable.

Fingers are ignored while the pen is near the screen, which handles palm rejection.

## How it stays fast

- The canvas uses `desynchronized: true` (low-latency mode). Pen samples come from `pointerrawupdate` plus `getCoalescedEvents()`, and each new piece of curve is drawn inside the input handler, so ink doesn't wait for the next frame.
- Finished strokes sit in an offscreen buffer, so a frame is one bitmap copy plus whatever is being drawn right now. Panning a heavy board shifts the buffer and renders only the strip that scrolled into view.
- Strokes being moved, scaled or rotated are drawn with a canvas transform. Their points are only rewritten, and sent to the server, when you let go.
- Points are sent once per frame over the websocket, in world coordinates rounded to about 0.1 screen px.

All of this is in [src/board/engine.ts](src/board/engine.ts).
