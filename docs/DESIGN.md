# Design

The console's design rules live with the console: [apps/console/DESIGN.md](../apps/console/DESIGN.md). It covers the principles, the token tiers (all values in `apps/console/src/index.css`), light and dark, the status vocabulary, motion and Pin's island, the component inventory, words, accessibility, and the `check:design` gate that keeps hand-typed visual values out of components.

Run the checks before changing the UI:

```sh
pnpm --filter @papercliped-engine/console check:design typecheck test build
```
