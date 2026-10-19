import { activity } from "../src/activity.ts";
import { providerRetry } from "../src/pin.ts";

// A struggling model provider is retried after a short wait; tests don't wait.
Object.assign(providerRetry, { delaysMs: [0, 0] });

// The activity log is kept in memory for tests that read it; it is not printed.
activity.out = null;
