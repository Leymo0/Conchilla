// Remembers which window had the keyboard (the game) before the chat box opened,
// and hands it back afterwards. Windows only; elsewhere it quietly does nothing.

let user32 = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    user32 = {
      GetForegroundWindow: lib.func('void * __stdcall GetForegroundWindow()'),
      SetForegroundWindow: lib.func('bool __stdcall SetForegroundWindow(void *hWnd)'),
      IsWindow: lib.func('bool __stdcall IsWindow(void *hWnd)'),
      IsIconic: lib.func('bool __stdcall IsIconic(void *hWnd)'),
    };
  } catch (err) {
    console.warn('focus: native helper unavailable', err.message);
  }
}

let previous = null;

function remember() {
  try { previous = user32 ? user32.GetForegroundWindow() : null; } catch { previous = null; }
}

// true when the keyboard went back to the remembered window
function restore() {
  const target = previous;
  previous = null;
  if (!user32 || !target) return false;
  try {
    if (!user32.IsWindow(target) || user32.IsIconic(target)) return false;
    return !!user32.SetForegroundWindow(target);
  } catch {
    return false;
  }
}

module.exports = { remember, restore };
