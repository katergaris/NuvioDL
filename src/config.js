const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  tmdbApiKey: '',
  language: 'it-IT',
  port: 4321,
  concurrentDownloads: 1,
  downloadsPath: './downloads',
  dataPath: './data',
  addons: []
};

let cached = null;

function resolvePaths(cfg) {
  cfg.downloadsPath = path.isAbsolute(cfg.downloadsPath)
    ? cfg.downloadsPath
    : path.join(ROOT, cfg.downloadsPath);
  cfg.dataPath = path.isAbsolute(cfg.dataPath)
    ? cfg.dataPath
    : path.join(ROOT, cfg.dataPath);
  return cfg;
}

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

  const cfg = resolvePaths({ ...DEFAULTS, ...raw, addons: raw.addons || [] });

  fs.mkdirSync(cfg.downloadsPath, { recursive: true });
  fs.mkdirSync(cfg.dataPath, { recursive: true });

  cached = cfg;
  if (!fs.existsSync(CONFIG_PATH)) save(cfg);
  return cfg;
}

function save(cfg) {
  cached = cfg;
  const toWrite = { ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2));
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

module.exports = { get, save, listAddons, addAddon, removeAddon, CONFIG_PATH };
