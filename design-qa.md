# Design QA

- Source visual truth:
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/codex-clipboard-335c5feb-c342-4242-aff9-7ae83873b9fb.png`
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/codex-clipboard-314755c8-db7f-446b-b85b-91b5e872a327.png`
  - Read-only layout/behavior reference: `/Volumes/WorkSSD/Project/VersionDock/src/host/panels/CommitDetailPanel.ts` and `/Volumes/WorkSSD/Project/VersionDock/src/webview/gitLog/components/CommitDetail.tsx`
- Implementation screenshots:
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 12.40.37 PM.jpeg`
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 12.41.14 PM.jpeg`
- Runtime: `/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/target/release/bundle/macos/VersionDock Desktop.app`
- Viewport: 1506 × 768 px application capture, macOS dark theme, density-normalized at the Computer Use capture size.
- Source pixels: 1439 × 350 px for the Diff stripe reference and 362 × 908 px for the commit-detail action reference.
- Implementation pixels: 1506 × 768 px for both the commit-detail and Diff states.
- State: real `nic` workspace, real Git commit `873bc4d3aad0c44713596bdce9c0cc4137efddf7`, then its Java file Diff.

## Full-view comparison evidence

- The commit action opens a dedicated detail workspace instead of a first-file preview. The captured result contains the author, email, complete hash, author/commit dates, repository, refs, full commit message, and changed-file tree in the same left-detail/right-files structure as the reference implementation.
- The real Diff capture shows diagonal shading only on the missing side of aligned split rows. Line-number gutters remain clear, and additions/deletions retain their semantic backgrounds.

## Focused region comparison evidence

- Compared the source Diff stripe region and the implementation Diff body in one inspection. Both use fine repeated diagonal strokes over the unavailable code area; the implementation keeps the pattern inside the code cell rather than covering the line-number gutter.
- Compared the source commit-detail action region and the implementation detail workspace in one inspection. The source screenshot establishes the action target; the read-only VersionDock implementation establishes the resulting two-column detail layout.

## Required fidelity surfaces

- Fonts and typography: existing VersionDock UI/code font tokens are retained; hashes and code use the code font; no visible clipping or unexpected wrapping in the captured state.
- Spacing and layout rhythm: the full detail uses a compact 38 px toolbar and a bounded two-column split; file rows keep the existing dense VersionDock metrics.
- Colors and visual tokens: the implementation reuses the current dark-theme surface, border, project color, status color, and Diff semantic tokens.
- Image quality and asset fidelity: no new raster, logo, illustration, or replacement icon asset was introduced; existing Codicons and file icons are retained.
- Copy and content: the action is exposed as `打开提交详情`; the result displays actual commit metadata rather than file-preview content.

## Findings

- No actionable P0/P1/P2 visual mismatch remains for the requested commit-detail action and Diff empty-cell shading.

## Comparison history

- Initial state: the action was labeled `打开预览` and opened the first changed-file Diff; aligned empty Diff cells were solid.
- Fix: routed the action to a dedicated single/aggregate commit-detail workspace and added scoped diagonal shading to empty split code cells.
- Post-fix evidence: the release-bundle screenshots listed above show the real single-commit detail and the shaded real Git Diff.

## Follow-up polish

- Multi-selection aggregation is covered by component and store tests; this visual pass captured the real single-selection state because modifier-click selection is not exposed by the native accessibility driver.

## Directory context-menu addendum

- Source visual truth:
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/codex-clipboard-81df233d-a7b9-4c77-8b79-18dfb2de37da.png`
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/codex-clipboard-2e22af3c-32b4-45da-94d8-b9a32c775b9a.png`
- Implementation screenshots:
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 3.18.28 PM.jpeg`
  - `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 3.19.07 PM.jpeg`
- Viewport and density: source panel 352 x 904 px, source focused menu 173 x 58 px, implementation 1506 x 768 px, native macOS dark-theme capture at device scale 1.
- State: real `nic` workspace, real two-file Git commit, collapsed directory node and repository-root node.
- Full-view evidence: both the collapsed directory and repository root open a context menu containing only `还原所选更改` and `优选所选更改`; no single-file Diff, open, reveal, or file-history action is present.
- Focused comparison: the source menu and the implementation menu were inspected together. Item order, labels, Codicons, compact dark surface, and two-row density match; no P0/P1/P2 mismatch remains.
- Interaction evidence: opening `还原所选更改` produced a structured confirmation listing both descendant paths and the working-copy consequence. The dialog was cancelled, so the user repository was not modified.
- Required fidelity surfaces: existing VersionDock typography, spacing, dark-theme tokens, Codicons, and Chinese copy are retained; no image asset was added or replaced.

## Branch-compare Diff lifecycle addendum

- Source visual truth: `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/codex-clipboard-6e0bf551-0201-449f-b99d-5cd3058a97e8.png` (1560 × 927 px).
- Implementation screenshots:
  - Diff opened from the comparison file tree: `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 5.30.07 PM.jpeg` (1506 × 768 px).
  - The same comparison restored after `返回比较`: `/var/folders/fp/v13rnkv95zs7yx97jygbpvtw0000gn/T/com.openai.sky.CUAService/VersionDock Desktop Screenshot 2026-08-27 at 5.30.37 PM.jpeg` (1506 × 768 px).
- Runtime and state: release bundle, real `nic` Git workspace, `ADMIN` repository, `main` versus `chenqinru`, real `.gitlab-ci.yml` revision Diff; macOS dark theme at the native Computer Use capture density.
- Primary interactions tested: open branch comparison, select a unique commit, open its changed file, verify the Diff header says `返回比较`, return, and verify the original comparison target, commit selection, file tree, filters, and two-pane comparison remain mounted.
- Full-view evidence: the Diff is an app-owned overlay over the comparison workspace instead of a destructive route replacement. Returning removes only the overlay and exposes the preserved comparison beneath it.
- Focused comparison evidence: source, Diff overlay, and restored comparison were inspected together. The requested file action opens the real side-by-side Diff and no longer closes or reconstructs the comparison view.
- Required fidelity surfaces: existing VersionDock typography, compact toolbar rhythm, dark-theme tokens, file icons, semantic Diff colors, and Chinese copy are retained; no image asset was added or substituted.
- Comparison history: the previous implementation stored the compare target in `HistoryWorkspace` local state, so `mode = diff` unmounted it and cleared the comparison. The target and result now live in the Store, while the Diff is rendered as a reversible comparison child layer.
- Findings: no actionable P0/P1/P2 issue remains for the reported comparison-to-Diff lifecycle.

final result: passed
