# Bundled fonts

- **DejaVuSansMono[-Bold].ttf** — registered as the `monospace` family in the
  PNG renderer (default `"font": "mono"`). License: `LICENSE` (DejaVu).
- **InstrumentSans-Regular/SemiBold.ttf** — the `"font": "sans"` face
  (`DiagramSans` family; SemiBold serves as bold). These are Instrument Sans
  (OFL, `LICENSE-InstrumentSans`) **merged with the symbol ranges of DejaVu
  Sans** (arrows, dingbats, geometric shapes — U+2190-21FF, U+2300-23FF,
  U+25A0-25FF, U+2600-27BF, U+2B00-2BFF) so glyphs like ✗ ✓ ● ▶ don't render
  as tofu. Regenerate with fontTools: subset DejaVuSans to those ranges
  (--drop-tables+=MATH,FFTM), scale_upem to 1000, fontTools.merge with
  Instrument first.
