/* Vellum panel renderer — vanilla JS, no dependencies.
   Talks to the Electron preload bridge (window.vellum). Falls back to a
   self-contained mock when loaded with ?mock=1 (or outside Electron). */

(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var QUALITY_LABELS = {
    auto: "Auto",
    default: "Auto",
    highres: "2160p",
    hd2880: "2880p",
    hd2160: "2160p",
    hd1440: "1440p",
    hd1080: "1080p",
    hd720: "720p",
    large: "480p",
    medium: "360p",
    small: "240p",
    tiny: "144p"
  };

  var QUALITY_RANK = {
    hd2880: 2880,
    hd2160: 2160,
    highres: 2160,
    hd1440: 1440,
    hd1080: 1080,
    hd720: 720,
    large: 480,
    medium: 360,
    small: 240,
    tiny: 144
  };

  var MOCK_ORDER = ["playing", "paused", "loading", "error", "idle", "unattached"];

  var dom = {
    card: $("card"),
    statusPill: $("statusPill"),
    statusLabel: $("statusLabel"),
    settingsBtn: $("settingsBtn"),
    hideBtn: $("hideBtn"),
    panelBody: $("panelBody"),
    thumb: $("thumb"),
    badge: $("badge"),
    badgeText: $("badgeText"),
    mediaQuality: $("mediaQuality"),
    mediaCaption: $("mediaCaption"),
    eyebrow: $("eyebrow"),
    eyebrowNote: $("eyebrowNote"),
    title: $("title"),
    channel: $("channel"),
    qualityMeta: $("qualityMeta"),
    notice: $("notice"),
    noticeText: $("noticeText"),
    noticeAction: $("noticeAction"),
    playBtn: $("playBtn"),
    transportLabel: $("transportLabel"),
    transportSub: $("transportSub"),
    reconnectBtn: $("reconnectBtn"),
    muteBtn: $("muteBtn"),
    volume: $("volume"),
    volumeValue: $("volumeValue"),
    qualityChips: $("qualityChips"),
    qualityHint: $("qualityHint"),
    streamToggle: $("streamToggle"),
    streamForm: $("streamForm"),
    streamInput: $("streamInput"),
    applyBtn: $("applyBtn"),
    streamNote: $("streamNote"),
    streamCurrent: $("streamCurrent"),
    attach: $("attach"),
    attachText: $("attachText"),
    footVersion: $("footVersion"),
    settingsPopover: $("settingsPopover"),
    settingsClose: $("settingsClose"),
    veilSwitch: $("veilSwitch"),
    loginSwitch: $("loginSwitch"),
    autoPlaySwitch: $("autoPlaySwitch"),
    appInfo: $("appInfo"),
    mockChip: $("mockChip")
  };

  var state = null;
  var appInfo = null;
  var params = new URLSearchParams(window.location.search);
  var forceMock = params.get("mock") === "1";
  var startScenario = params.get("scenario");
  var nativeApi = window.vellum && typeof window.vellum.getState === "function" ? window.vellum : null;
  var usingMock = forceMock || !nativeApi;
  var mockApi = usingMock ? createMockApi(startScenario) : null;
  var api = usingMock ? mockApi : nativeApi;
  var unsubscribe = null;

  var ui = {
    optionsKey: "",
    chipEls: [],
    streamOpen: false,
    streamSubmitting: false,
    popoverOpen: false,
    popoverReturnFocus: null,
    volumeTimer: null,
    reconnectTimer: null,
    hideTimer: null,
    notice: null,
    noticeTimer: null,
    lastThumbVideoId: null
  };

  /* ------------------------------------------------------------------ */
  /* utilities                                                          */
  /* ------------------------------------------------------------------ */

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function call(name, args) {
    if (!api || typeof api[name] !== "function") {
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve(api[name].apply(api, args || []));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function qualityLabel(raw) {
    if (!raw) return "Auto";
    if (QUALITY_LABELS[raw]) return QUALITY_LABELS[raw];
    var hd = /^hd([0-9]{3,4})$/.exec(String(raw));
    if (hd) return hd[1] + "p";
    return String(raw);
  }

  function currentQuality(s) {
    var raw = s && s.activeQuality;
    if (!raw) return null;
    var clean = String(raw).toLowerCase();
    if (clean === "unknown" || clean === "default" || clean === "auto") return null;
    return raw;
  }

  function qualityOptions(s) {
    var seen = { Auto: true };
    var options = [{ value: "auto", label: "Auto" }];
    var available = Array.isArray(s.availableQualities) ? s.availableQualities.slice() : [];
    available.sort(function (a, b) {
      return (QUALITY_RANK[b] || 0) - (QUALITY_RANK[a] || 0);
    });
    available.forEach(function (level) {
      if (!level || level === "auto" || level === "default") return;
      var label = qualityLabel(level);
      if (seen[label]) return;
      seen[label] = true;
      options.push({ value: level, label: label });
    });
    var pref = s.quality || "auto";
    if (pref !== "auto" && !seen[qualityLabel(pref)]) {
      options.push({ value: pref, label: qualityLabel(pref) });
    }
    return options;
  }

  function parseVideoId(input) {
    if (!input) return null;
    var value = String(input).trim();
    if (!value) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
    var raw = value.indexOf("://") === -1 ? "https://" + value : value;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return null;
    }
    var host = url.hostname.replace(/^www\./, "").replace(/^m\./, "").replace(/^music\./, "");
    var isYouTube = /^youtube\.com$/.test(host) || /^youtu\.be$/.test(host) || /^youtube-nocookie\.com$/.test(host);
    if (!isYouTube) return null;
    if (host === "youtu.be") {
      var shortId = url.pathname.split("/").filter(Boolean)[0];
      return shortId && /^[A-Za-z0-9_-]{11}$/.test(shortId) ? shortId : null;
    }
    var direct = url.searchParams.get("v");
    if (direct && /^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
    var pathMatch = /\/(?:live|embed|shorts|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (pathMatch) return pathMatch[1];
    return null;
  }

  function validateStream(value) {
    if (!value || !String(value).trim()) {
      return { state: "empty", message: "Paste a live link, or an 11-character video ID." };
    }
    if (String(value).trim().length < 4) {
      return { state: "empty", message: "Paste a live link, or an 11-character video ID." };
    }
    var id = parseVideoId(value);
    if (!id) {
      return { state: "invalid", message: "That does not look like a YouTube link." };
    }
    return { state: "valid", id: id, message: "Looks right. Press Enter to tune in." };
  }

  function compactUrl(url) {
    if (!url) return "youtube.com";
    var text = String(url).replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (text.length > 30) text = text.slice(0, 29) + "\u2026";
    return text;
  }

  function flashNotice(text, ms) {
    ui.notice = text;
    if (ui.noticeTimer) clearTimeout(ui.noticeTimer);
    ui.noticeTimer = setTimeout(function () {
      if (ui.notice === text) {
        ui.notice = null;
        render();
      }
    }, ms || 5000);
    render();
  }

  /* ------------------------------------------------------------------ */
  /* render                                                             */
  /* ------------------------------------------------------------------ */

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function render() {
    if (!state) {
      if (ui.notice) {
        dom.notice.hidden = false;
        setText(dom.noticeText, ui.notice);
      }
      return;
    }

    var s = state;
    var status = s.status || "idle";
    var busy = status === "resolving" || status === "loading";
    var paused = status === "paused" || (status === "playing" && !!s.paused) || (busy && !!s.paused);
    var hasVideo = !!s.videoId;
    var isError = status === "error";
    var isIdle = status === "idle";

    dom.card.dataset.status = status;
    dom.card.dataset.paused = paused ? "true" : "false";
    dom.card.dataset.busy = busy ? "true" : "false";
    dom.card.dataset.hasVideo = hasVideo ? "true" : "false";
    dom.card.dataset.playback =
      status === "playing" && !paused ? "playing" : paused ? "paused" : status;

    /* header status */
    var tones = {
      idle: ["Standby", "idle"],
      resolving: ["Finding stream", "tune"],
      loading: ["Tuning in", "tune"],
      playing: ["Live", "live"],
      paused: ["Paused", "hold"],
      error: ["Offline", "off"]
    };
    var tone = tones[status] || tones.idle;
    if (paused && status !== "idle" && status !== "error") tone = ["Paused", "hold"];
    setText(dom.statusLabel, tone[0]);
    setAttr(dom.statusPill, "data-tone", tone[1]);

    /* media chrome */
    var badgeText = {
      idle: "No signal",
      resolving: "Finding",
      loading: "Tuning",
      playing: paused ? "Paused" : "Live",
      paused: "Paused",
      error: "Offline"
    };
    setText(dom.badgeText, badgeText[status] || "No signal");
    var nowQuality = currentQuality(s);
    setText(dom.mediaQuality, nowQuality ? qualityLabel(nowQuality) : "");
    dom.mediaQuality.classList.toggle("is-empty", !nowQuality);
    setText(
      dom.mediaCaption,
      hasVideo ? "id " + s.videoId : isIdle ? "select a stream" : isError ? "no signal" : "standing by"
    );

    /* editorial header */
    var eyebrow = {
      idle: "No stream",
      resolving: "Finding stream",
      loading: "Tuning in",
      playing: "Now playing",
      paused: "Now playing",
      error: "Interrupted"
    };
    var note = {
      idle: "resting",
      resolving: "resolving link",
      loading: "buffering",
      playing: paused ? "on hold" : "live now",
      paused: "on hold",
      error: "connection lost"
    };
    setText(dom.eyebrow, eyebrow[status] || "Now playing");
    setText(dom.eyebrowNote, note[status] || "standing by");

    /* title + byline */
    var title = (s.title || "").trim();
    var placeholder = null;
    if (!title) {
      if (isIdle) placeholder = "A quiet place to watch.";
      else if (isError) placeholder = "The stream slipped away.";
      else if (busy) placeholder = "Tuning in\u2026";
      else placeholder = "Untitled stream";
    }
    setText(dom.title, title || placeholder);
    dom.title.classList.toggle("is-placeholder", !title);
    setText(dom.channel, s.channel || (isIdle ? "No stream selected" : "YouTube live"));
    setText(
      dom.qualityMeta,
      busy
        ? "Connecting"
        : nowQuality
          ? qualityLabel(nowQuality) + " video"
          : s.quality && s.quality !== "auto"
            ? qualityLabel(s.quality) + " video"
            : "Auto quality"
    );

    /* play / transport */
    var transportLabels = {
      idle: "Standby",
      resolving: "Finding stream",
      loading: "Tuning in",
      playing: paused ? "Paused" : "Playing",
      paused: "Paused",
      error: "Offline"
    };
    setText(dom.transportLabel, transportLabels[status] || "Standby");
    setText(
      dom.transportSub,
      isIdle
        ? s.url
          ? "Desktop untouched \u2014 press play"
          : "Add a stream to begin"
        : s.attached
          ? isError
            ? "Waiting on the desktop"
            : "On your wallpaper"
          : "Not attached to the desktop"
    );
    setAttr(dom.playBtn, "aria-label", isIdle ? (s.url ? "Start stream" : "Add a stream") : paused ? "Play" : "Pause");
    setAttr(dom.playBtn, "aria-pressed", paused ? "false" : "true");
    setAttr(dom.playBtn, "aria-busy", busy ? "true" : "false");
    dom.playBtn.disabled = false;

    /* volume */
    var volume = clamp(Math.round(Number(s.volume) || 0), 0, 100);
    if (document.activeElement !== dom.volume) dom.volume.value = String(volume);
    dom.volume.style.setProperty("--fill", volume + "%");
    dom.volume.classList.toggle("is-muted", !!s.muted);
    dom.volume.setAttribute("aria-valuetext", volume + " percent");
    setText(dom.volumeValue, String(volume));
    dom.muteBtn.classList.toggle("is-muted", !!s.muted);
    setAttr(dom.muteBtn, "aria-pressed", s.muted ? "true" : "false");
    setAttr(dom.muteBtn, "aria-label", s.muted ? "Unmute" : "Mute");

    /* quality */
    renderQuality(s);

    /* settings switches */
    setAttr(dom.veilSwitch, "aria-checked", s.veil ? "true" : "false");
    setAttr(dom.loginSwitch, "aria-checked", s.launchAtLogin ? "true" : "false");
    setAttr(dom.autoPlaySwitch, "aria-checked", s.autoPlay === false ? "false" : "true");

    /* attachment + version. Idle/error means the desktop is deliberately clear,
       which is not a failure. */
    var desktopClear = !s.attached && (isIdle || isError);
    setAttr(dom.attach, "data-ok", s.attached ? "true" : desktopClear ? "idle" : "false");
    setText(dom.attachText, s.attached ? "Attached" : desktopClear ? "Desktop clear" : "Not attached");
    setText(dom.footVersion, appInfo && appInfo.version ? "v" + appInfo.version : "v1.0.1");

    /* stream shortcut */
    setText(dom.streamCurrent, compactUrl(s.url));

    /* notice */
    var noticeText = isError && s.error ? s.error : ui.notice;
    if (noticeText) {
      setText(dom.noticeText, noticeText);
      dom.notice.hidden = false;
      var showAction = isError && !!s.error;
      dom.noticeAction.hidden = !showAction;
      if (showAction) setText(dom.noticeAction, "Reconnect");
    } else {
      dom.notice.hidden = true;
    }

    /* thumbnail */
    updateThumb(s);
  }

  function renderQuality(s) {
    var options = qualityOptions(s);
    var key = options
      .map(function (option) {
        return option.value + ":" + option.label;
      })
      .join("|");

    if (key !== ui.optionsKey) {
      ui.optionsKey = key;
      buildChips(options);
    }

    var pref = s.quality || "auto";
    var nowQuality = currentQuality(s);
    var selectedFound = false;
    ui.chipEls.forEach(function (chip) {
      var selected = chip.dataset.value === pref;
      if (selected) selectedFound = true;
      chip.classList.toggle("is-selected", selected);
      setAttr(chip, "aria-checked", selected ? "true" : "false");
      chip.tabIndex = selected ? 0 : -1;
    });
    if (!selectedFound && ui.chipEls.length) {
      ui.chipEls[0].tabIndex = 0;
    }

    var hint;
    if (busyStatus(s)) hint = "Reading available levels\u2026";
    else if (!s.availableQualities || !s.availableQualities.length) {
      hint = pref === "auto" ? "Adapts to the stream" : "Preferred " + qualityLabel(pref);
    } else if (pref === "auto") {
      hint = nowQuality ? "Auto \u00b7 now " + qualityLabel(nowQuality) : "Adapts to the stream";
    } else if (nowQuality && qualityLabel(nowQuality) !== qualityLabel(pref)) {
      // The stream may cap below the requested level (YouTube falls back to the
      // best level it can actually send). Say what is really happening instead
      // of claiming the requested level is locked in.
      hint = "Requesting " + qualityLabel(pref) + " · stream sends " + qualityLabel(nowQuality);
    } else {
      hint = "Locked to " + qualityLabel(pref);
    }
    setText(dom.qualityHint, hint);
  }

  function busyStatus(s) {
    return s.status === "resolving" || s.status === "loading";
  }

  function buildChips(options) {
    dom.qualityChips.textContent = "";
    ui.chipEls = [];
    options.forEach(function (option) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.value = option.value;
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", "false");
      chip.tabIndex = -1;
      chip.textContent = option.label;
      chip.addEventListener("click", function () {
        chooseQuality(option.value);
      });
      chip.addEventListener("keydown", onChipKeydown);
      dom.qualityChips.appendChild(chip);
      ui.chipEls.push(chip);
    });
  }

  function onChipKeydown(event) {
    var keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (keys.indexOf(event.key) === -1) return;
    event.preventDefault();
    var chips = ui.chipEls;
    if (!chips.length) return;
    var current = chips.indexOf(document.activeElement);
    if (current === -1) current = 0;
    var next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % chips.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + chips.length) % chips.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = chips.length - 1;
    var chip = chips[next];
    if (!chip) return;
    chooseQuality(chip.dataset.value);
    chip.focus();
  }

  function updateThumb(s) {
    var id = s.videoId;
    if (!id) {
      ui.lastThumbVideoId = null;
      dom.thumb.classList.remove("is-loaded");
      dom.thumb.removeAttribute("src");
      return;
    }
    if (ui.lastThumbVideoId === id) {
      if (s.title) dom.thumb.alt = s.title;
      return;
    }
    ui.lastThumbVideoId = id;
    dom.thumb.classList.remove("is-loaded");
    dom.thumb.alt = s.title ? s.title : "Stream still";
    var attempt = 0;
    dom.thumb.onload = function () {
      dom.thumb.classList.add("is-loaded");
    };
    dom.thumb.onerror = function () {
      if (attempt === 0) {
        attempt = 1;
        dom.thumb.src = "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
      } else {
        dom.thumb.onerror = null;
        dom.thumb.classList.remove("is-loaded");
      }
    };
    dom.thumb.src = "https://i.ytimg.com/vi/" + id + "/maxresdefault.jpg";
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                            */
  /* ------------------------------------------------------------------ */

  function togglePlay() {
    if (!state) return;
    if (state.status === "idle") {
      // Idle means "nothing on the desktop". With a saved link the play button
      // starts that stream (the wallpaper only appears once playback does);
      // without one it opens the stream composer.
      if (state.url) {
        state = Object.assign({}, state, { status: "resolving", paused: false, error: null });
        render();
        call("setPaused", [false]).catch(function () {
          flashNotice("Could not start the stream.");
        });
      } else {
        openStreamForm();
      }
      return;
    }
    if (state.status === "error") {
      reconnect();
      return;
    }
    var paused = state.status === "paused" || !!state.paused;
    var next = !paused;
    var patch = { paused: next };
    if (state.status === "paused" && !next) patch.status = "playing";
    else if (state.status === "playing" && next) patch.status = "paused";
    state = Object.assign({}, state, patch);
    render();
    call("setPaused", [next]).catch(function () {
      flashNotice("Could not change playback.");
    });
  }

  function reconnect() {
    if (!state) return;
    ui.notice = null;
    dom.reconnectBtn.classList.add("is-spinning");
    if (ui.reconnectTimer) clearTimeout(ui.reconnectTimer);
    ui.reconnectTimer = setTimeout(function () {
      dom.reconnectBtn.classList.remove("is-spinning");
    }, 1800);
    call("reconnect").catch(function () {
      flashNotice("Could not reach the stream.");
    });
    render();
  }

  function toggleMute() {
    if (!state) return;
    var next = !state.muted;
    state = Object.assign({}, state, { muted: next });
    render();
    call("setMuted", [next]).catch(function () {
      flashNotice("Could not change the sound.");
    });
  }

  function chooseQuality(value) {
    if (!state || !value) return;
    state = Object.assign({}, state, { quality: value });
    render();
    call("setQuality", [value]).catch(function () {
      flashNotice("Could not change quality.");
    });
  }

  function applySetting(key, value) {
    if (!state) return;
    var patch = {};
    patch[key] = value;
    state = Object.assign({}, state, patch);
    render();
    call("setSetting", [key, value]).catch(function () {
      flashNotice("Could not save that setting.");
    });
  }

  function openStreamForm() {
    if (ui.streamOpen) {
      dom.streamInput.focus();
      return;
    }
    ui.streamOpen = true;
    setAttr(dom.streamToggle, "aria-expanded", "true");
    dom.streamForm.hidden = false;
    dom.card.dataset.stream = "open";
    if (usingMock) dom.mockChip.hidden = true;
    dom.streamInput.value = state && state.url ? state.url : "";
    validateStreamInput();
    window.requestAnimationFrame(function () {
      dom.streamInput.focus();
      dom.streamInput.select();
    });
  }

  function closeStreamForm(restoreFocus) {
    if (!ui.streamOpen) return;
    ui.streamOpen = false;
    setAttr(dom.streamToggle, "aria-expanded", "false");
    dom.streamForm.hidden = true;
    dom.card.dataset.stream = "closed";
    if (usingMock) dom.mockChip.hidden = false;
    setStreamNote("Paste a live link, or an 11-character video ID.", "");
    dom.streamInput.classList.remove("is-invalid", "is-valid");
    if (restoreFocus) dom.streamToggle.focus();
  }

  function setStreamNote(text, tone) {
    setText(dom.streamNote, text);
    if (tone) dom.streamNote.setAttribute("data-tone", tone);
    else dom.streamNote.removeAttribute("data-tone");
  }

  function validateStreamInput() {
    var value = dom.streamInput.value;
    var result = validateStream(value);
    dom.streamInput.classList.toggle("is-invalid", result.state === "invalid");
    dom.streamInput.classList.toggle("is-valid", result.state === "valid");
    if (result.state === "invalid") setStreamNote(result.message, "invalid");
    else if (result.state === "valid") setStreamNote(result.message, "valid");
    else setStreamNote("Paste a live link, or an 11-character video ID.", "");
    return result;
  }

  function submitStream() {
    if (ui.streamSubmitting) return;
    var result = validateStreamInput();
    if (result.state !== "valid") {
      if (result.state === "invalid") dom.streamInput.focus();
      return;
    }
    ui.streamSubmitting = true;
    dom.applyBtn.disabled = true;
    setText(dom.applyBtn, "Tuning");
    setStreamNote("Tuning in. The wallpaper will follow.", "busy");
    call("loadStream", [dom.streamInput.value.trim()])
      .then(function (response) {
        ui.streamSubmitting = false;
        dom.applyBtn.disabled = false;
        setText(dom.applyBtn, "Tune in");
        if (response && response.ok === false) {
          setStreamNote(response.error || "That stream did not load. Try another link.", "invalid");
          dom.streamInput.classList.add("is-invalid");
          return;
        }
        closeStreamForm(true);
      })
      .catch(function () {
        ui.streamSubmitting = false;
        dom.applyBtn.disabled = false;
        setText(dom.applyBtn, "Tune in");
        setStreamNote("The app shell did not answer. Try again.", "invalid");
      });
  }

  function openPopover() {
    if (ui.popoverOpen) return;
    ui.popoverOpen = true;
    ui.popoverReturnFocus = document.activeElement;
    dom.settingsPopover.hidden = false;
    setAttr(dom.settingsBtn, "aria-expanded", "true");
    updateAppInfo();
    window.requestAnimationFrame(function () {
      dom.veilSwitch.focus();
    });
  }

  function closePopover(restoreFocus) {
    if (!ui.popoverOpen) return;
    ui.popoverOpen = false;
    dom.settingsPopover.hidden = true;
    setAttr(dom.settingsBtn, "aria-expanded", "false");
    if (restoreFocus) {
      var target = ui.popoverReturnFocus && document.contains(ui.popoverReturnFocus) ? ui.popoverReturnFocus : dom.settingsBtn;
      target.focus();
    }
  }

  function updateAppInfo() {
    if (!appInfo) {
      setText(dom.appInfo, "Vellum");
      return;
    }
    var text = "Vellum " + (appInfo.version || "");
    if (appInfo.electron) text += " \u00b7 Electron " + appInfo.electron;
    setText(dom.appInfo, text);
  }

  function toggleVisibilityPreview() {
    dom.card.classList.remove("is-shown");
    dom.card.classList.add("is-hidden");
    if (ui.hideTimer) clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(function () {
      dom.card.classList.remove("is-hidden");
      void dom.card.offsetWidth;
      dom.card.classList.add("is-shown");
      flashNotice("Preview: the panel hides to the tray in the real app.", 2600);
    }, 1500);
  }

  function hidePanel() {
    ui.notice = null;
    closePopover(false);
    if (usingMock) {
      toggleVisibilityPreview();
      return;
    }
    call("hidePanel").catch(function () {
      flashNotice("Could not hide the panel.");
    });
  }

  function cycleMock() {
    if (!mockApi) return;
    var index = MOCK_ORDER.indexOf(mockApi.__scenario);
    var next = MOCK_ORDER[(index + 1) % MOCK_ORDER.length];
    mockApi.__setScenario(next);
    updateMockChip();
  }

  function updateMockChip() {
    if (!usingMock || !mockApi) return;
    dom.mockChip.hidden = false;
    setText(dom.mockChip, "Mock \u00b7 " + mockApi.__scenario);
    setAttr(dom.mockChip, "aria-label", "Preview state: " + mockApi.__scenario + ". Activate for the next state.");
  }

  /* ------------------------------------------------------------------ */
  /* mock bridge                                                        */
  /* ------------------------------------------------------------------ */

  function mockState(name) {
    var base = {
      url: "",
      videoId: null,
      title: "",
      channel: "",
      status: "idle",
      paused: false,
      quality: "auto",
      availableQualities: [],
      activeQuality: null,
      volume: 62,
      muted: false,
      veil: true,
      launchAtLogin: true,
      autoPlay: true,
      attached: true,
      error: null,
      panelVisible: true,
      updatedAt: Date.now()
    };
    var stream = {
      url: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
      videoId: "jfKfPfyJRdk",
      title: "lofi hip hop radio \u2014 beats to relax / study to",
      channel: "Lofi Girl",
      quality: "auto",
      availableQualities: ["hd1080", "hd720", "large", "medium"],
      activeQuality: "hd1080"
    };
    var playing = Object.assign({}, base, stream, { status: "playing", paused: false });
    if (name === "playing") return playing;
    if (name === "paused") return Object.assign({}, playing, { status: "paused", paused: true });
    if (name === "loading") {
      return Object.assign({}, playing, {
        status: "loading",
        paused: false,
        title: "lofi hip hop radio \u2014 beats to relax / study to",
        activeQuality: "hd720"
      });
    }
    if (name === "error") {
      return Object.assign({}, playing, {
        status: "error",
        paused: false,
        activeQuality: null,
        error: "YouTube stopped answering. The stream may be offline or embed-restricted."
      });
    }
    if (name === "unattached") return Object.assign({}, playing, { attached: false });
    return base;
  }

  function createMockApi(startName) {
    var scenarioName = MOCK_ORDER.indexOf(startName) >= 0 ? startName : "playing";
    var current = mockState(scenarioName);
    var subscribers = [];
    var timers = [];

    function clearTimers() {
      timers.forEach(function (timer) {
        clearTimeout(timer);
      });
      timers.length = 0;
    }

    function later(fn, ms) {
      timers.push(setTimeout(fn, ms));
    }

    function notify() {
      var snapshot = clone(current);
      subscribers.slice().forEach(function (fn) {
        try {
          fn(snapshot);
        } catch (err) {
          console.error(err);
        }
      });
    }

    function emit(patch) {
      current = Object.assign({}, current, patch, { updatedAt: Date.now() });
      notify();
    }

    function resolveStream(input) {
      var id = parseVideoId(input);
      if (!id) return Promise.resolve({ ok: false, error: "That does not look like a YouTube link." });
      clearTimers();
      emit({
        url: String(input).trim(),
        videoId: id,
        title: "",
        channel: "",
        status: "resolving",
        paused: false,
        error: null,
        activeQuality: null
      });
      later(function () {
        emit({ status: "loading", title: "Tuning in to a live stream\u2026", channel: "YouTube" });
      }, 650);
      later(function () {
        var known = id === "jfKfPfyJRdk";
        emit({
          status: "playing",
          paused: false,
          url: "https://www.youtube.com/watch?v=" + id,
          videoId: id,
          title: known ? "lofi hip hop radio \u2014 beats to relax / study to" : "Live from YouTube",
          channel: known ? "Lofi Girl" : "YouTube live",
          quality: "auto",
          availableQualities: ["hd1080", "hd720", "large", "medium"],
          activeQuality: "hd1080",
          error: null
        });
      }, 1900);
      return Promise.resolve({ ok: true });
    }

    var apiMock = {
      __scenario: scenarioName,
      __setScenario: function (name) {
        clearTimers();
        scenarioName = name;
        apiMock.__scenario = name;
        current = mockState(name);
        current.updatedAt = Date.now();
        notify();
      },
      getState: function () {
        return Promise.resolve(clone(current));
      },
      onState: function (callback) {
        subscribers.push(callback);
        return function () {
          var index = subscribers.indexOf(callback);
          if (index >= 0) subscribers.splice(index, 1);
        };
      },
      setPaused: function (paused) {
        emit({
          paused: !!paused,
          status: paused ? "paused" : current.videoId ? "playing" : "idle"
        });
        return Promise.resolve();
      },
      setQuality: function (quality) {
        emit({ quality: quality });
        later(function () {
          if (quality === "auto") {
            emit({ activeQuality: "hd1080" });
          } else {
            emit({ activeQuality: quality === "highres" ? "hd2160" : quality });
          }
        }, 320);
        return Promise.resolve();
      },
      setVolume: function (volume) {
        emit({ volume: clamp(Math.round(Number(volume) || 0), 0, 100) });
        return Promise.resolve();
      },
      setMuted: function (muted) {
        emit({ muted: !!muted });
        return Promise.resolve();
      },
      loadStream: function (url) {
        return resolveStream(url);
      },
      reconnect: function () {
        clearTimers();
        if (!current.videoId) return Promise.resolve();
        emit({ status: "loading", error: null, paused: false });
        later(function () {
          emit({
            status: "playing",
            paused: false,
            error: null,
            title: current.title || "Live from YouTube",
            channel: current.channel || "YouTube live",
            availableQualities: current.availableQualities.length ? current.availableQualities : ["hd1080", "hd720", "large", "medium"],
            activeQuality: current.activeQuality || "hd1080"
          });
        }, 1400);
        return Promise.resolve();
      },
      setSetting: function (key, value) {
        var patch = {};
        patch[key] = value;
        emit(patch);
        return Promise.resolve();
      },
      hidePanel: function () {
        return Promise.resolve();
      },
      getAppInfo: function () {
        return Promise.resolve({ version: "1.0.0", platform: "win32", electron: "45.1.0" });
      },
      onPanelShown: function (callback) {
        var handler = function () {
          callback();
        };
        window.addEventListener("focus", handler);
        return function () {
          window.removeEventListener("focus", handler);
        };
      }
    };
    return apiMock;
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    dom.playBtn.addEventListener("click", togglePlay);
    dom.reconnectBtn.addEventListener("click", reconnect);
    dom.noticeAction.addEventListener("click", reconnect);
    dom.muteBtn.addEventListener("click", toggleMute);
    dom.hideBtn.addEventListener("click", hidePanel);
    dom.settingsBtn.addEventListener("click", function () {
      if (ui.popoverOpen) closePopover(true);
      else openPopover();
    });
    dom.settingsClose.addEventListener("click", function () {
      closePopover(true);
    });

    dom.volume.addEventListener("input", function () {
      var value = clamp(Math.round(Number(dom.volume.value) || 0), 0, 100);
      dom.volume.style.setProperty("--fill", value + "%");
      setText(dom.volumeValue, String(value));
      dom.volume.setAttribute("aria-valuetext", value + " percent");
      if (state) state = Object.assign({}, state, { volume: value });
      if (ui.volumeTimer) clearTimeout(ui.volumeTimer);
      ui.volumeTimer = setTimeout(function () {
        call("setVolume", [value]).catch(function () {
          flashNotice("Could not set the volume.");
        });
        if (state && state.muted && value > 0) {
          state = Object.assign({}, state, { muted: false });
          render();
          call("setMuted", [false]).catch(function () {
            /* noop */
          });
        }
      }, 80);
    });

    dom.volume.addEventListener("change", function () {
      var value = clamp(Math.round(Number(dom.volume.value) || 0), 0, 100);
      call("setVolume", [value]).catch(function () {
        flashNotice("Could not set the volume.");
      });
    });

    dom.streamToggle.addEventListener("click", function () {
      if (ui.streamOpen) closeStreamForm(true);
      else openStreamForm();
    });
    dom.streamInput.addEventListener("input", function () {
      if (ui.streamSubmitting) return;
      validateStreamInput();
    });
    dom.streamForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitStream();
    });

    dom.veilSwitch.addEventListener("click", function () {
      applySetting("veil", dom.veilSwitch.getAttribute("aria-checked") !== "true");
    });
    dom.loginSwitch.addEventListener("click", function () {
      applySetting("launchAtLogin", dom.loginSwitch.getAttribute("aria-checked") !== "true");
    });
    dom.autoPlaySwitch.addEventListener("click", function () {
      applySetting("autoPlay", dom.autoPlaySwitch.getAttribute("aria-checked") !== "true");
    });

    document.addEventListener("pointerdown", function (event) {
      if (ui.popoverOpen) {
        if (dom.settingsPopover.contains(event.target) || dom.settingsBtn.contains(event.target)) return;
        closePopover(false);
      }
      if (ui.streamOpen) {
        if (dom.streamForm.contains(event.target) || dom.streamToggle.contains(event.target)) return;
        closeStreamForm(false);
      }
    });

    dom.settingsPopover.addEventListener("keydown", function (event) {
      if (event.key !== "Tab") return;
      var focusable = dom.settingsPopover.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    document.addEventListener("keydown", function (event) {
      var target = event.target;
      var typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (event.key === "Escape") {
        if (ui.popoverOpen) {
          event.preventDefault();
          closePopover(true);
          return;
        }
        if (ui.streamOpen) {
          event.preventDefault();
          closeStreamForm(true);
          return;
        }
        return;
      }

      if (typing) return;

      if (event.key === " " || event.key === "Spacebar") {
        if (target && target.tagName === "BUTTON") return;
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        toggleMute();
      }
    });

    if (usingMock) {
      dom.mockChip.hidden = false;
      dom.mockChip.addEventListener("click", cycleMock);
      updateMockChip();
    }

    window.addEventListener("pagehide", function () {
      if (typeof unsubscribe === "function") unsubscribe();
    });
  }

  function boot() {
    bindEvents();

    if (api && typeof api.onState === "function") {
      try {
        unsubscribe = api.onState(function (next) {
          if (next) {
            state = next;
            render();
          }
        });
      } catch (err) {
        console.error(err);
      }
    }

    if (api && typeof api.onPanelShown === "function") {
      try {
        api.onPanelShown(function () {
          call("getState")
            .then(function (next) {
              if (next) {
                state = next;
                render();
              }
            })
            .catch(function () {
              /* noop */
            });
          dom.card.classList.remove("is-shown");
          void dom.card.offsetWidth;
          dom.card.classList.add("is-shown");
        });
      } catch (err) {
        console.error(err);
      }
    }

    call("getAppInfo")
      .then(function (info) {
        if (info) {
          appInfo = info;
          updateAppInfo();
          render();
        }
      })
      .catch(function () {
        /* app info is optional */
      });

    call("getState")
      .then(function (initial) {
        if (initial) {
          state = initial;
          render();
        }
      })
      .catch(function () {
        flashNotice("Could not reach the app shell. Is the preload bridge loaded?");
      });
  }

  boot();
})();
