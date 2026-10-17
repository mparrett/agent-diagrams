# Sidebar redesign

Status: phases 1–3 done 2026-10-17, with the tooltip and README pass. From
phase 5, the board settings (title, font, row gap, uniform width, direction,
through `POST /board`) and group and legend editing (`POST /group`,
`POST /legend`) are done. Undo and phase 4 (shortcuts) are deferred as of
2026-10-17; undo needs a rule for edits other writers make between a change
and its undo. Next candidate: inner-group layout from the group editor. One change from the plan: the status line is a pill at the
canvas's bottom left, not in the toolbar, so its changing length doesn't
make the toolbar jump.

Decisions at sign-off: overlays move to the canvas toolbar; Expand all merges
into Fit to view; the sidebar uses a sans UI font (Instrument Sans, already
bundled for diagrams) with monospace kept for values; Drag is renamed Select.
Tooltips and the README get a final pass once phases 1–3 land.

The editor's left sidebar grew one control at a time. This is the audit of what
is wrong with it and a phased plan to fix it. Each phase ships on its own and
leaves the editor working.

## Audit

### Grouping

1. **"Theme & export" is a catch-all.** It holds the theme, font size, two wire
   drawing toggles (Center connectors, Start markers), copy-to-clipboard and the
   PNG viewer.
2. **"View" mixes display and content.** Grid, Heat, Conn and Flow change only
   what you see; the flow picker beside them changes the board and is saved.
3. **Mode (Drag | Connect) sits fourth**, between View and layout, though it is
   the control changed most often.
4. **Routing settings are in three places:** Heat in View, the wire toggles
   under Theme, Routing parameters collapsed at the bottom. The heat legend sits
   in the footer and shows even with Heat off.
5. **Board settings are scattered or missing.** Flow is the only one in the
   sidebar; title, direction, row gap and uniform width are CLI-only.

### Naming

6. **"Expand" means three things:** Spread → Expand moves boxes apart, Canvas →
   Expand adds 60px of margin, Expand all stretches the frame to the view.
7. **"Zoom to extents" doesn't zoom.** It resizes the frame to the visible area;
   the HUD's "fit" is what zooms.
8. **Align H / V reads backwards.** H lines boxes up into a column.
9. **Vague labels.** "Copy to Clipboard" doesn't say it copies the layout JSON;
   "Conn" is abbreviated; the picker's empty choice reads "flow: none".
10. **Inconsistent labels.** "Auto Layout" / "Place along flow" / "Shrink to
    content" vary in casing, and "Auto Layout (keep pins)" wraps to two lines.

### Visual

11. **No hierarchy.** Nearly every control is the same full-width outlined
    button: "+ Node" looks like "Expand all", and the destructive Auto Layout
    looks like everything else.
12. **Native inputs break the dark theme.** The font-size box is white and the
    checkboxes are native; that row and the checkboxes use inline styles.
13. **Small, low-contrast text.** 10–12px monospace throughout; the grey labels
    (`#6e7681` on `#0b0e13`) fall below contrast guidelines at that size.
14. **Overflows a laptop-height window.** The status line, the only feedback for
    most actions, ends up below the fold.
15. **Overlay toggles barely show their state** (a faint blue tint).
16. **The brand takes the top spot.** "Diagram Tool" gets the prime space; the
    board's name is a small grey line.

### Behavior and feedback

17. **No loading or error state.** A slow server (33s to return a board's
    state, seen 2026-10-16) leaves a blank board, an empty board picker and an
    empty status line. Scrolling the canvas before the board loads throws
    (`render` reads `diagramState.startMarkers` while it is null).
18. **No undo, and no confirm on Auto Layout,** which clears every pin.
19. **Shortcuts are undiscoverable.** Delete, Shift+Backspace and Esc work but
    are never shown; modes and overlays have none.
20. **Right-click-only features.** Add note, pin/unpin and connector layout have
    no hint in the sidebar.
21. **No UI at all** for groups, title, legend or edge-style presets.

## Plan

### Phase 1: fix the two bugs (17, 18)

- Show "Loading <board>…" over the stage until the state arrives, and an error
  with a Retry button if the fetch fails. Guard `render()` until the state
  exists.
- Ask before Auto Layout clears pins: "Clear N pins and re-lay out the board?"
  A confirm is enough until undo exists (Phase 5).

### Phase 2: regroup and rename (1–10, 14, 16)

Same controls, new order and names. No new features, so this is the cheapest
way to make the sidebar readable.

| Group | Controls |
| --- | --- |
| Header | board name (large), board picker under it, collapse button |
| Tool | Select · Connect (segmented, at the top) |
| Add | Node · *Note: right-click the canvas* (hint text) |
| Layout | Auto layout · Re-flow unpinned · Lay out along flow · Spread − / + · Line up: Rows / Columns |
| Board | Flow field picker · Theme · Font size |
| Wires | Center connectors · Start markers · Routing parameters (collapsed) |
| Frame | Fit to content · Fit to view · Add margin |
| Export | Copy layout JSON · Open PNG viewer ↗ |

- **Overlays move to the canvas HUD** as small toggles (Grid, Heat, Ports,
  Flow) beside the zoom controls: they are view state, like zoom.
- **The heat legend appears only while Heat is on**, next to the overlay.
- **Status moves to the HUD** (or a bar under the stage), so it is always
  visible.
- **Renames:** Drag → Select; Conn → Ports; Spread Contract/Expand → − / +;
  Align H/V → Line up Rows/Columns; Auto Layout (keep pins) → Re-flow unpinned;
  Shrink to content → Fit to content; Zoom to extents → Fit to view; Expand
  (60px) → Add margin; Expand all → folded into Fit to view (both grow the
  frame to the view; Fit to view also shrinks it, so keep that one and confirm
  nothing relies on never-shrink); Copy to Clipboard → Copy layout JSON. Sentence
  case throughout.

### Phase 3: visual system (11–13, 15)

- **Three button weights:** primary (Add node, the active tool), default, and
  quiet (rare actions, text-only); destructive actions get the red treatment
  the node editor already uses.
- **Styled inputs:** dark number field, custom checkbox or switch, select
  styling shared with the popovers. Remove the inline styles.
- **Type and contrast:** a sans UI font at 12–13px with monospace kept for
  values and the HUD; label grey raised to meet contrast at that size.
- **Collapsible sections** with remembered state, so Wires and Export can stay
  closed.
- **Clear on/off states** for toggles (filled background, not only a tint).

### Phase 4: discoverability (19, 20)

- Shortcuts: V / C for Select / Connect, G / H / P / F for overlays, N for a new
  node; show them in tooltips and in a `?` cheat sheet.
- A one-line hint under Add for the right-click actions.

### Phase 5: missing features (18, 21)

- Undo/redo for layout and edit operations.
- A Board panel: title, direction, row gap, uniform width.
- Groups: create from the selection, rename, recolor; legend editing.

Phases 1–3 are the redesign proper. Phases 4–5 are follow-ons and can be
reordered against other work.
