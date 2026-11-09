import { FILES_OPTIONS, type FilesNeeded } from "./questions.ts";
import type { Ask } from "./typesafe.ts";

/**
 * A scripted stand-in for TypeSafe, for tests and CI: answers the three routing questions with the probabilities
 * given and makes no network call. Tests should assert the tier that comes out, never an exact probability.
 */
export const fakeJevAsk = (risk: number, files: FilesNeeded, routine: number): Ask => async () => ({
  risk: { type: "noul", noul: risk },
  routine: { type: "noul", noul: routine },
  files: { type: "choice", choice: files, probabilities: Object.fromEntries(FILES_OPTIONS.map((o) => [o, o === files ? 0.9 : 0.05])) },
});
