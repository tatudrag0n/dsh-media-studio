# Media Studio — SFX / BGM Prompt Guide

Copyright-free / royalty-free style references for sound effects (SFX) and
background music (BGM). Use these as text-based prompts when generating audio
with the `generate_sfx`, `generate_music`, `compose_music`, and `daw_arrange`
tools. Prefer styles reminiscent of these libraries rather than copying specific
copyrighted tracks.

## Reference sources (style study, not copying)

- Kenney (kenney.nl) — CC0 game audio
- Freesound (freesound.org) — CC0 / CC-BY SFX
- Mixkit (mixkit.co) — royalty-free SFX & music
- ZapSplat (zapsplat.com) — royalty-free SFX
- Sonniss GDC Audio Bundles — royalty-free
- Kevin MacLeod (incompetech.com) — CC-BY music
- OpenGameArt.org — CC0 / CC-BY game assets

## SFX categories (from common royalty-free libraries)

Ambience, Foley, UI, Weapons, Explosions, Footsteps, Water, Weather, Magic,
Vehicles, Creatures, Mechanical, Paper/Plastic, Debris, Glass, Wood, Metal,
Sports, Whistles, Wind, Doors, Impacts, Pickups, Whooshes.

## BGM styles (copyright-free / royalty-free)

Lo-fi chill, Cinematic tension, Upbeat electronic, Ambient pad, Acoustic folk,
Orchestral epic, Jazz lounge, Retro 8-bit, Dark ambient, Funk groove.

## Text-based prompt templates

See `presets.js` (`SFX_PRESETS`, `BGM_PRESETS`) for ready-to-use prompt strings
and suggested parameters. Import them in your code:

```js
import { SFX_PRESETS, BGM_PRESETS } from './presets.js';
```

## Notes

- The plugin generates audio locally (SFX via DSP, music via score/notes), so no
  third-party audio is redistributed. The presets above are *style descriptions*,
  not audio files, and carry no copyright.
- When in doubt, attribute the style inspiration (e.g., "in the style of Kenney
  CC0 game audio") rather than reproducing a specific track.
"@