import { providerRetry } from "../src/pin.ts";

// A struggling model provider is retried after a short wait; tests don't wait.
Object.assign(providerRetry, { delaysMs: [0, 0] });
