// Small Windows helpers (via koffi). Elsewhere they quietly do nothing.
//  - remember/restore: give the keyboard back to the game after the chat box closes
//  - pidOfWindow: which program owns a shared window (to record only that app's sound)
//  - discordPid: Discord's main process (to record everything except Discord)

let user32 = null, kernel32 = null, koffi = null, PE = null;
if (process.platform === 'win32') {
  try {
    koffi = require('koffi');
    const u = koffi.load('user32.dll');
    user32 = {
      GetForegroundWindow: u.func('void * __stdcall GetForegroundWindow()'),
      SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(void *hWnd)'),
      IsWindow: u.func('bool __stdcall IsWindow(void *hWnd)'),
      IsIconic: u.func('bool __stdcall IsIconic(void *hWnd)'),
      GetWindowThreadProcessId: u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)'),
    };
    PE = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t',
      dwFlags: 'uint32_t', szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    const k = koffi.load('kernel32.dll');
    kernel32 = {
      CreateToolhelp32Snapshot: k.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
      Process32FirstW: k.func('bool __stdcall Process32FirstW(void *snap, _Inout_ PROCESSENTRY32W *pe)'),
      Process32NextW: k.func('bool __stdcall Process32NextW(void *snap, _Inout_ PROCESSENTRY32W *pe)'),
      CloseHandle: k.func('bool __stdcall CloseHandle(void *h)'),
    };
  } catch (err) {
    console.warn('win32 helpers unavailable:', err.message);
  }
}

// ---------- keyboard focus ----------

let previous = null;
function remember() {
  try { previous = user32 ? user32.GetForegroundWindow() : null; } catch { previous = null; }
}
function restore() {
  const target = previous;
  previous = null;
  if (!user32 || !target) return false;
  try {
    if (!user32.IsWindow(target) || user32.IsIconic(target)) return false;
    return !!user32.SetForegroundWindow(target);
  } catch { return false; }
}

// ---------- processes ----------

// desktopCapturer window ids look like "window:<HWND>:0"
function pidOfWindow(sourceId) {
  const m = /^window:(\d+):/.exec(sourceId || '');
  if (!user32 || !m) return 0;
  try {
    const out = [0];
    user32.GetWindowThreadProcessId(Number(m[1]), out);
    return out[0] || 0;
  } catch { return 0; }
}

function processList() {
  if (!kernel32) return [];
  const TH32CS_SNAPPROCESS = 0x2;
  const snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  const list = [];
  if (!snap || koffi.address(snap) === 0n || koffi.address(snap) === 0xffffffffffffffffn) return list;
  try {
    const pe = { dwSize: koffi.sizeof(PE) };
    if (kernel32.Process32FirstW(snap, pe)) {
      do {
        list.push({ pid: pe.th32ProcessID, parent: pe.th32ParentProcessID, exe: pe.szExeFile });
        pe.dwSize = koffi.sizeof(PE);
      } while (kernel32.Process32NextW(snap, pe));
    }
  } finally {
    kernel32.CloseHandle(snap);
  }
  return list;
}

// The top Discord process (its whole tree — voice included — is left out of the recording)
function discordPid() {
  try {
    const list = processList();
    const isDiscord = (p) => p && /^discord(ptb|canary|development)?\.exe$/i.test(p.exe);
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const root = list.find((p) => isDiscord(p) && !isDiscord(byPid.get(p.parent)));
    return root ? root.pid : 0;
  } catch { return 0; }
}

module.exports = { remember, restore, pidOfWindow, discordPid, processList };
