// Shared corpus for the editor↔renderer measurement-parity harness.
//
// The whole cross-engine parity question reduces to ONE quantity per box:
// the result of measureNodeWidth (`dims.w`). Both the editor (browser canvas)
// and the renderer (Deno canvas) import the *same* computeLayout from
// diagram-core.js — the only thing that can differ between them is
// ctx.measureText. So this module is pure data + helpers, importable in both
// runtimes (no Deno or DOM APIs), fed identically to each side.

export const FONT_MODES = ["mono", "sans"];
// Box-label sizes to sweep — geometry scales with fontSize, so metrics must
// agree at more than the default 13px.
export const FONT_SIZES = [13, 20];

// Single-line label probes: short/medium/long, monospace-length sweeps to catch
// ceil(width/CELL) boundary flips, the diagram glyphs (arrows/checks) that the
// bundled fonts exist to cover, and mixed punctuation.
export const LABEL_PROBES = [
  "A",
  "DB",
  "API",
  "Node",
  "API Gateway",
  "Database",
  "Auth Service",
  "Load Balancer",
  "Message Queue",
  "Object Storage",
  "Kubernetes Ingress Controller",
  "PostgreSQL Primary Replica",
  "Cache (Redis)",
  "v2.1.0-rc",
  "user_session_store",
  "client → api",
  "health ✓",
  "denied ✗",
  "◀ back ▶",
  // length sweeps — widths land at many fractional cell positions, so any
  // sub-pixel cross-engine disagreement near a boundary surfaces here.
  "i",
  "ii",
  "iii",
  "iiii",
  "iiiii",
  "iiiiii",
  "iiiiiii",
  "W",
  "WW",
  "WWW",
  "WWWW",
  "WWWWW",
  "WWWWWW",
  "WWWWWWW",
  "Mmmmmmmm",
  "Mmmmmmmmm",
  "Mmmmmmmmmm",
  "Mmmmmmmmmmm",
  "Mmmmmmmmmmmm",
];

// A probe = a node fed to measureNodeWidth, tagged with its font/size context.
export function probes() {
  const out = [];
  for (const fontMode of FONT_MODES) {
    for (const fontSize of FONT_SIZES) {
      for (const label of LABEL_PROBES) {
        out.push({
          key: `${fontMode}|${fontSize}|${label}`,
          fontMode,
          fontSize,
          node: { id: label, label },
        });
      }
      // multi-line details (widest line drives width) + an explicit minW floor
      out.push({
        key: `${fontMode}|${fontSize}|__details`,
        fontMode,
        fontSize,
        node: {
          id: "svc",
          label: "Service",
          details: ["GET /v1/users", "POST /v1/orders/{id}", "rate-limited"],
        },
      });
      out.push({
        key: `${fontMode}|${fontSize}|__minW`,
        fontMode,
        fontSize,
        node: { id: "minw", label: "Small", minW: 240 },
      });
    }
  }
  return out;
}

// Full-layout states — exercise computeLayout end to end (row stacking, intra-row
// placement, the spring pass, uniformWidth). Compared box-by-box on {col,row,w,h}.
export const STATES = [
  {
    name: "linear-mono",
    state: {
      width: 1000,
      nodes: [
        { id: "client", label: "Client", color: "blue", row: 0, col: 0 },
        {
          id: "api",
          label: "API Gateway",
          color: "green",
          row: 0,
          col: 1,
          details: ["auth", "routing"],
        },
        { id: "db", label: "Database", color: "purple", row: 1, col: 1 },
      ],
      edges: [{ from: "client", to: "api" }, { from: "api", to: "db" }],
    },
  },
  {
    name: "fanout-sans",
    state: {
      font: "sans",
      width: 1400,
      nodes: [
        { id: "lb", label: "Load Balancer", color: "blue", row: 0, col: 1 },
        { id: "a", label: "Worker A", color: "green", row: 1, col: 0 },
        { id: "b", label: "Worker B Service", color: "green", row: 1, col: 1 },
        { id: "c", label: "Worker C", color: "green", row: 1, col: 2 },
        { id: "q", label: "Queue", color: "orange", row: 2, col: 1 },
      ],
      edges: [
        { from: "lb", to: "a" },
        { from: "lb", to: "b" },
        { from: "lb", to: "c" },
        { from: "a", to: "q" },
        { from: "b", to: "q" },
        { from: "c", to: "q" },
      ],
    },
  },
  {
    name: "uniform-bigfont",
    state: {
      uniformWidth: true,
      fontSize: 18,
      width: 1200,
      nodes: [
        { id: "ingest", label: "Ingest", color: "blue", row: 0, col: 0 },
        {
          id: "transform",
          label: "Transform Pipeline",
          color: "green",
          row: 0,
          col: 1,
        },
        { id: "store", label: "Store", color: "purple", row: 0, col: 2 },
      ],
      edges: [{ from: "ingest", to: "transform" }, {
        from: "transform",
        to: "store",
      }],
    },
  },
];
