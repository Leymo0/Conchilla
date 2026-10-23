// conchilla-keys: notices a TAP of a lone modifier key (e.g. Right Shift) anywhere in Windows,
// including inside games. Windows' normal hotkeys can't use a modifier on its own.
//
//   conchilla-keys.exe RShift[,RCtrl,...]
//
// Prints "TAP <name>" on stdout when the key is pressed and released by itself (no other key
// in between, within 0.6 s). The key is NOT blocked: games still see it.
// Exits when stdin closes (Conchilla quit).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <cwchar>

struct Watched { const wchar_t *name; const char *out; DWORD vk; bool held; bool armed; DWORD since; };
static Watched g_keys[] = {
  {L"RShift", "RShift", VK_RSHIFT, false, false, 0},
  {L"RCtrl", "RCtrl", VK_RCONTROL, false, false, 0},
  {L"LShift", "LShift", VK_LSHIFT, false, false, 0},
  {L"LCtrl", "LCtrl", VK_LCONTROL, false, false, 0},
};
static bool g_on[sizeof(g_keys) / sizeof(g_keys[0])] = {};
static DWORD g_mainThread = 0;

static LRESULT CALLBACK onKey(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION) {
    const KBDLLHOOKSTRUCT *k = reinterpret_cast<KBDLLHOOKSTRUCT *>(lp);
    const bool down = wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
    const bool up = wp == WM_KEYUP || wp == WM_SYSKEYUP;
    int hit = -1;
    for (int i = 0; i < (int)(sizeof(g_keys) / sizeof(g_keys[0])); i++) if (g_on[i] && g_keys[i].vk == k->vkCode) hit = i;
    if (down) {
      if (hit >= 0) {
        Watched &w = g_keys[hit];
        if (!w.held) { w.held = true; w.armed = true; w.since = k->time; }   // ignore auto-repeat
      } else {
        for (auto &w : g_keys) w.armed = false;                              // it's a combo, not a tap
      }
      // another watched key pressed while one is held: no tap either
      if (hit >= 0) for (int i = 0; i < (int)(sizeof(g_keys) / sizeof(g_keys[0])); i++) if (i != hit && g_keys[i].held) { g_keys[i].armed = false; g_keys[hit].armed = false; }
    } else if (up && hit >= 0) {
      Watched &w = g_keys[hit];
      if (w.armed && k->time - w.since < 600) {
        printf("TAP %s\n", w.out);
        fflush(stdout);
      }
      w.held = false;
      w.armed = false;
    }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  DWORD n;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, buf, sizeof buf, &n, nullptr) && n > 0) {}
  PostThreadMessageW(g_mainThread, WM_QUIT, 0, 0);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: conchilla-keys RShift[,RCtrl,LShift,LCtrl]\n");
    return 2;
  }
  int count = 0;
  for (int i = 0; i < (int)(sizeof(g_keys) / sizeof(g_keys[0])); i++) {
    if (wcsstr(argv[1], g_keys[i].name)) { g_on[i] = true; count++; }
  }
  if (!count) { fprintf(stderr, "ERR no-keys\n"); return 2; }

  g_mainThread = GetCurrentThreadId();
  HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, onKey, GetModuleHandleW(nullptr), 0);
  if (!hook) { fprintf(stderr, "ERR hook %lu\n", GetLastError()); return 1; }
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);
  fprintf(stderr, "READY\n");
  fflush(stderr);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  UnhookWindowsHookEx(hook);
  return 0;
}
