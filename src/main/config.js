'use strict';

const fs = require('fs');
const path = require('path');

const QUALITY_LEVELS = [
  'auto',
  'highres',
  'hd2880',
  'hd2160',
  'hd1440',
  'hd1080',
  'hd720',
  'large',
  'medium',
  'small',
  'tiny',
];

const DEFAULT_CONFIG = {
  url: 'https://www.youtube.com/@LofiGirl/live',
  quality: 'auto',
  volume: 60,
  muted: false,
  veil: true,
  launchAtLogin: false,
  autoPlay: true,
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : DEFAULT_CONFIG.url;
  const quality = QUALITY_LEVELS.includes(input.quality) ? input.quality : DEFAULT_CONFIG.quality;
  return {
    url,
    quality,
    volume: clampNumber(input.volume, 0, 100, DEFAULT_CONFIG.volume),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULT_CONFIG.muted,
    veil: typeof input.veil === 'boolean' ? input.veil : DEFAULT_CONFIG.veil,
    launchAtLogin: typeof input.launchAtLogin === 'boolean' ? input.launchAtLogin : DEFAULT_CONFIG.launchAtLogin,
    autoPlay: typeof input.autoPlay === 'boolean' ? input.autoPlay : DEFAULT_CONFIG.autoPlay,
  };
}

function load(file) {
  try {
    // A UTF-8 BOM (some editors and PowerShell add one) breaks JSON.parse;
    // strip it so a hand-edited config is never silently discarded.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return normalize(JSON.parse(text));
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function save(file, config) {
  const clean = normalize(config);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    console.warn('[vellum] could not save config:', error.message);
  }
  return clean;
}

module.exports = { DEFAULT_CONFIG, QUALITY_LEVELS, load, save, normalize };
