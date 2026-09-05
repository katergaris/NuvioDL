const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  tmdbApiKey: '',
  language: 'it-IT',
  port: 4321,
  concurrentDownloads: 2,
  addons: []
};

let cached = null;

function load() {
  if (cached) return cached;

  let raw;
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  } else {
    raw = {};
  }

  const cfg = { ...DEFAULTS, ...raw, addons: raw.addons || [] };

  cached = cfg;
  if (!fs.existsSync(CONFIG_PATH)) save(cfg);
  return cfg;
}

function save(cfg) {
  cached = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function get() {
  return load();
}

function listAddons() {
  return load().addons;
}

function addAddon({ name, manifestUrl }) {
  const cfg = load();
  const addon = {
    id: require('crypto').randomUUID(),
    name: String(name).trim(),
    manifestUrl: String(manifestUrl).trim()
  };
  cfg.addons.push(addon);
  save(cfg);
  return addon;
}

function removeAddon(id) {
  const cfg = load();
  const before = cfg.addons.length;
  cfg.addons = cfg.addons.filter(a => a.id !== id);
  save(cfg);
  return cfg.addons.length !== before;
}

function updateSettings({ tmdbApiKey, language, concurrentDownloads }) {
  const cfg = load();
  if (tmdbApiKey !== undefined) cfg.tmdbApiKey = String(tmdbApiKey).trim();
  if (language !== undefined) cfg.language = String(language).trim() || DEFAULTS.language;
  if (concurrentDownloads !== undefined) {
    const n = parseInt(concurrentDownloads, 10);
    if (Number.isFinite(n) && n > 0) cfg.concurrentDownloads = n;
  }
  save(cfg);
  return cfg;
}

module.exports = { get, save, listAddons, addAddon, removeAddon, updateSettings, CONFIG_PATH };
