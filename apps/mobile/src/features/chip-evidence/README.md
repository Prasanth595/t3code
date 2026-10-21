# Offline native chip fixture

Build with `eas build -p ios --profile chip-evidence --non-interactive` from
`apps/mobile`. This release simulator profile selects a separate entry point,
`ChipEvidenceApp`, through `EXPO_PUBLIC_CHIP_EVIDENCE=1`. Normal builds retain
`App`. It renders the production feed, composer, markdown previews and palette;
it does not mount the connection, cloud-auth or pairing coordinators.

Open `t3code-preview://chip-fixture?scene=U1-1&theme=t3-code&appearance=light`.
`SCENES` in `fixtures.ts` enumerates pages. The six built-in theme ids and light/
dark appearances use the normal appearance preferences. `fontSize=22` is an
app font-size supplement, **not** a claim about iOS accessibility scaling.
`Previous`, `Next`, and `Light / dark` retain the fixture data; `Palette` opens
the real command palette with the static projects. All outgoing action callbacks
on the composer are inert; navigation into unavailable backend screens is not
part of this fixture.

The registry holds static project and thread shells. Async initialization is
pinned to those values so persisted catalog initialization cannot empty the
fixture. No connection catalog or credential is seeded. Context records are
validated with the wire contract before rendering. The bundled GitHub icon is
the loaded favicon control; glyphs use the production rasterizer.

For a baseline source snapshot with this identical fixture overlay, run from
repository root:

```
node apps/mobile/scripts/chip-evidence-snapshot.mjs <baseline-sha> /tmp/chip-before
```

This extracts the committed source and overlays committed fixture files with `git archive HEAD --` for only the fixture, its entry-point
switch, EAS profile and snapshot script. A no-op adapter replaces the rasterizer
on source revisions that predate it. `chip-evidence-source.json` records source
and fixture revisions. No other baseline production source changes. Build the
snapshot with `EAS_NO_VCS=1` and `EAS_PROJECT_ROOT=/tmp/chip-before` from its
`apps/mobile` directory. A baseline snapshot is an artifact, not a development
checkout.

The fixture is intentionally not complete evidence for the matrix by itself.
In particular, iOS has no native Material You palette implementation; standalone
favicon grids are supplemental component controls, not evidence for every
favicon caller. Screenshots must separately record source/build ids, device,
viewport, scale, actual visible pages, and uncovered interactions/states.

The evidence-only EAS post-install hook restricts generated app and Pods projects
to arm64, matching the vendored GhosttyKit simulator slice and local showcase
recipe. It requires the fixture flag, chip-evidence profile and iOS platform;
normal builds do not change. It edits generated native projects with xcodeproj.
