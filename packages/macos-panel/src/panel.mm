#include <node_api.h>
#include <memory>
#include <unordered_map>
#include "auxiliaryPanels.h"

static std::unordered_map<uint32_t, std::unique_ptr<AuxiliaryPanels>> trackers;
static uint32_t nextId = 0;

static napi_value Track(napi_env env, napi_callback_info info) {
  size_t argc = 1, size = 0;
  napi_value handle;
  void *data = nullptr;
  napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr);
  if (!NSThread.isMainThread || argc != 1 ||
      napi_get_buffer_info(env, handle, &data, &size) != napi_ok || size != sizeof(void *)) {
    napi_throw_error(env, nullptr, "Expected an Electron window handle on the macOS main thread");
    return nullptr;
  }
  NSView *view = (__bridge NSView *)*(void **)data;
  const uint32_t id = ++nextId;
  trackers.emplace(id, std::make_unique<AuxiliaryPanels>(view.window));
  napi_value result;
  napi_create_uint32(env, id, &result);
  return result;
}

static napi_value Untrack(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument, result;
  uint32_t id = 0;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr);
  napi_get_value_uint32(env, argument, &id);
  trackers.erase(id);
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"track", nullptr, Track, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"untrack", nullptr, Untrack, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 2, methods);
  napi_add_env_cleanup_hook(env, [](void *) { trackers.clear(); }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
