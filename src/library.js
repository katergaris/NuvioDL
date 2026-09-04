const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.ts'];

function list(downloadsPath) {
  const entries = fs.readdirSync(downloadsPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map(e => {
      const stat = fs.statSync(path.join(downloadsPath, e.name));
      return {
        filename: e.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function resolveSafe(downloadsPath, filename) {
  const base = path.basename(filename);
  const full = path.resolve(downloadsPath, base);
  if (!full.startsWith(path.resolve(downloadsPath) + path.sep) && full !== path.resolve(downloadsPath)) {
    throw new Error('Percorso non valido');
  }
  return full;
}

function remove(downloadsPath, filename) {
  const full = resolveSafe(downloadsPath, filename);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

module.exports = { list, remove, resolveSafe };
