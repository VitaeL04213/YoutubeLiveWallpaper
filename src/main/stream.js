'use strict';

/**
 * YouTube link handling. Pure parsing lives here; network metadata resolution
 * uses Electron's net module so it is not subject to page CORS rules.
 */

const { net } = require('electron');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_TIMEOUT_MS = 8000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  if (isVideoId(value)) return value;

  let url = null;
  try {
    url = new URL(value.startsWith('http://') || value.startsWith('https://') ? value : 'https://' + value);
  } catch (_) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return isVideoId(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && !host.endsWith('.youtube.com')) {
    return null;
  }

  const queryId = url.searchParams.get('v');
  if (isVideoId(queryId)) return queryId;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['embed', 'live', 'shorts', 'v', 'watch'].includes(parts[0])) {
    const id = parts[1];
    if (isVideoId(id)) return id;
  }
  return null;
}

async function requestText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  // YouTube occasionally answers a cold request with a 429/5xx or drops the
  // connection during app start; one bounded retry makes first-run reliable.
  let last = { ok: false, status: 0, text: '', error: 'request failed' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await net.fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': CHROME_UA,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) {
        last = { ok: false, status: response.status, text: '' };
        if (response.status < 500 && response.status !== 429) return last;
        continue;
      }
      return { ok: true, status: response.status, text: await response.text() };
    } catch (error) {
      last = { ok: false, status: 0, text: '', error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

async function fetchMetadata(videoId) {
  const watchUrl = 'https://www.youtube.com/watch?v=' + videoId;
  const endpoint =
    'https://www.youtube.com/oembed?url=' + encodeURIComponent(watchUrl) + '&format=json';
  const result = await requestText(endpoint);
  if (!result.ok) return null;
  try {
    const data = JSON.parse(result.text);
    return {
      title: typeof data.title === 'string' ? data.title : '',
      channel: typeof data.author_name === 'string' ? data.author_name : '',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a channel live URL (e.g. /@LofiGirl/live) to the live video id by
 * reading the page HTML. Best effort only; direct video links never need this.
 */
async function resolveChannelLive(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.startsWith('http') ? input : 'https://' + input);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  const page = await requestText(url.toString(), 10000);
  if (!page.ok || !page.text) {
    console.warn('[stream] live page unavailable', url.toString(), page.status, page.error || '');
    return null;
  }
  // The canonical link on a /live page always names the stream itself; the
  // first bare videoId can belong to a recommended tile instead.
  const canonical = page.text.match(
    /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/i
  );
  if (canonical) return canonical[1];
  const match =
    page.text.match(/"videoId":"([A-Za-z0-9_-]{11})"/) ||
    page.text.match(/watch\?v=([A-Za-z0-9_-]{11})/) ||
    page.text.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Resolve any accepted user input to a playable stream description.
 * Returns { ok, videoId, url, title, channel, error }.
 */
async function resolveStream(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, error: 'Paste a YouTube live link first.' };

  let videoId = parseVideoId(raw);
  let channelPage = false;
  if (!videoId) {
    try {
      const probe = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
      channelPage = /(^|\.)youtube\.com$/.test(probe.hostname);
    } catch (_) {
      channelPage = false;
    }
    videoId = await resolveChannelLive(raw);
  }
  if (!videoId) {
    return {
      ok: false,
      error: channelPage
        ? "No live stream was found at that YouTube page. Paste the stream's own watch URL instead."
        : 'That does not look like a YouTube video or live link. Try a watch, live, or youtu.be URL.',
    };
  }

  let meta = null;
  try {
    meta = await fetchMetadata(videoId);
  } catch (_) {
    meta = null;
  }

  return {
    ok: true,
    videoId,
    url: 'https://www.youtube.com/watch?v=' + videoId,
    title: meta && meta.title ? meta.title : '',
    channel: meta && meta.channel ? meta.channel : '',
    error: null,
  };
}

module.exports = { parseVideoId, isVideoId, resolveStream, fetchMetadata };
