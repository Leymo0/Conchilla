// App updates from the Leymo0/Conchilla GitHub releases (electron-updater).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// %APPDATA%\Conchilla\update.log
function updateLog(...parts) {
  try {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ')}\n`;
    const file = path.join(app.getPath('userData'), 'update.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 200_000) fs.writeFileSync(file, '');
    fs.appendFileSync(file, line);
  } catch { /* logging must never break anything */ }
}

let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = {
      info: (...a) => updateLog('info', ...a),
      warn: (...a) => updateLog('warn', ...a),
      error: (...a) => updateLog('error', ...a),
      debug: () => {},
    };
  }
  return autoUpdater;
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkAppUpdate() {
  if (!app.isPackaged) return { available: false, dev: true };
  const result = await getAutoUpdater().checkForUpdates();
  const latest = result?.updateInfo?.version;
  return { available: !!latest && isNewer(latest, app.getVersion()), version: latest };
}

function downloadAppUpdate(onProgress) {
  const u = getAutoUpdater();
  return new Promise((resolve, reject) => {
    const progress = (p) => onProgress?.(`Downloading update… ${Math.floor(p.percent || 0)}%`);
    u.on('download-progress', progress);
    u.once('update-downloaded', () => { u.off('download-progress', progress); resolve(); });
    u.once('error', (err) => { u.off('download-progress', progress); reject(err); });
    u.downloadUpdate().catch(reject);
  });
}

function installAppUpdateAndRestart() {
  // Visible installer: if something is still closing, Windows shows "Retry" instead of failing quietly
  updateLog('installing update');
  getAutoUpdater().quitAndInstall(false, true);
}

module.exports = { updateLog, checkAppUpdate, downloadAppUpdate, installAppUpdateAndRestart };
