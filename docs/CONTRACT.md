# Vellum — integration contract

Vellum is an Electron desktop app that plays a YouTube live stream as the Windows desktop
wallpaper, with a floating Claude-styled control panel (pause / quality / volume / stream URL).

## Layout & ownership

| Path | Owner | Purpose |
| --- | --- | --- |
| `src/main/**`, `src/preload/**`, `package.json` | Lead | Electron shell, WorkerW attach, tray, persistence, IPC |
| `src/renderer/wallpaper/**` | wallpaper-player | Wallpaper page; YouTube IFrame API integration |
| `src/renderer/panel/**`, `assets/**` | panel-designer | Control panel UI, fonts, icons, imagery |
| `docs/**`, `README.md` | Lead | Documentation |

Do not edit files outside your ownership. Never edit another owner's files.

## Runtime shape (authoritative)

```ts
type QualityLevel = 'auto' | 'highres' | 'hd2880' | 'hd2160' | 'hd1440' | 'hd1080'
                  | 'hd720' | 'large' | 'medium' | 'small' | 'tiny';

interface VellumState {
  url: string;                 // current stream URL (or raw id)
  videoId: string | null;      // resolved 11-char YouTube id
  title: string;               // human stream title (from YouTube)
  channel: string;
  status: 'idle' | 'resolving' | 'loading' | 'playing' | 'paused' | 'error';
  paused: boolean;             // desired playback state; remains true across reloads
  quality: QualityLevel;       // user preference ('auto' initially)
  availableQualities: string[];// raw YT levels from getAvailableQualityLevels(), e.g. ['hd1080','hd720']
  activeQuality: string | null;// raw YT level currently playing, from getPlaybackQuality()
  volume: number;              // 0..100
  muted: boolean;
  veil: boolean;               // subtle top/bottom gradient over wallpaper for icon legibility
  launchAtLogin: boolean;
  autoPlay: boolean;           // start the configured stream when the app launches; false = wake idle
  attached: boolean;           // wallpaper window successfully parented to WorkerW
  error: string | null;        // human-readable error, shown in panel
  panelVisible: boolean;
  updatedAt: number;
}

interface AppInfo { version: string; platform: string; electron: string; }
```

## Desktop ownership

Vellum only parents a window to WorkerW while it has something to show. The wallpaper window
exists for status `resolving | loading | playing | paused` and is destroyed for `idle | error`
(autoplay off at login, no stream started yet, stream failed). This keeps the user's own Windows
wallpaper visible whenever Vellum is not actually playing something. Recreating the window on the
next activation is the reliable attach path (see src/main/wallpaper.js).

## Panel preload API — `window.vellum` (implemented by Lead)

All functions return Promises unless noted. `onState` returns an unsubscribe function.

```ts
window.vellum.getState(): Promise<VellumState>
window.vellum.onState(cb: (s: VellumState) => void): () => void
window.vellum.setPaused(paused: boolean): Promise<void>
window.vellum.setQuality(q: QualityLevel): Promise<void>
window.vellum.setVolume(v: number): Promise<void>
window.vellum.setMuted(m: boolean): Promise<void>
window.vellum.loadStream(url: string): Promise<{ ok: boolean; error?: string }>
window.vellum.reconnect(): Promise<void>
window.vellum.setSetting(key: 'veil' | 'launchAtLogin' | 'autoPlay', value: boolean): Promise<void>
window.vellum.hidePanel(): void
window.vellum.getAppInfo(): Promise<AppInfo>
window.vellum.onPanelShown(cb: () => void): () => void   // reselect/refresh on show
```

Panel renderer may also use `window.vellum.onState` immediately after load. It must render
correctly in a 392×640 frameless window (transparent outside the card).

## Wallpaper preload API — `window.vellumWallpaper` (implemented by Lead)

```ts
window.vellumWallpaper.getState(): Promise<VellumState>
window.vellumWallpaper.onState(cb: (s: VellumState) => void): () => void
window.vellumWallpaper.ready(): void                       // renderer mounted
window.vellumWallpaper.report(patch: Partial<VellumState>): void
window.vellumWallpaper.log(level: 'info'|'warn'|'error', message: string): void
```

The renderer receives the *full desired state* whenever anything changes. It must reconcile:
- videoId changed -> load player
- paused changed -> playVideo/pauseVideo
- quality changed -> setPlaybackQuality (map 'auto' -> 'default')
- volume/muted changed -> setVolume/setMuted
- report actual status, title, channel, quality list, active quality, errors back to main
- be idempotent; main may resend identical state

## Visual direction (panel)

Claude's design language: warm parchment (#F7F4ED family), ink (#191919), terracotta accent
(#D97757 / #C96442), hairline warm borders, literary serif display type, restrained motion,
generous negative space, subtle paper grain. No purple gradients, no generic dashboard cards.
Package fonts locally under `assets/fonts/` (OFL licensed) and reference via relative paths.
Use a hand-drawn 12-ray asterisk-style mark, not the Claude logo itself. UI copy in English;
tooltips/diacritics may vary. Must feel like a quiet, expensive desktop utility.

## Wallpaper renderer requirements

- Local `index.html`; load `https://www.youtube.com/iframe_api`; create player with
  `controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1,
  fs: 0, autoplay: 1, enablejsapi: 1`.
- No YouTube chrome visible ever: transparent click-shield overlay, `pointer-events: none` on
  the iframe; the native window also ignores mouse input.
- Video fills the screen with cover cropping (no letterbox), handles resize.
- Autoplay with sound allowed via Electron flags; volume from state.
- Graceful state screen: "tuning in" during load, offline/error copy, idle prompt.
- Report player events (playing/paused/buffering/error) to main via `report()`.
- Pause/resume must work; quality selection via IFrame API; expose actual available levels.
- Do not add visible controls; all controls live in the panel.
