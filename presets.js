/**
 * Media Studio — SFX / BGM prompt presets.
 *
 * Text-based prompt presets for sound effects (SFX) and background music (BGM).
 * These are copyright-free / royalty-free style references derived from commonly
 * available CC-0 / royalty-free libraries (Kenney, Freesound, Mixkit, ZapSplat,
 * Sonniss GDC bundles, Kevin MacLeod, etc.).
 *
 * Each preset carries:
 *   - id: stable identifier
 *   - label: short human label
 *   - prompt: text-based prompt describing the desired sound/music
 *   - params: suggested parameters for the corresponding tool
 */

export const SFX_PRESETS = [
  { id: 'ui-click', label: 'UI click', prompt: 'Short, crisp UI click / button tap: high-frequency transient, ~40ms, low intensity, bright, no tail. Suitable for menus and confirmations.', params: { kind: 'click', duration: 0.05, intensity: 0.4, brightness: 0.8 } },
  { id: 'ui-hover', label: 'UI hover', prompt: 'Soft UI hover / focus tick: very short (~25ms), subtle, mid brightness, gentle. Non-intrusive feedback for mouse-over.', params: { kind: 'tick', duration: 0.03, intensity: 0.25, brightness: 0.6 } },
  { id: 'explosion-small', label: 'Small explosion', prompt: 'Small explosion / blast: low-frequency thump with mid crunch, ~0.6s, high intensity, medium brightness, short decay tail.', params: { kind: 'explosion', duration: 0.6, intensity: 0.85, brightness: 0.5 } },
  { id: 'explosion-large', label: 'Large explosion', prompt: 'Large explosion / detonation: deep sub-bass boom with debris crackle, ~1.5s, very high intensity, low brightness, long decay.', params: { kind: 'explosion', duration: 1.5, intensity: 1.0, brightness: 0.3 } },
  { id: 'footstep-grass', label: 'Footstep on grass', prompt: 'Footstep on grass/dirt: soft thud with light rustle, ~0.15s, low intensity, mid brightness.', params: { kind: 'footstep', duration: 0.15, intensity: 0.35, brightness: 0.5 } },
  { id: 'footstep-stone', label: 'Footstep on stone', prompt: 'Footstep on stone/concrete: sharper click with short echo, ~0.12s, medium intensity, bright.', params: { kind: 'footstep', duration: 0.12, intensity: 0.45, brightness: 0.7 } },
  { id: 'whoosh', label: 'Whoosh / swoosh', prompt: 'Whoosh / swoosh pass-by: broadband noise sweep rising then falling, ~0.4s, medium intensity, mid brightness.', params: { kind: 'whoosh', duration: 0.4, intensity: 0.5, brightness: 0.6 } },
  { id: 'impact-metal', label: 'Metal impact', prompt: 'Metal impact / clang: bright metallic ring with fast decay, ~0.5s, high intensity, very bright.', params: { kind: 'impact', duration: 0.5, intensity: 0.7, brightness: 0.9 } },
  { id: 'ambient-wind', label: 'Wind ambience', prompt: 'Wind ambience: low rumble with gentle high-frequency hiss, looping, ~3s, low intensity, low brightness.', params: { kind: 'ambience', duration: 3.0, intensity: 0.3, brightness: 0.3 } },
  { id: 'ambient-rain', label: 'Rain ambience', prompt: 'Rain ambience: steady drizzle texture, looping, ~3s, low-medium intensity, mid brightness.', params: { kind: 'ambience', duration: 3.0, intensity: 0.4, brightness: 0.5 } },
  { id: 'water-splash', label: 'Water splash', prompt: 'Water splash: bright splash transient with bubble tail, ~0.7s, medium intensity, bright.', params: { kind: 'splash', duration: 0.7, intensity: 0.6, brightness: 0.7 } },
  { id: 'weapon-sword', label: 'Sword swing', prompt: 'Sword swing / slash: fast metallic whoosh with sharp edge, ~0.3s, medium-high intensity, bright.', params: { kind: 'slash', duration: 0.3, intensity: 0.65, brightness: 0.8 } },
  { id: 'weapon-gunshot', label: 'Gunshot', prompt: 'Gunshot: sharp crack with low boom and short reverb tail, ~0.4s, very high intensity, mid brightness.', params: { kind: 'gunshot', duration: 0.4, intensity: 0.95, brightness: 0.5 } },
  { id: 'magic-spell', label: 'Magic spell', prompt: 'Magic spell cast: shimmering high-frequency sparkle with rising pitch, ~0.8s, medium intensity, very bright.', params: { kind: 'magic', duration: 0.8, intensity: 0.6, brightness: 0.9 } },
  { id: 'coin-pickup', label: 'Coin pickup', prompt: 'Coin / item pickup: bright two-tone chime, ~0.2s, low-medium intensity, very bright.', params: { kind: 'pickup', duration: 0.2, intensity: 0.5, brightness: 0.9 } },
];

export const BGM_PRESETS = [
  { id: 'lofi-chill', label: 'Lo-fi chill', prompt: 'Lo-fi chill hip-hop: ~70 BPM, warm Rhodes piano, soft boom-bap drums, vinyl crackle, mellow bass. Relaxed, study-friendly.', params: { bpm: 70, key: 'C minor', mood: 'relaxed' } },
  { id: 'cinematic-tension', label: 'Cinematic tension', prompt: 'Cinematic tension underscore: ~90 BPM, low strings drone, sparse percussion, dissonant high strings, building intensity.', params: { bpm: 90, key: 'D minor', mood: 'tense' } },
  { id: 'upbeat-electronic', label: 'Upbeat electronic', prompt: 'Upbeat electronic / synth-pop: ~128 BPM, bright synth leads, four-on-the-floor kick, energetic bass, major key. Cheerful.', params: { bpm: 128, key: 'G major', mood: 'upbeat' } },
  { id: 'ambient-pad', label: 'Ambient pad', prompt: 'Ambient pad / soundscape: ~60 BPM, slow evolving synth pads, no percussion, airy and spacious. Background for exploration or dialogue.', params: { bpm: 60, key: 'A minor', mood: 'ambient' } },
  { id: 'acoustic-folk', label: 'Acoustic folk', prompt: 'Acoustic folk: ~100 BPM, fingerpicked acoustic guitar, light shaker, warm and nostalgic.', params: { bpm: 100, key: 'G major', mood: 'warm' } },
  { id: 'orchestral-epic', label: 'Orchestral epic', prompt: 'Orchestral epic: ~140 BPM, full strings + brass + timpani, triumphant and heroic. Boss battle / victory fanfare.', params: { bpm: 140, key: 'D major', mood: 'epic' } },
  { id: 'jazz-lounge', label: 'Jazz lounge', prompt: 'Jazz lounge: ~95 BPM, walking bass, brushed drums, piano comping, sax melody. Relaxed and sophisticated.', params: { bpm: 95, key: 'Bb major', mood: 'relaxed' } },
  { id: 'retro-8bit', label: 'Retro 8-bit', prompt: 'Retro 8-bit chiptune: ~150 BPM, square-wave melody, triangle bass, noise drums. Nostalgic game music.', params: { bpm: 150, key: 'C major', mood: 'playful' } },
  { id: 'dark-ambient', label: 'Dark ambient', prompt: 'Dark ambient / horror: ~50 BPM, low drones, dissonant clusters, sparse metallic hits. Ominous atmosphere.', params: { bpm: 50, key: 'E minor', mood: 'dark' } },
  { id: 'funk-groove', label: 'Funk groove', prompt: 'Funk groove: ~110 BPM, slap bass, syncopated guitar, tight drums, horn stabs. Energetic and danceable.', params: { bpm: 110, key: 'E minor', mood: 'groovy' } },
];

// Copyright-free / royalty-free reference sources (style study, not copying):
//   Kenney (kenney.nl) CC0, Freesound (freesound.org) CC0/CC-BY, Mixkit (mixkit.co),
//   ZapSplat (zapsplat.com), Sonniss GDC Audio Bundles, Kevin MacLeod (incompetech.com),
//   OpenGameArt.org. Prefer styles reminiscent of these libraries.