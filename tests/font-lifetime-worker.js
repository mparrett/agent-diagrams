// Renders a board in its own isolate, so it registers the fonts first.
self.onmessage = async () => {
  // Imported here: a static import would drop this first message.
  const { Diagram } = await import("../diagram-api.js");
  Diagram.load(
    new URL("../diagrams/basic/diagram-state.json", import.meta.url).pathname,
  )
    .renderToCanvas({ pixels: false });
  self.postMessage("rendered");
};
