/**
 * untangle-worker.js — runs Diagram.untangle for the dev server's /untangle
 * route. A search renders every candidate and takes seconds, so it runs here
 * instead of on the server's request loop.
 *
 * In:  { statePath, baseRev, unpin, budget?, stopFlag }
 *      stopFlag: an Int32Array over a SharedArrayBuffer; the server sets [0]
 *      to 1 to end the search early (the search loop never yields, so a
 *      message would not arrive until it was over).
 * Out: { progress: { evals, budget, crossings, labels } } while running, then
 *      { status, rev?, moved?, before?, after?, stopped?, error? }
 */

// The API is imported inside the handler: a static import evaluates the canvas
// module asynchronously, and the server's message arrives before onmessage is
// set and is dropped, so the worker would never answer.
self.onmessage = async (
  { data: { statePath, baseRev, unpin, budget, stopFlag } },
) => {
  const { Diagram, LockBusy, RevConflict } = await import("./diagram-api.js");
  try {
    const d = Diagram.load(statePath);
    if (d.rev !== baseRev) {
      self.postMessage({ status: 409, error: "board changed", rev: d.rev });
      return;
    }
    let last = 0;
    const r = d.untangle({
      unpin,
      budget,
      stop: () => Atomics.load(stopFlag, 0) === 1,
      onEval: (evals, budget, top) => {
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
        self.postMessage({
          progress: {
            evals,
            budget,
            crossings: top.crossings,
            labels: top.labels,
          },
        });
      },
    });
    const out = {
      before: r.before,
      after: r.after,
      moved: r.moved.length,
      stopped: Atomics.load(stopFlag, 0) === 1,
    };
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
