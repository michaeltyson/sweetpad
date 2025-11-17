# SweetPad: Run tests

➡️ Moved to [sweetpad.hyzyla.dev/docs/tests](https://sweetpad.hyzyla.dev/docs/tests)

## Scheme-scoped discovery

- Tests discovered by SweetPad now appear under their owning Xcode scheme so you can run or debug an entire scheme without touching others.
- Selecting a scheme node (or any test beneath it) automatically reuses that scheme for build/run so you are not prompted again.
- Tests that cannot be matched to a scheme show up under **Ungrouped Tests**; you can still run them, and SweetPad will ask you which scheme to use on demand.
- Running “All Tests” executes each scheme sequentially, mirroring the structure shown in the explorer.
