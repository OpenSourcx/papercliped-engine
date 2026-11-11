// jsdom has no canvas: say so quietly (getContext returns null) instead of printing "Not implemented" in every test that renders a PinField.
if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, writable: true, value: () => null });
}
