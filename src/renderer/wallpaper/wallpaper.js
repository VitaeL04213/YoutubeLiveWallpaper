/*!
 * Vellum — wallpaper renderer
 * ============================================================================
 * Plays a YouTube live stream edge-to-edge as the Windows desktop wallpaper.
 *
 * Driven entirely by the full desired state pushed through
 * window.vellumWallpaper.onState(state) and reported back with
 * window.vellumWallpaper.report(patch). No visible controls live here.
 *
 * Reported state keys (the only keys this page ever reports):
 *   status ('loading' | 'playing' | 'paused' | 'error'),
 *   error (string | null),
 *   title, channel,
 *   availableQualities (string[]), activeQuality (string | null)
 *
 * Reconcile rules:
 *   videoId changed          -> loadVideoById  (cueVideoById when the desired
 *                               paused flag is true, to avoid an audio blip)
 *   status 'loading' + last reported 'error' with the same videoId
 *                            -> reload (the panel's Reconnect path)
 *   paused changed           -> pauseVideo / playVideo
 *   quality changed          -> setPlaybackQuality, 'auto' -> 'default'
 *   volume / muted changed   -> setVolume / mute / unMute
 *   veil changed             -> toggle the top/bottom gradient overlay
 *   everything is idempotent: replayed identical state performs no work.
 *
 * Standalone preview (opened outside Electron, or without the preload bridge):
 *   wallpaper/index.html?video=jfKfPfyJRdk         play any id or YouTube URL
 *                        &paused=1 &volume=40 &muted=1 &veil=0
 *                        &quality=hd1080 &title=... &channel=...
 *                        &error=Message                  show the error screen
 *   In this mode a local stub bridge stands in for the app; use
 *   window.vellumWallpaperStub.setState({...}) in the console to simulate the
 *   panel. The page never throws without the bridge.
 *
 * Implementation notes:
 *   - Cover cropping is done by sizing .stage to a 16:9 box that always covers
 *     the viewport, so YouTube never letterboxes inside the iframe.
 *   - The iframe is pointer-events:none and a transparent click shield sits on
 *     top, so YouTube's hover chrome can never be revealed.
 *   - The YouTube API script is always loaded, but the player itself is only
 *     built once a videoId exists: an idle wallpaper never asks YouTube for an
 *     empty embed, and spurious player errors can never reach main's state.
 * ============================================================================
 */
(function () {
  "use strict";

  // ==========================================================================
  // Constants
  // ==========================================================================

  const YT_API_SRC = "https://www.youtube.com/iframe_api";
  const YT_API_TIMEOUT_MS = 15000;
  const PLAYER_POLL_MS = 2500;
  const MAX_API_ATTEMPTS = 3;

  // A stream can die in ways YouTube never reports: the embed's iframe is torn
  // out from under us (renderer/subframe failure), the player object stops
  // answering, or playback simply stops advancing. Without a watchdog the
  // wallpaper stays black and the panel sits on "Tuning in" forever, so the
  // player is rebuilt (bounded) when one of these is detected.
  const PLAYER_READY_TIMEOUT_MS = 20000;
  const STALL_TIMEOUT_MS = 25000;
  const MAX_REBUILDS = 2;
  const REBUILD_COOLDOWN_MS = 12000;
  const WALLPAPER_ASPECT = 16 / 9;

  // playerVars exactly as required by docs/CONTRACT.md ("no YouTube chrome").
  const YT_PLAYER_VARS = {
    autoplay: 1,
    controls: 0,
    disablekb: 1,
    modestbranding: 1,
    rel: 0,
    iv_load_policy: 3,
    playsinline: 1,
    fs: 0,
    enablejsapi: 1,
    loop: 0,
  };

  // YT.PlayerState values (the API exposes them, but they are plain numbers).
  const YT_STATE = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5,
  };

  const YT_ERROR_COPY = {
    2: "The stream address was rejected by YouTube.",
    5: "This stream cannot be played in an embedded player.",
    100: "This stream is private or no longer available.",
    101: "The channel does not allow this stream to be embedded.",
    150: "The channel does not allow this stream to be embedded.",
    153: "YouTube rejected the player configuration. Reconnect to try again.",
  };

  // Only 'auto' needs translating; every other QualityLevel maps 1:1.
  const QUALITY_TO_API = { auto: "default" };

  // Full VellumState shape; used to fill in defensive defaults and to make the
  // standalone stub behave like main.
  const BASE_STATE = {
    url: "",
    videoId: null,
    title: "",
    channel: "",
    status: "idle",
    paused: false,
    quality: "auto",
    availableQualities: [],
    activeQuality: null,
    volume: 100,
    muted: false,
    veil: true,
    launchAtLogin: false,
    attached: false,
    error: null,
    panelVisible: false,
    updatedAt: 0,
  };

  // ==========================================================================
  // DOM
  // ==========================================================================

  const stage = document.getElementById("stage");
  // Reassigned when a torn-down player's mount point has to be replaced.
  let playerFrame = document.getElementById("player-frame");
  const veil = document.getElementById("veil");
  const screen = document.getElementById("screen");
  const headlineEl = document.getElementById("screen-headline");
  const detailEl = document.getElementById("screen-detail");
  const hintEl = document.getElementById("screen-hint");
  const previewEl = document.getElementById("screen-preview");

  // ==========================================================================
  // Preload bridge (window.vellumWallpaper) — or a local stub when standalone
  // ==========================================================================

  const hasElectronBridge = !!(
    window.vellumWallpaper &&
    typeof window.vellumWallpaper.getState === "function"
  );

  const bridge = hasElectronBridge
    ? wrapBridge(window.vellumWallpaper)
    : createStandaloneBridge();

  if (!hasElectronBridge) {
    // Handy for screenshot/interaction QA without the Electron shell.
    window.vellumWallpaperStub = bridge;
  }

  function wrapBridge(raw) {
    return {
      standalone: false,
      getState: function () {
        return raw.getState();
      },
      onState: function (callback) {
        return raw.onState(callback);
      },
      ready: function () {
        try {
          if (typeof raw.ready === "function") raw.ready();
        } catch (error) {
          /* window may already be closing */
        }
      },
      report: function (patch) {
        try {
          if (typeof raw.report === "function") raw.report(patch);
        } catch (error) {
          /* never let reporting kill playback */
        }
      },
      log: function (level, message) {
        try {
          if (typeof raw.log === "function") raw.log(level, message);
        } catch (error) {
          /* ignore */
        }
      },
    };
  }

  function createStandaloneBridge() {
    const state = Object.assign({}, BASE_STATE);
    const listeners = new Set();
    const params = new URLSearchParams(window.location.search);

    // Query parameters simulate the app for standalone previews.
    const rawVideo =
      params.get("video") || params.get("v") || params.get("url") || "";
    const videoId = resolveVideoId(rawVideo);
    if (videoId) {
      state.url = rawVideo;
      state.videoId = videoId;
      state.status = "loading";
      state.title = params.get("title") || "";
      state.channel = params.get("channel") || "";
    }
    if (params.get("paused") === "1" || params.get("paused") === "true") {
      state.paused = true;
    }
    if (params.get("muted") === "1") state.muted = true;
    if (params.get("veil") === "0") state.veil = false;
    const volume = Number(params.get("volume"));
    if (Number.isFinite(volume)) state.volume = clamp(volume, 0, 100);
    const quality = params.get("quality");
    if (quality) state.quality = quality;
    const error = params.get("error");
    if (error) {
      state.status = "error";
      state.error = error;
    }

    function notify() {
      const snapshot = Object.assign({}, state);
      snapshot.availableQualities = state.availableQualities.slice();
      listeners.forEach(function (callback) {
        try {
          callback(Object.assign({}, snapshot));
        } catch (error) {
          /* a listener must not break the stub */
        }
      });
    }

    return {
      standalone: true,
      getState: function () {
        return Promise.resolve(Object.assign({}, state));
      },
      onState: function (callback) {
        listeners.add(callback);
        return function () {
          listeners.delete(callback);
        };
      },
      ready: function () {
        /* nothing to announce outside Electron */
      },
      report: function (patch) {
        let changed = false;
        Object.keys(patch).forEach(function (key) {
          if (!valueEqual(state[key], patch[key])) {
            state[key] = patch[key];
            changed = true;
          }
        });
        if (!changed) return;
        state.updatedAt = Date.now();
        // Defer so the emitter never re-enters report() synchronously.
        Promise.resolve().then(notify);
      },
      log: function (level, message) {
        const fn =
          level === "error"
            ? console.error
            : level === "warn"
            ? console.warn
            : console.info;
        fn.call(console, "[vellum wallpaper]", message);
      },
      // window.vellumWallpaperStub.setState({ paused: true }) for QA.
      setState: function (patch) {
        Object.assign(state, patch);
        state.updatedAt = Date.now();
        notify();
      },
    };
  }

  // ==========================================================================
  // Application state
  // ==========================================================================

  let desired = null; // latest desired VellumState from main (or stub)
  let player = null; // YT.Player instance
  let playerReady = false;
  let apiReady = false;
  let apiAttempts = 0;
  let bootError = null; // API/script/player-creation failure, shown on screen

  let currentVideoId = null; // video currently loaded into the player
  let didPlay = false; // current video has produced frames (screen may hide)
  let playerError = null; // human-readable playback error (screen may show)
  let playerErrorCode = null;
  let retryCount = 0; // autoplay retries for the current load
  let qualityAppliedForThisLoad = false;

  let appliedQuality = null; // last setPlaybackQuality value
  let appliedVolume = null; // last setVolume value
  let appliedMuted = null; // last mute state

  let playerCreatedAt = 0; // when the current YT.Player was constructed
  let lastProgressAt = 0; // last time playback actually advanced
  let lastProgressTime = -1;
  let rebuildAttempts = 0; // player rebuilds for the current load
  let lastRebuildAt = 0;

  let pollTimer = null;
  let resizeFrame = 0;
  let lastReportedStatus = null;
  const lastReport = Object.create(null);

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function valueEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  /**
   * Extracts an 11-character YouTube id from a bare id, youtu.be link, watch
   * link, /live, /embed, or /shorts link. Standalone preview only.
   */
  function resolveVideoId(input) {
    if (!input || typeof input !== "string") return null;
    const value = input.trim();
    if (!value) return null;
    const patterns = [
      /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
      /[?&]v=([A-Za-z0-9_-]{11})/,
      /\/(?:embed|live|shorts|watch)\/([A-Za-z0-9_-]{11})/,
      /^([A-Za-z0-9_-]{11})$/,
    ];
    for (let i = 0; i < patterns.length; i += 1) {
      const match = value.match(patterns[i]);
      if (match) return match[1];
    }
    return null;
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function log(level, message) {
    bridge.log(level, message);
  }

  // ==========================================================================
  // Layout: cover-crop the 16:9 stage
  // ==========================================================================

  function fitStage() {
    const width = Math.max(window.innerWidth || 0, 1);
    const height = Math.max(window.innerHeight || 0, 1);
    let frameWidth;
    let frameHeight;
    if (width / height >= WALLPAPER_ASPECT) {
      frameWidth = width;
      frameHeight = width / WALLPAPER_ASPECT;
    } else {
      frameHeight = height;
      frameWidth = height * WALLPAPER_ASPECT;
    }
    // One pixel of overscan hides sub-pixel seams at the window edges.
    stage.style.width = Math.ceil(frameWidth + 1) + "px";
    stage.style.height = Math.ceil(frameHeight + 1) + "px";
  }

  function scheduleFit() {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = 0;
      fitStage();
    });
  }

  // ==========================================================================
  // Desired-state reconciliation
  // ==========================================================================

  function handleDesiredState(incoming) {
    if (!incoming || typeof incoming !== "object") return;
    const previous = desired;
    // The contract guarantees a full state; merging keeps the page resilient to
    // a partial payload without losing fields.
    desired = Object.assign({}, previous || BASE_STATE, incoming);

    updateVeil();

    if (previous) {
      reconcile(previous, desired);
    } else if (playerReady) {
      fullApply();
    }

    renderScreen();
  }

  function reconcile(previous, next) {
    // A retryable startup failure + a fresh 'loading' from main == reconnect.
    if (!apiReady && bootError && next.status === "loading") {
      startPlayer();
      return;
    }

    // The player is only created once there is a stream to show, so an idle
    // wallpaper never asks YouTube for an empty embed (which can fail).
    if (!playerReady) {
      if (apiReady && !player && next.videoId) createPlayer();
      return; // onready -> fullApply replays everything
    }

    const nextVideoId =
      typeof next.videoId === "string" && next.videoId ? next.videoId : null;
    const previousVideoId =
      typeof previous.videoId === "string" && previous.videoId
        ? previous.videoId
        : null;

    if (nextVideoId !== previousVideoId) {
      if (nextVideoId) loadVideo(nextVideoId, false);
      else unloadVideo();
    } else if (
      nextVideoId &&
      nextVideoId === currentVideoId &&
      next.status === "loading" &&
      lastReportedStatus === "error"
    ) {
      // Reconnect with the same id: main put us back into 'loading' after we
      // reported an error, so reload the player.
      loadVideo(nextVideoId, true);
    }

    if (next.paused !== previous.paused) applyPaused();
    if (next.quality !== previous.quality) applyQuality(false);
    if (next.volume !== previous.volume || next.muted !== previous.muted) {
      applyVolume();
    }
  }

  /** Applies the whole desired state after the player first becomes ready. */
  function fullApply() {
    if (!playerReady || !desired) return;
    updateVeil();
    if (desired.videoId) {
      if (!player) {
        createPlayer();
        return; // onready -> fullApply again
      }
      loadVideo(desired.videoId, false);
    } else {
      unloadVideo();
    }
    applyVolume();
    applyPaused();
    applyQuality(false);
  }

  function updateVeil() {
    const enabled = desired ? desired.veil !== false : BASE_STATE.veil;
    veil.classList.toggle("veil--off", !enabled);
  }

  // ==========================================================================
  // Player commands
  // ==========================================================================

  function loadVideo(videoId, isReload) {
    if (!playerReady || !player || !videoId) return;
    if (currentVideoId === videoId && !isReload && didPlay) {
      applyPaused();
      return;
    }

    currentVideoId = videoId;
    didPlay = false;
    playerError = null;
    playerErrorCode = null;
    retryCount = 0;
    qualityAppliedForThisLoad = false;
    rebuildAttempts = 0;
    lastProgressAt = Date.now();
    lastProgressTime = -1;

    const patch = {
      status: desired && desired.paused ? "paused" : "loading",
      error: null,
    };
    if (!isReload) {
      patch.title = "";
      patch.channel = "";
      patch.availableQualities = [];
      patch.activeQuality = null;
    }
    sendReport(patch);

    applyVolume();

    try {
      if (desired && desired.paused) {
        // Cue only: a desired-paused stream must never produce an audio blip.
        player.cueVideoById({ videoId: videoId });
      } else {
        player.loadVideoById({ videoId: videoId });
        // Nudge autoplay; harmless if the player already started.
        player.playVideo();
      }
    } catch (error) {
      handlePlayerError(null, error);
      return;
    }

    // Early quality requests are often ignored; applied again on PLAYING.
    applyQuality(true);
    renderScreen();
  }

  function unloadVideo() {
    currentVideoId = null;
    didPlay = false;
    playerError = null;
    playerErrorCode = null;
    retryCount = 0;
    appliedQuality = null;
    qualityAppliedForThisLoad = false;
    if (playerReady && player && typeof player.stopVideo === "function") {
      try {
        player.stopVideo();
      } catch (error) {
        /* ignore */
      }
    }
    renderScreen();
  }

  function applyPaused() {
    if (!playerReady || !player || !currentVideoId || !desired) return;
    let state = YT_STATE.UNSTARTED;
    try {
      state = player.getPlayerState();
    } catch (error) {
      return;
    }
    try {
      if (desired.paused) {
        if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
          player.pauseVideo();
        }
      } else if (
        state === YT_STATE.PAUSED ||
        state === YT_STATE.CUED ||
        state === YT_STATE.UNSTARTED ||
        state === YT_STATE.BUFFERING
      ) {
        player.playVideo();
      }
    } catch (error) {
      /* player is mid-teardown */
    }
  }

  function qualityTarget() {
    const quality = desired && desired.quality ? desired.quality : "auto";
    return QUALITY_TO_API[quality] || quality;
  }

  function applyQuality(force) {
    if (!playerReady || !player || !currentVideoId || !desired) return;
    const target = qualityTarget();
    if (!force && appliedQuality === target) return;
    appliedQuality = target;
    try {
      player.setPlaybackQuality(target);
    } catch (error) {
      /* older embeds may refuse */
    }
    // YouTube treats setPlaybackQuality as a hint and its adaptive algorithm
    // often ignores it. The range call is the only way to actually pin a level.
    try {
      if (typeof player.setPlaybackQualityRange === "function") {
        player.setPlaybackQualityRange(target, target);
      }
    } catch (error) {
      /* not exposed by every embed build */
    }
  }

  function applyVolume() {
    if (!playerReady || !player || !desired) return;
    const rawVolume = Number(desired.volume);
    const volume = Number.isFinite(rawVolume) ? clamp(rawVolume, 0, 100) : 100;
    if (volume !== appliedVolume) {
      try {
        player.setVolume(volume);
      } catch (error) {
        /* ignore */
      }
      appliedVolume = volume;
    }
    const muted = !!desired.muted;
    if (muted !== appliedMuted) {
      try {
        if (muted) player.mute();
        else player.unMute();
      } catch (error) {
        /* ignore */
      }
      appliedMuted = muted;
    }
  }

  /** A single autoplay rescue per pause event (e.g. a transient autoplay block). */
  function retryPlay() {
    if (!desired || desired.paused || !currentVideoId || retryCount >= 2) return;
    retryCount += 1;
    const delay = retryCount === 1 ? 1200 : 4000;
    window.setTimeout(function () {
      if (!desired || desired.paused || !playerReady || !player || !currentVideoId) {
        return;
      }
      let state = YT_STATE.UNSTARTED;
      try {
        state = player.getPlayerState();
      } catch (error) {
        return;
      }
      if (
        state === YT_STATE.PAUSED ||
        state === YT_STATE.CUED ||
        state === YT_STATE.UNSTARTED
      ) {
        try {
          player.playVideo();
        } catch (error) {
          /* ignore */
        }
      }
    }, delay);
  }

  /**
   * True while the player still owns a live iframe in this document. A player
   * whose iframe was torn out can keep answering from cache while nothing is
   * rendered, which is the state that used to hang the wallpaper for good.
   */
  function playerFrameAlive() {
    if (!player) return false;
    try {
      const iframe = player.getIframe();
      return !!(iframe && iframe.isConnected);
    } catch (error) {
      return false;
    }
  }

  /**
   * Throws the current player away and mounts a brand new one. Bounded by
   * MAX_REBUILDS so a genuinely broken stream ends in a visible error the user
   * can act on instead of an endless black wallpaper.
   */
  function rebuildPlayer(reason) {
    if (!desired || !desired.videoId) return;
    const now = Date.now();
    if (now - lastRebuildAt < REBUILD_COOLDOWN_MS) return;
    if (rebuildAttempts >= MAX_REBUILDS) {
      playerError =
        "The stream stopped responding. Reconnect or choose another stream.";
      playerErrorCode = null;
      didPlay = false;
      log("error", "playback watchdog gave up: " + reason);
      sendReport({ status: "error", error: playerError });
      renderScreen();
      return;
    }
    rebuildAttempts += 1;
    lastRebuildAt = now;
    log(
      "warn",
      "rebuilding the player (" + reason + "), attempt " + rebuildAttempts
    );

    if (player) {
      try {
        player.destroy();
      } catch (error) {
        /* the player may already be half gone */
      }
    }
    player = null;
    playerReady = false;
    window.__vellumPlayer = null;
    playerCreatedAt = 0;
    didPlay = false;
    qualityAppliedForThisLoad = false;
    appliedQuality = null;
    lastProgressAt = now;
    lastProgressTime = -1;

    // YT.Player replaces its mount point while booting, so build a brand new
    // one instead of trusting a node that may already be detached.
    try {
      if (!playerFrame || !playerFrame.isConnected) {
        playerFrame = document.createElement("div");
        playerFrame.id = "player-frame";
        playerFrame.className = "stage__player";
        stage.appendChild(playerFrame);
      } else {
        playerFrame.textContent = "";
      }
    } catch (error) {
      /* ignore: createPlayer below will report the failure */
    }

    createPlayer();
    renderScreen();
  }

  /**
   * Runs on every poll tick. Detects the three ways an embed goes silent:
   * a player that never becomes ready, a player whose iframe vanished, and
   * playback that stops advancing while it is supposed to be running.
   */
  function guardPlayback() {
    if (!currentVideoId || !desired || playerError) {
      lastProgressAt = Date.now();
      return;
    }
    if (desired.paused) {
      lastProgressAt = Date.now();
      return;
    }

    const now = Date.now();

    if (!playerReady) {
      if (player && now - playerCreatedAt > PLAYER_READY_TIMEOUT_MS) {
        rebuildPlayer("the player never became ready");
      }
      return;
    }

    if (!playerFrameAlive()) {
      rebuildPlayer("the player iframe disappeared");
      return;
    }

    let state = YT_STATE.UNSTARTED;
    let time = -1;
    try {
      state = player.getPlayerState();
      time = Number(player.getCurrentTime());
    } catch (error) {
      rebuildPlayer("the player stopped answering");
      return;
    }

    if (state === YT_STATE.PLAYING && Number.isFinite(time)) {
      if (time !== lastProgressTime) {
        lastProgressTime = time;
        lastProgressAt = now;
        // Frames are moving again: reset the rebuild budget for this load.
        rebuildAttempts = 0;
      } else if (now - lastProgressAt > STALL_TIMEOUT_MS) {
        rebuildPlayer("playback stalled");
      }
      return;
    }

    if (state === YT_STATE.ENDED) return; // the error handler owns this case
    if (now - lastProgressAt > STALL_TIMEOUT_MS) {
      rebuildPlayer("the player stopped advancing");
    }
  }

  // ==========================================================================
  // Player event handlers
  // ==========================================================================

  function onPlayerReady() {
    playerReady = true;
    lastProgressAt = Date.now();
    lastProgressTime = -1;
    log("info", "YouTube player ready.");
    try {
      const iframe = player.getIframe();
      iframe.setAttribute("tabindex", "-1");
      iframe.setAttribute("aria-hidden", "true");
    } catch (error) {
      /* ignore */
    }
    fullApply();
    startPolling();
    renderScreen();
  }

  function onPlayerStateChange(event) {
    const state = event && typeof event.data === "number" ? event.data : null;

    switch (state) {
      case YT_STATE.PLAYING:
        didPlay = true;
        playerError = null;
        playerErrorCode = null;
        applyVolume();
        if (desired && desired.paused) {
          // The panel asked for paused while the player was still loading.
          applyPaused();
          sendReport({ status: "paused" });
        } else {
          sendReport({ status: "playing", error: null });
        }
        if (!qualityAppliedForThisLoad) {
          qualityAppliedForThisLoad = true;
          applyQuality(true);
        }
        syncPlayerInfo();
        renderScreen();
        break;

      case YT_STATE.PAUSED:
        sendReport({ status: "paused" });
        if (desired && !desired.paused) retryPlay();
        syncPlayerInfo();
        renderScreen();
        break;

      case YT_STATE.BUFFERING:
        // A live stream re-buffers from time to time; that is not a new
        // "tuning in". Only a buffer before the first frames is a load phase,
        // otherwise the panel (and the tray) would flash TUNING IN all day.
        sendReport({
          status: desired && desired.paused
            ? "paused"
            : didPlay
              ? "playing"
              : "loading",
        });
        renderScreen();
        break;

      case YT_STATE.ENDED:
        didPlay = false;
        playerError = "The live stream has ended.";
        playerErrorCode = YT_STATE.ENDED;
        sendReport({ status: "error", error: playerError });
        renderScreen();
        break;

      case YT_STATE.CUED:
      case YT_STATE.UNSTARTED:
      default:
        // Nothing to do; a load is already in flight.
        break;
    }
  }

  function onPlayerError(event) {
    const code = event && event.data != null ? event.data : null;
    handlePlayerError(code, null);
  }

  function handlePlayerError(code, thrown) {
    // Errors fired before any stream is loaded (e.g. an empty player) are not
    // something the user can act on; never let them clobber main's state.
    if (!currentVideoId) {
      log("warn", "Ignoring a player error with no stream loaded.");
      return;
    }
    let message;
    if (code != null) {
      message = YT_ERROR_COPY[code] || "YouTube reported a playback error (" + code + ").";
    } else if (thrown && thrown.message) {
      message = thrown.message;
    } else {
      message = "Playback failed for an unknown reason.";
    }
    playerError = message;
    playerErrorCode = code;
    didPlay = false;
    log("error", message);
    sendReport({ status: "error", error: message });
    renderScreen();
  }

  /** Reads title / channel / quality metadata and reports only what changed. */
  function syncPlayerInfo() {
    if (!playerReady || !player || !currentVideoId) return;
    const patch = {};
    try {
      if (typeof player.getVideoData === "function") {
        const data = player.getVideoData();
        if (data) {
          if (typeof data.title === "string" && data.title) patch.title = data.title;
          if (typeof data.author === "string" && data.author) {
            patch.channel = data.author;
          }
        }
      }
      if (typeof player.getAvailableQualityLevels === "function") {
        const levels = player.getAvailableQualityLevels();
        if (Array.isArray(levels) && levels.length) {
          patch.availableQualities = levels.slice();
        }
      }
      if (typeof player.getPlaybackQuality === "function") {
        const quality = player.getPlaybackQuality();
        if (quality && typeof quality === "string") patch.activeQuality = quality;
      }
    } catch (error) {
      return;
    }
    sendReport(patch);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(function () {
      if (playerReady && currentVideoId) syncPlayerInfo();
      guardPlayback();
    }, PLAYER_POLL_MS);
  }

  // ==========================================================================
  // Reporting (only actual changes leave the renderer)
  // ==========================================================================

  function sendReport(patch) {
    if (!patch || typeof patch !== "object") return;
    const outgoing = {};
    let changed = false;
    Object.keys(patch).forEach(function (key) {
      if (!valueEqual(lastReport[key], patch[key])) {
        outgoing[key] = patch[key];
        lastReport[key] = patch[key];
        changed = true;
      }
    });
    if (!changed) return;
    if (Object.prototype.hasOwnProperty.call(outgoing, "status")) {
      lastReportedStatus = outgoing.status;
    }
    bridge.report(outgoing);
  }

  // ==========================================================================
  // State screen
  // ==========================================================================

  function resolveScreenPhase() {
    if (bootError) return "error";
    if (playerError) return "error";
    if (!desired) return "connecting";
    const hasVideo = !!desired.videoId;
    if (desired.status === "error" && !didPlay) return "error";
    if (hasVideo && didPlay) return "hidden";
    if (!hasVideo) {
      if (desired.status === "resolving") return "resolving";
      return "idle";
    }
    if (desired.paused) return "paused";
    return "loading";
  }

  function renderScreen() {
    const phase = resolveScreenPhase();
    screen.dataset.phase = phase;

    if (phase === "hidden") {
      screen.classList.add("screen--hidden");
      return;
    }
    screen.classList.remove("screen--hidden");

    const standalone = !!bridge.standalone;
    let headline = "";
    let detail = "";
    let hint = "";

    switch (phase) {
      case "connecting":
        headline = "Tuning in";
        detail = "Connecting to YouTube.";
        break;

      case "resolving":
        headline = "Tuning in";
        detail = "Finding the live stream.";
        break;

      case "loading":
        headline = "Tuning in";
        detail =
          desired && desired.title ? desired.title : "Buffering the live stream.";
        break;

      case "paused":
        headline = "Paused";
        detail =
          desired && desired.title ? desired.title : "The stream is paused.";
        hint = standalone ? "" : "Press play in the Vellum panel.";
        break;

      case "idle":
        headline = "Nothing on the wall yet";
        detail = standalone
          ? "Open this page with ?video=<YouTube id or URL> to preview a stream."
          : "Choose a live stream from the Vellum panel.";
        hint = standalone ? "" : "The panel lives in the system tray.";
        break;

      case "error":
      default:
        headline = "Signal lost";
        detail =
          playerError ||
          bootError ||
          (desired && desired.error) ||
          "Something went wrong while tuning in.";
        hint = standalone
          ? ""
          : "Reconnect or choose another stream from the Vellum panel.";
        break;
    }

    setText(headlineEl, headline);
    setText(detailEl, detail);
    setText(hintEl, hint);
    hintEl.hidden = !hint;

    previewEl.hidden = !standalone;
    setText(
      previewEl,
      standalone
        ? "Standalone preview — playback controls live in the Vellum panel."
        : ""
    );
  }

  // ==========================================================================
  // YouTube IFrame API bootstrap
  // ==========================================================================

  function loadYouTubeApi() {
    if (window.YT && typeof window.YT.Player === "function") {
      apiReady = true;
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      let settled = false;
      let timer = 0;

      function finish(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }

      timer = window.setTimeout(function () {
        finish(new Error("Timed out while loading the YouTube player."));
      }, YT_API_TIMEOUT_MS);

      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        try {
          if (typeof previous === "function") previous();
        } catch (error) {
          /* ignore third-party handler failures */
        }
        if (window.YT && typeof window.YT.Player === "function") apiReady = true;
        finish(null);
      };

      const script = document.createElement("script");
      script.src = YT_API_SRC;
      script.async = true;
      script.onerror = function () {
        finish(new Error("Could not reach YouTube."));
      };
      document.head.appendChild(script);
    });
  }

  function startPlayer() {
    if (apiReady || apiAttempts >= MAX_API_ATTEMPTS) return;
    apiAttempts += 1;
    bootError = null;
    renderScreen();

    loadYouTubeApi()
      .then(function () {
        apiReady = true;
        bootError = null;
        log("info", "YouTube IFrame API ready.");
        // Only build the player when a stream is actually wanted; an empty
        // embed can make YouTube answer with a configuration error.
        if (desired && desired.videoId) createPlayer();
        renderScreen();
      })
      .catch(function (error) {
        apiReady = false;
        bootError =
          error && error.message ? error.message : "Could not reach YouTube.";
        log("error", bootError);
        renderScreen();
        sendReport({
          status: "error",
          error: "The YouTube player could not be loaded. Reconnect to try again.",
        });
      });
  }

  function createPlayer() {
    if (player || !apiReady) return;
    if (!window.YT || typeof window.YT.Player !== "function") {
      bootError = "The YouTube player is unavailable.";
      renderScreen();
      return;
    }

    const playerVars = Object.assign({}, YT_PLAYER_VARS);
    // An embed needs a real origin. Electron often serves renderer files from
    // file://, where no origin exists, so only advertise one over http(s).
    if (/^https?:$/.test(window.location.protocol)) {
      playerVars.origin = window.location.origin;
    }

    playerCreatedAt = Date.now();
    try {
      player = new window.YT.Player(playerFrame, {
        width: "100%",
        height: "100%",
        playerVars: playerVars,
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
      // QA hook: lets integration tests poke the real player object.
      window.__vellumPlayer = player;
      // The watchdog has to run even when this player never becomes ready,
      // so the poll starts here rather than in onPlayerReady.
      startPolling();
    } catch (error) {
      player = null;
      bootError = "The video player could not be created.";
      log(
        "error",
        bootError + (error && error.message ? " " + error.message : "")
      );
      renderScreen();
    }
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  function boot() {
    fitStage();
    window.addEventListener("resize", scheduleFit, { passive: true });
    window.addEventListener("orientationchange", scheduleFit, {
      passive: true,
    });

    // This surface is a wallpaper, not a web page: suppress the stray browser
    // affordances that could ever surface over the video.
    document.addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });
    document.addEventListener("dragstart", function (event) {
      event.preventDefault();
    });
    document.addEventListener("selectstart", function (event) {
      event.preventDefault();
    });

    updateVeil();
    renderScreen();

    bridge.ready();
    bridge.onState(handleDesiredState);

    bridge.getState().then(
      function (state) {
        // A pushed state may already be newer than this initial read.
        if (!desired) handleDesiredState(state);
      },
      function (error) {
        log(
          "error",
          "Could not read the Vellum state: " +
            (error && error.message ? error.message : String(error))
        );
        if (!desired) {
          bootError = "Could not read the Vellum state.";
          renderScreen();
        }
      }
    );

    startPlayer();
  }

  window.addEventListener("beforeunload", function () {
    if (pollTimer) window.clearInterval(pollTimer);
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    if (playerReady && player && typeof player.destroy === "function") {
      try {
        player.destroy();
      } catch (error) {
        /* window is going away */
      }
    }
  });

  boot();
})();
