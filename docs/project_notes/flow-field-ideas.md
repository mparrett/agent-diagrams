# Flow fields: ideas for the next spike

Builds on `flow-fields.md`.

- **Box fields.** Each box carries a short-range field pointing out of its
  sides (radially out at the corners), fading over a few cells and added to the
  global field. For a wire's source it pushes the wire out square to the side;
  flipped for its target, it draws the wire in square; for every other box it
  pushes wires away. That one mechanism could replace three that exist now: the
  near-box cost halo, the forced perpendicular exit, and the forced
  perpendicular entry.
- **Growing connectors.** Animate each wire drawing itself from source to
  target. The cheap version reveals the routed path over time with a dash
  offset. The field version traces a streamline from the source, steered
  between the field and the direction to the target, so the drawing shows the
  field at work. Either could export as an animated SVG or GIF.
