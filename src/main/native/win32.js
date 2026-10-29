'use strict';

/**
 * Windows desktop-wallpaper integration.
 *
 * There are two Explorer layouts in the wild:
 *  1. Classic (Win10 / early Win11): Progman owns SHELLDLL_DefView and a top-level
 *     WorkerW sits directly below Progman in the z-order. We parent our window to
 *     that WorkerW.
 *  2. Modern (Win11 226xx+): Progman owns SHELLDLL_DefView *and* a visible,
 *     full-screen WorkerW child sits underneath the icon view. We parent to that
 *     child directly.
 *
 * Everything is done through koffi/user32 so the app has no native build step.
 */

const koffi = require('koffi');

let lib = null;
let api = null;

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;

const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;

const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOZORDER = 0x0004;

const GW_HWNDNEXT = 2;
const MIN_WALLPAPER_AREA = 100000;

const callbacks = [];

function load() {
  if (api) return api;

  lib = koffi.load('user32.dll');

  const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');

  api = {
    FindWindowW: lib.func('void * __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
    FindWindowExW: lib.func(
      'void * __stdcall FindWindowExW(void *hWndParent, void *hWndChildAfter, str16 lpszClass, str16 lpszWindow)'
    ),
    EnumWindows: lib.func('int __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
    EnumChildWindows: lib.func('int __stdcall EnumChildWindows(void *hWndParent, void *lpEnumFunc, intptr_t lParam)'),
    GetWindow: lib.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)'),
    GetParent: lib.func('void * __stdcall GetParent(void *hWnd)'),
    GetClassNameW: lib.func('int __stdcall GetClassNameW(void *hWnd, char16_t *lpClassName, int nMaxCount)'),
    GetWindowTextW: lib.func('int __stdcall GetWindowTextW(void *hWnd, char16_t *lpString, int nMaxCount)'),
    GetWindowRect: lib.func('int __stdcall GetWindowRect(void *hWnd, _Out_ int32_t *lpRect)'),
    GetClientRect: lib.func('int __stdcall GetClientRect(void *hWnd, _Out_ int32_t *lpRect)'),
    ClientToScreen: lib.func('int __stdcall ClientToScreen(void *hWnd, _Inout_ int32_t *lpPoint)'),
    IsWindow: lib.func('int __stdcall IsWindow(void *hWnd)'),
    IsWindowVisible: lib.func('int __stdcall IsWindowVisible(void *hWnd)'),
    GetWindowLongPtrW: lib.func('intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)'),
    SetWindowLongPtrW: lib.func('intptr_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)'),
    SetParent: lib.func('void * __stdcall SetParent(void *hWndChild, void *hWndNewParent)'),
    SetWindowPos: lib.func(
      'int __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    ),
    ShowWindow: lib.func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
    SendMessageTimeoutW: lib.func(
      'intptr_t __stdcall SendMessageTimeoutW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t fuFlags, uint32_t uTimeout, void *lpdwResult)'
    ),
    EnumWindowsProc,
  };
  return api;
}

function hwndToString(hwnd) {
  return hwnd ? String(hwnd) : null;
}

function classOf(hwnd) {
  if (!hwnd) return '';
  const { GetClassNameW } = api;
  const buf = koffi.alloc('char16_t', 256);
  const n = GetClassNameW(hwnd, buf, 256);
  return n > 0 ? koffi.decode(buf, 'char16_t', 256) : '';
}

function rectOf(hwnd) {
  if (!hwnd) return null;
  const out = [0, 0, 0, 0];
  if (!api.GetWindowRect(hwnd, out)) return null;
  return { left: out[0], top: out[1], right: out[2], bottom: out[3], width: out[2] - out[0], height: out[3] - out[1] };
}

function titleOf(hwnd) {
  if (!hwnd) return '';
  const buf = koffi.alloc('char16_t', 512);
  const n = api.GetWindowTextW(hwnd, buf, 512);
  return n > 0 ? koffi.decode(buf, 'char16_t', 512) : '';
}

function clientRectOf(hwnd) {
  if (!hwnd) return null;
  const out = [0, 0, 0, 0];
  if (!api.GetClientRect(hwnd, out)) return null;
  return { width: out[2] - out[0], height: out[3] - out[1] };
}

function clientOriginOf(hwnd) {
  if (!hwnd) return null;
  const pt = [0, 0];
  if (!api.ClientToScreen(hwnd, pt)) return null;
  return { x: pt[0], y: pt[1] };
}

/**
 * Window rect in *physical* pixels as seen by this DPI-aware process, together
 * with the client rect and where the client origin lands in screen space.
 */
function geometryOf(hwnd) {
  const win = rectOf(hwnd);
  const client = clientRectOf(hwnd);
  const origin = clientOriginOf(hwnd);
  if (!win || !client || !origin) return null;
  return {
    window: win,
    client,
    clientOrigin: origin,
    insets: {
      left: origin.x - win.left,
      top: origin.y - win.top,
      right: win.right - (origin.x + client.width),
      bottom: win.bottom - (origin.y + client.height),
    },
  };
}

function isLargeVisible(hwnd) {
  if (!hwnd) return false;
  if (!api.IsWindowVisible(hwnd)) return false;
  const r = rectOf(hwnd);
  return !!r && r.width * r.height >= MIN_WALLPAPER_AREA;
}

function collectTopLevel(predicate) {
  load();
  const found = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (predicate(hwnd)) found.push(hwnd);
    } catch (_) {
      /* never let a callback exception cross the FFI boundary */
    }
    return 1;
  }, koffi.pointer(api.EnumWindowsProc));
  callbacks.push(cb);
  try {
    api.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
    const i = callbacks.indexOf(cb);
    if (i >= 0) callbacks.splice(i, 1);
  }
  return found;
}

function collectChildren(hwnd, predicate) {
  load();
  const found = [];
  const cb = koffi.register((child) => {
    try {
      if (predicate(child)) found.push(child);
    } catch (_) {
      /* ignore */
    }
    return 1;
  }, koffi.pointer(api.EnumWindowsProc));
  callbacks.push(cb);
  try {
    api.EnumChildWindows(hwnd, cb, 0);
  } finally {
    koffi.unregister(cb);
    const i = callbacks.indexOf(cb);
    if (i >= 0) callbacks.splice(i, 1);
  }
  return found;
}

function findProgman() {
  return api.FindWindowW('Progman', null) || null;
}

/**
 * Ask Explorer to spawn its wallpaper WorkerW (classic hidden message). Harmless
 * when the window already exists: Explorer returns without creating duplicates.
 */
function ensureWallpaperWorker() {
  const progman = findProgman();
  if (!progman) return;
  try {
    api.SendMessageTimeoutW(progman, 0x052c, 0, 0, 0, 1000, null);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Return the HWND that should act as the parent for our wallpaper window.
 */
function findWallpaperHost() {
  load();
  const progman = findProgman();

  // Modern Win11: a large visible WorkerW child of Progman, underneath DefView.
  if (progman) {
    const childWorkers = collectChildren(progman, (h) => classOf(h) === 'WorkerW' && isLargeVisible(h));
    if (childWorkers.length) {
      // Prefer the lowest one in z-order (the last valid child), that is the
      // actual wallpaper surface; DefView/icons live above it.
      return childWorkers[childWorkers.length - 1];
    }
  }

  // Classic: find a top-level worker that is a sibling right after the window
  // which hosts SHELLDLL_DefView.
  const defViewHosts = collectTopLevel((h) => !!api.FindWindowExW(h, null, 'SHELLDLL_DefView', null));
  for (const host of defViewHosts) {
    // The wallpaper WorkerW is the next top-level WorkerW below the icon host.
    let candidate = api.FindWindowExW(null, host, 'WorkerW', null);
    while (candidate) {
      if (isLargeVisible(candidate)) return candidate;
      candidate = api.FindWindowExW(null, candidate, 'WorkerW', null);
    }
  }

  // Last resort: any large visible top-level WorkerW that does not host icons.
  const topWorkers = collectTopLevel(
    (h) => classOf(h) === 'WorkerW' && isLargeVisible(h) && !api.FindWindowExW(h, null, 'SHELLDLL_DefView', null)
  );
  if (topWorkers.length) return topWorkers[topWorkers.length - 1];

  return null;
}

/**
 * Make the window's *client* area cover the screen exactly.
 *
 * Chromium windows carry an invisible DWM frame (rounded corners, resize
 * border). The window rect is therefore a few physical pixels larger than the
 * content Chromium paints into, which would leave a strip of the previous
 * wallpaper visible along the screen edges. We measure the insets and then
 * offset/oversize the window so the client area is anchored at the parent's
 * (0,0) and is exactly targetW x targetH physical pixels.
 */
function fitClientToScreen(hwnd, targetW, targetH) {
  let geo = geometryOf(hwnd);
  if (!geo) return null;
  for (let pass = 0; pass < 3; pass += 1) {
    const { insets, client, window: win } = geo;
    const wantX = -insets.left;
    const wantY = -insets.top;
    const wantW = targetW + insets.left + insets.right;
    const wantH = targetH + insets.top + insets.bottom;
    if (win.left === wantX && win.top === wantY && win.width === wantW && win.height === wantH) break;
    api.SetWindowPos(hwnd, null, wantX, wantY, wantW, wantH, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    geo = geometryOf(hwnd);
    if (!geo) break;
    if (geo.client.width === targetW && geo.client.height === targetH && geo.insets.left === insets.left) break;
  }
  return geo;
}

let lastHost = null;

/**
 * Parent a native window to the desktop wallpaper surface.
 * @param {Buffer|bigint|number|string} handle native window handle (Buffer from Electron)
 * @param {number} width physical pixel width
 * @param {number} height physical pixel height
 */
function attachWindow(handle, width, height) {
  load();
  const hwnd = toHwnd(handle);
  if (!hwnd) return { ok: false, error: 'No native window handle', host: null };

  ensureWallpaperWorker();

  let host = findWallpaperHost();
  if (!host) {
    ensureWallpaperWorker();
    host = findWallpaperHost();
  }
  if (!host) {
    return { ok: false, error: 'Could not find Explorer wallpaper surface (WorkerW)', host: null };
  }

  const previousParent = api.SetParent(hwnd, host);

  // Convert the Chromium top-level window into a plain child window.
  let style = Number(api.GetWindowLongPtrW(hwnd, GWL_STYLE) || 0);
  style &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
  style |= WS_CHILD;
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, style);

  let exStyle = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) || 0);
  exStyle &= ~WS_EX_APPWINDOW;
  exStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  const targetW = Math.round(width);
  const targetH = Math.round(height);
  api.SetWindowPos(hwnd, null, 0, 0, targetW, targetH, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  // The DWM frame can make the client area smaller than the window, so measure
  // and compensate until the client covers the monitor exactly.
  const geo = fitClientToScreen(hwnd, targetW, targetH);
  api.ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);

  const parent = api.GetParent(hwnd);
  const ok = parent === host;
  lastHost = host;
  if (!ok) {
    return {
      ok: false,
      error: 'SetParent did not stick (Explorer may be restarting)',
      host: hwndToString(host),
      previousParent: hwndToString(previousParent),
    };
  }
  return {
    ok: true,
    host: hwndToString(host),
    error: null,
    geometry: geo
      ? {
          target: { width: targetW, height: targetH },
          client: geo.client,
          clientOrigin: geo.clientOrigin,
          insets: geo.insets,
        }
      : null,
  };
}

function toHwnd(handle) {
  if (!handle) return null;
  if (Buffer.isBuffer(handle)) return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  if (typeof handle === 'bigint') return handle;
  if (typeof handle === 'number') return BigInt(Math.trunc(handle));
  if (typeof handle === 'string') return BigInt(handle);
  return null;
}

function isAttached(handle) {
  load();
  const hwnd = toHwnd(handle);
  if (!hwnd || !api.IsWindow(hwnd)) return false;
  const parent = api.GetParent(hwnd);
  if (!parent) return false;
  return classOf(parent) === 'WorkerW';
}

function isWindow(handle) {
  load();
  const hwnd = toHwnd(handle);
  return !!hwnd && !!api.IsWindow(hwnd);
}

function parentOf(handle) {
  load();
  const hwnd = toHwnd(handle);
  if (!hwnd) return null;
  return hwndToString(api.GetParent(hwnd));
}

function hostInfo() {
  load();
  const host = findWallpaperHost();
  return host
    ? { handle: hwndToString(host), class: classOf(host), rect: rectOf(host), parent: hwndToString(api.GetParent(host)) }
    : null;
}


function detachWindow(handle) {
  load();
  const hwnd = toHwnd(handle);
  if (!hwnd || !api.IsWindow(hwnd)) return false;
  api.SetParent(hwnd, null);
  return true;
}

module.exports = {
  load,
  findWallpaperHost,
  hostInfo,
  attachWindow,
  detachWindow,
  isAttached,
  isWindow,
  parentOf,
  toHwnd,
  titleOf,
  geometryOf,
  collectTopLevel,
  collectChildren,
};