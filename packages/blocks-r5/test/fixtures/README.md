# tokens-v6 fixtures

Copied verbatim for `tokens-v6.test.ts` (fix-r2 T2) because the originals live under the git-ignored internal `reports/` folder:

- `tokens-v6-design-tokens.css` = `reports/visual-r5/design-system/tokens.css`, sha256 `49f8ad455f001d271605bad98ed0eaf95cda2bdeface17fb8ddf722e8c740f5a` (byte-identical; the test compares it in full, so it carries no header).
- `tokens-v6-before-theme.css` = `reports/blocks-r5/before/S0/packages/workbench/src/ui/theme.css`, sha256 `89992e91a9c398a4238b339e8cfbf2572a52112800aa8330facf9e989f325e83` (plus a one-line provenance comment on top).

release-r1 visual audit (AUDIT P0-2 / P1-1 / P1-2 / P1-5 / P2-8 / P2-9) changed the design tokens on purpose, so both fixtures were edited in place to the new values (ink `#0A0A0B` family, Geist fonts, single easing curve, dead `--gr-fund-*` / `--gr-sel-ring` / `--gr-sel-glow` / `--gr-title-grad` removed). They are no longer byte-identical to the originals above.
