# Design QA

- source visual truth: `/Users/haot/.codex/generated_images/019fe4a3-142b-7f10-af91-89bba2ef1d38/exec-b1ae471f-721a-40f7-a160-ebdf6ab4939b.png`
- implementation screenshot: `/Users/haot/Projects/Hoplane/implementation-hosts-final.jpg`
- viewport: 1280 × 720 CSS px, full-page capture 1280 × 962 px, device pixel ratio 2
- state: light theme, SSH 主机 page, four fictional RFC 5737 demo hosts, `Database Replica` action row expanded

## Comparison setup

- source dimensions: 1487 × 1058 px
- implementation dimensions: 1280 × 962 px
- density normalization: the source was proportionally contained in a 1280 × 962 canvas; the browser capture was emitted at CSS-pixel dimensions despite DPR 2
- full-view evidence: `/Users/haot/Projects/Hoplane/design-qa-comparison.jpg`
- focused evidence: `/Users/haot/Projects/Hoplane/design-qa-focused.jpg` compares the filter bar, grouped ledger, selected row, and inline actions at the same presentation scale

## Findings

- The implementation preserves the chosen direction's dark horizontal navigation, white working surface, charcoal type, restrained forest-green accent, compact filter controls, grouped host ledger, selected-row treatment, and inline action bar.
- Summary cards, decorative gradients, glow, glass effects, oversized rounding, and artificial terminal-window dots were removed.
- Live project data replaces the reference's illustrative recent-activity content; the table keeps the same operational density while prioritizing controls that exist in the product today.
- All user-facing connection states are localized, keyboard-focus states remain visible, and controls retain accessible names.
- No unresolved P0, P1, or P2 visual discrepancies remain in the tested state.

## Comparison history

1. P1 — the original implementation used a left navigation rail, summary-card stack, and many always-visible row actions. Replaced with the reference-aligned top bar, inline summary, full-width ledger, and one expandable action row.
2. P2 — host states were shown as raw English enum values and row controls read too densely. Localized the states, tightened column widths, and moved secondary actions behind the row menu.
3. P2 — the ledger could exceed a narrow application window. Confined overflow to the table panel; at 820 × 900 the document width remains 820 px while the ledger scrolls internally.

## Interaction and regression checks

- Primary navigation: 主机、策略、审计、接入 all render their expected headings and content.
- Host search: `Database` narrows the ledger from four rows to one, then clears correctly.
- Row menu: expands and exposes 打开终端、指令记录、测试连接、停用、编辑、删除.
- Add-host flow: modal opens with the correct title and closes from its labeled close control.
- Responsive layout: no document-level horizontal overflow at 820 × 900; top navigation remains available.
- Browser console: no warnings or errors; only Vite development messages and the React DevTools informational message.
- Automated verification: typecheck passed, desktop production build passed, and 79/79 tests passed.

## Follow-up QA — appearance cycle control

- source visual truth: `/var/folders/kg/28j7d_d50ps11qj9plhqtm5m0000gn/T/codex-clipboard-acd9a28c-28fc-47fd-9956-12e84e576807.png`
- implementation screenshots: `/Users/haot/Projects/Hoplane/design-qa-theme-system.png`, `/Users/haot/Projects/Hoplane/design-qa-theme-dark.png`, `/Users/haot/Projects/Hoplane/design-qa-theme-light.png`
- viewport: 1280 × 720 CSS px; captures emitted at 1280 × 720 px and normalized to 1× for comparison
- source dimensions: 454 × 296 px
- state: SSH 主机 page; isolated empty demo data; system, dark, and light appearance states
- full-view evidence: `/Users/haot/Projects/Hoplane/design-qa-theme-system.png`
- focused evidence: `/Users/haot/Projects/Hoplane/design-qa-theme-comparison.png`, containing the 454 × 296 source and a same-size top-right implementation crop separated by a 24 px gutter

### Findings

- The gear, visible “外观” text, hover dropdown, and letter abbreviations are removed. One 36 × 36 icon control now occupies the same top-bar tool area.
- The control uses the existing Phosphor icon set: desktop for system, moon for dark, and sun for light. No raster, text glyph, custom SVG, or CSS-drawn substitute is used.
- Typography and page copy are unchanged; the only visible appearance label was intentionally removed. The updated accessible name states the current and next mode.
- Spacing remains aligned with the Core status, the circular hit target is comfortably clickable, and focus remains visible without changing the top-bar height.
- Existing top-bar colors and green interaction token are preserved in all three states. Light and dark page tokens switch correctly.
- No image-quality issue applies beyond the vector icon fidelity; all three icons render sharply at 20 px.
- No unresolved P0, P1, or P2 visual discrepancies remain.

### Comparison history

1. P1 — the source state used a settings gear plus text and exposed a large hover menu. Replaced it with the requested single-click, stateful system/moon/sun icon control.
2. P2 — “跟随系统” was not restored after refresh. The stored `system` preference is now accepted and was verified after a reload.

### Interaction and regression checks

- Click cycle verified: light → system → dark → light.
- System preference survives a page reload.
- No visible standalone “外观” label or dropdown remains.
- Browser console contains no warnings or errors.
- Typecheck passed, desktop production build passed, and 79/79 tests passed.

final result: passed
