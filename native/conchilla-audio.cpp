// conchilla-audio: records the sound of ONE app (and its child processes), or of everything
// EXCEPT one app, using Windows' process-loopback capture (Windows 10 2004 / build 19041+).
//
//   conchilla-audio.exe include <pid>   only that app (e.g. the game / movie player)
//   conchilla-audio.exe exclude <pid>   the whole PC minus that app (e.g. minus Discord)
//
// Writes raw 48 kHz, stereo, 16-bit PCM to stdout. Status lines go to stderr:
//   READY | ERR <step> <hresult>
// Exits when stdin closes (Conchilla quit or stopped sharing).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <propidl.h>
#include <mmreg.h>
#include <audioclient.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <io.h>
#include <fcntl.h>
#include <vector>

// ---- declarations from audioclientactivationparams.h / mmdeviceapi.h (not in every SDK) ----
enum CA_ACTIVATION_TYPE { CA_ACTIVATION_DEFAULT = 0, CA_ACTIVATION_PROCESS_LOOPBACK = 1 };
enum CA_LOOPBACK_MODE { CA_INCLUDE_TREE = 0, CA_EXCLUDE_TREE = 1 };
struct CA_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; CA_LOOPBACK_MODE ProcessLoopbackMode; };
struct CA_ACTIVATION_PARAMS { CA_ACTIVATION_TYPE ActivationType; CA_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };

static const GUID kIID_IUnknown = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const GUID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};
static const GUID kIID_Completion = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
static const GUID kIID_IAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4c32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const GUID kIID_IAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48a0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};

struct IActivateOp : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetActivateResult(HRESULT *activateResult, IUnknown **activatedInterface) = 0;
};
struct IActivateCompletion : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateOp *op) = 0;
};
typedef HRESULT(WINAPI *ActivateAsyncFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateCompletion *, IActivateOp **);

// ---- completion handler (must be agile: Windows calls it from its own thread) ----
class Completion : public IActivateCompletion {
  LONG refs = 1;
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (IsEqualGUID(riid, kIID_IUnknown) || IsEqualGUID(riid, kIID_Completion) || IsEqualGUID(riid, kIID_IAgileObject)) {
      *ppv = this;   // IAgileObject has no methods of its own: the IUnknown part is enough
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = InterlockedDecrement(&refs);
    if (!r) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateOp *op) override {
    HRESULT hrActivate = E_FAIL;
    IUnknown *unk = nullptr;
    HRESULT hr = op->GetActivateResult(&hrActivate, &unk);
    if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && unk) {
      result = unk->QueryInterface(kIID_IAudioClient, reinterpret_cast<void **>(&client));
      unk->Release();
    } else {
      result = FAILED(hr) ? hr : hrActivate;
    }
    SetEvent(done);
    return S_OK;
  }
};

static int fail(const char *step, HRESULT hr) {
  fprintf(stderr, "ERR %s %08lx\n", step, static_cast<unsigned long>(hr));
  fflush(stderr);
  return 1;
}

static volatile LONG g_stop = 0;

// Conchilla closes our stdin when it's done with us (or when it exits / crashes)
static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  DWORD n;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, buf, sizeof buf, &n, nullptr) && n > 0) {}
  InterlockedExchange(&g_stop, 1);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: conchilla-audio include|exclude <pid>\n");
    return 2;
  }
  const bool include = wcscmp(argv[1], L"include") == 0;
  const DWORD pid = wcstoul(argv[2], nullptr, 10);
  _setmode(_fileno(stdout), _O_BINARY);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("com", hr);

  HMODULE mmdev = LoadLibraryW(L"Mmdevapi.dll");
  auto activate = mmdev ? reinterpret_cast<ActivateAsyncFn>(GetProcAddress(mmdev, "ActivateAudioInterfaceAsync")) : nullptr;
  if (!activate) return fail("unsupported", E_NOTIMPL);

  CA_ACTIVATION_PARAMS params = {};
  params.ActivationType = CA_ACTIVATION_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = include ? CA_INCLUDE_TREE : CA_EXCLUDE_TREE;
  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  Completion *done = new Completion();
  IActivateOp *op = nullptr;
  hr = activate(L"VAD\\Process_Loopback", kIID_IAudioClient, &pv, done, &op);
  if (FAILED(hr)) return fail("activate", hr);
  if (WaitForSingleObject(done->done, 10000) != WAIT_OBJECT_0) return fail("activate-timeout", E_FAIL);
  if (FAILED(done->result) || !done->client) return fail("activate-result", done->result);
  IAudioClient *client = done->client;

  WAVEFORMATEX wf = {};
  wf.wFormatTag = WAVE_FORMAT_PCM;
  wf.nChannels = 2;
  wf.nSamplesPerSec = 48000;
  wf.wBitsPerSample = 16;
  wf.nBlockAlign = wf.nChannels * wf.wBitsPerSample / 8;
  wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;

  const DWORD base = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, base | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200000 /* 20 ms */, 0, &wf, nullptr);
  if (FAILED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, base, 200000, 0, &wf, nullptr);
  if (FAILED(hr)) return fail("initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) return fail("event", hr);
  IAudioCaptureClient *capture = nullptr;
  hr = client->GetService(kIID_IAudioCaptureClient, reinterpret_cast<void **>(&capture));
  if (FAILED(hr)) return fail("service", hr);
  hr = client->Start();
  if (FAILED(hr)) return fail("start", hr);

  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);
  fprintf(stderr, "READY\n");
  fflush(stderr);

  std::vector<BYTE> silence;
  while (!g_stop) {
    WaitForSingleObject(ready, 100);
    UINT32 packet = 0;
    while (!g_stop && SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      const size_t bytes = static_cast<size_t>(frames) * wf.nBlockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        data = silence.data();
      }
      const size_t written = fwrite(data, 1, bytes, stdout);
      capture->ReleaseBuffer(frames);
      if (written != bytes) { g_stop = 1; break; }   // Conchilla stopped reading
    }
    fflush(stdout);
  }
  client->Stop();
  return 0;
}
