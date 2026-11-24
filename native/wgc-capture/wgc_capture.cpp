#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>

using Microsoft::WRL::ComPtr;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

namespace {

struct CaptureResult {
  int width = 0;
  int height = 0;
  int origin_x = 0;
  int origin_y = 0;
};

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return L"";
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring wide(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), wide.data(), size);
  return wide;
}

RECT WindowBounds(HWND hwnd) {
  RECT bounds{};
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
    return bounds;
  }
  GetWindowRect(hwnd, &bounds);
  return bounds;
}

void WritePng(const std::wstring& path, ID3D11Texture2D* texture, ID3D11Device* device, ID3D11DeviceContext* context) {
  D3D11_TEXTURE2D_DESC source_desc{};
  texture->GetDesc(&source_desc);
  D3D11_TEXTURE2D_DESC staging_desc = source_desc;
  staging_desc.Usage = D3D11_USAGE_STAGING;
  staging_desc.BindFlags = 0;
  staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  staging_desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  winrt::check_hresult(device->CreateTexture2D(&staging_desc, nullptr, staging.GetAddressOf()));
  context->CopyResource(staging.Get(), texture);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  winrt::check_hresult(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));

  ComPtr<IWICImagingFactory> factory;
  winrt::check_hresult(CoCreateInstance(
      CLSID_WICImagingFactory,
      nullptr,
      CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(factory.GetAddressOf())));
  ComPtr<IWICStream> stream;
  winrt::check_hresult(factory->CreateStream(stream.GetAddressOf()));
  winrt::check_hresult(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE));
  ComPtr<IWICBitmapEncoder> encoder;
  winrt::check_hresult(factory->CreateEncoder(
      GUID_ContainerFormatPng,
      nullptr,
      encoder.GetAddressOf()));
  winrt::check_hresult(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  winrt::check_hresult(encoder->CreateNewFrame(frame.GetAddressOf(), properties.GetAddressOf()));
  winrt::check_hresult(frame->Initialize(properties.Get()));
  winrt::check_hresult(frame->SetSize(source_desc.Width, source_desc.Height));
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  winrt::check_hresult(frame->SetPixelFormat(&format));
  winrt::check_hresult(frame->WritePixels(
      source_desc.Height,
      mapped.RowPitch,
      mapped.RowPitch * source_desc.Height,
      static_cast<BYTE*>(mapped.pData)));
  winrt::check_hresult(frame->Commit());
  winrt::check_hresult(encoder->Commit());
  context->Unmap(staging.Get(), 0);
}

CaptureResult CaptureWindow(HWND hwnd, const std::wstring& output) {
  if (!IsWindow(hwnd)) throw std::runtime_error("target window is not available");
  const RECT bounds = WindowBounds(hwnd);

  ComPtr<ID3D11Device> d3d_device;
  ComPtr<ID3D11DeviceContext> d3d_context;
  winrt::check_hresult(D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      d3d_device.GetAddressOf(),
      nullptr,
      d3d_context.GetAddressOf()));
  ComPtr<IDXGIDevice> dxgi_device;
  winrt::check_hresult(d3d_device.As(&dxgi_device));
  ComPtr<IInspectable> inspectable_device;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(), inspectable_device.GetAddressOf()));
  IDirect3DDevice device{inspectable_device.Detach(), winrt::take_ownership_from_abi};

  auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interop->CreateForWindow(
      hwnd,
      winrt::guid_of<GraphicsCaptureItem>(),
      winrt::put_abi(item)));
  const auto size = item.Size();
  if (size.Width <= 0 || size.Height <= 0) throw std::runtime_error("window capture size is empty");

  auto frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      device,
      winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      2,
      size);
  auto session = frame_pool.CreateCaptureSession(item);
  try {
    session.IsCursorCaptureEnabled(false);
  } catch (...) {
  }
  try {
    session.IsBorderRequired(false);
  } catch (...) {
  }

  struct FrameState {
    std::mutex mutex;
    std::condition_variable ready;
    Direct3D11CaptureFrame frame{nullptr};
    std::atomic<bool> stopped{false};
  };
  auto state = std::make_shared<FrameState>();
  auto revoker = frame_pool.FrameArrived(
      winrt::auto_revoke,
      [state](Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&) noexcept {
        try {
          auto next = sender.TryGetNextFrame();
          {
            std::lock_guard<std::mutex> lock(state->mutex);
            if (!state->stopped && !state->frame) {
              state->frame = next;
              state->ready.notify_one();
              return;
            }
          }
          next.Close();
        } catch (...) {
        }
      });
  session.StartCapture();
  Direct3D11CaptureFrame captured{nullptr};
  {
    std::unique_lock<std::mutex> lock(state->mutex);
    if (!state->ready.wait_for(lock, std::chrono::seconds(5), [&] { return state->frame != nullptr; })) {
      throw std::runtime_error("timed out waiting for capture frame");
    }
    captured = state->frame;
    state->frame = nullptr;
    state->stopped = true;
  }
  revoker.revoke();
  auto surface = captured.Surface();
  auto access = surface.as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  ComPtr<ID3D11Texture2D> texture;
  winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(texture.GetAddressOf())));
  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  WritePng(output, texture.Get(), d3d_device.Get(), d3d_context.Get());
  try {
    session.Close();
  } catch (...) {
  }
  try {
    frame_pool.Close();
  } catch (...) {
  }
  try {
    captured.Close();
  } catch (...) {
  }

  CaptureResult result;
  result.width = static_cast<int>(desc.Width);
  result.height = static_cast<int>(desc.Height);
  result.origin_x = bounds.left;
  result.origin_y = bounds.top;
  return result;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    uint64_t hwnd_value = 0;
    std::wstring output;
    for (int index = 1; index < argc; ++index) {
      const std::wstring arg = argv[index];
      if (arg == L"--hwnd" && index + 1 < argc) {
        hwnd_value = std::stoull(argv[++index]);
      } else if (arg == L"--output" && index + 1 < argc) {
        output = argv[++index];
      }
    }
    if (!hwnd_value || output.empty()) {
      std::cerr << "usage: wgc-capture --hwnd <id> --output <png>\n";
      return 2;
    }
    const auto result = CaptureWindow(
        reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd_value)),
        output);
    std::cout << "{\"ok\":true,\"width\":" << result.width
              << ",\"height\":" << result.height
              << ",\"originX\":" << result.origin_x
              << ",\"originY\":" << result.origin_y
              << ",\"method\":\"wgc\"}" << std::endl;
    return 0;
  } catch (const winrt::hresult_error& error) {
    std::cerr << "wgc hresult: " << winrt::to_string(error.message()) << " (0x" << std::hex
              << static_cast<uint32_t>(error.code()) << ")\n";
  } catch (const std::exception& error) {
    std::cerr << "wgc error: " << error.what() << "\n";
  }
  return 1;
}
