# Fantasy

Next.js (static export) + Tailwind. `npm run dev`, `npm test`, `npx tsc --noEmit`. Pushes to `main` deploy to ff.sujeff.com.

## UI work

Any change to what the app looks like or how it moves goes through the design skills in `.claude/skills/`:

- `make-interfaces-feel-better`: the default pass for building or reviewing UI ("better-interface" / "interface-review" mean this skill; use its full review mode for a review).
- `emil-design-eng`: component and motion decisions. `animate`, `choreograph`, `review-animations`, `remove-animations` and `animation-performance` for motion specifically.
- `break-ui` for worst-case data, `mobile-native` for phone feel, `gestures` for sheets and drags.

The house style wins where a skill disagrees with it: dense, technical, square corners, 1px hairlines, IBM Plex Sans with mono labels, `ff-` colour tokens (`styles/fantasy.css`, `lib/themes.ts`), one accent, little motion and all of it under `motion-safe`. Icons live in `components/icons.tsx`; chevrons are always `ChevronIcon`, never text glyphs.

Check UI changes in a browser at 320, 390, 768 and 1280px, in a light and a dark theme, before calling them done.
