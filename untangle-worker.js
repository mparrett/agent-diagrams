/**
 * untangle-worker.js — runs Diagram.untangle for the dev server's /untangle
 * route. A search renders every candidate and takes tens of seconds, so it
 * runs here instead of on the server's request loop.
 *
 * In:  { statePath, baseRev, unpin, budget? }
 * Out: { status, rev?, moved?, before?, after?, error? }
 */

// The API is imported inside the handler: a static import evaluates the canvas
// module asynchronously, and the server's message arrives before onmessage is
// set and is dropped, so the worker would never answer.
self.onmessage = async ({ data: { statePath, baseRev, unpin, budget } }) => {
  const { Diagram, LockBusy, RevConflict } = await import("./diagram-api.js");
  try {
    const d = Diagram.load(statePath);
    if (d.rev !== baseRev) {
      self.postMessage({ status: 409, error: "board changed", rev: d.rev });
      return;
    }
    const r = d.untangle({ unpin, budget });
    const out = { before: r.before, after: r.after, moved: r.moved.length };
    // One attempt, as in the CLI: a retry would re-run the search against a
    // board someone else has just changed.
    if (r.moved.length) d.save(statePath);
    self.postMessage({ status: 200, rev: d.rev, ...out });
  } catch (e) {
    const busy = e instanceof RevConflict || e instanceof LockBusy;
    self.postMessage({
      status: busy ? 409 : 500,
      error: busy
        ? "the board changed while untangling; nothing was saved"
        : String(e?.message ?? e),
    });
  }
};
