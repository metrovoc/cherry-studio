#include <node_api.h>
#include <memory>
#include <unordered_map>
#include "auxiliaryPanels.h"
#include "outsideClicks.h"

static std::unordered_map<uint32_t, std::unique_ptr<AuxiliaryPanels>> trackers;
struct ClickSubscription {
  napi_env env;
  napi_ref callback;
  std::unique_ptr<OutsideClicks> monitor;
  ~ClickSubscription() {
    monitor.reset();
    napi_delete_reference(env, callback);
  }
};
static std::unordered_map<uint32_t, std::unique_ptr<ClickSubscription>> clickSubscriptions;
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

static napi_value WatchOutsideClicks(napi_env env, napi_callback_info info) {
  size_t argc = 2, size = 0;
  napi_value args[2];
  void *data = nullptr;
  napi_valuetype type;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (!NSThread.isMainThread || argc != 2 ||
      napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void *) ||
      napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
    napi_throw_error(env, nullptr, "Expected a window handle and callback on the macOS main thread");
    return nullptr;
  }
  auto subscription = std::make_unique<ClickSubscription>();
  subscription->env = env;
  napi_create_reference(env, args[1], 1, &subscription->callback);
  const napi_ref callback = subscription->callback;
  NSView *view = (__bridge NSView *)*(void **)data;
  subscription->monitor = std::make_unique<OutsideClicks>(view.window, [env, callback] {
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value fn, receiver, result;
    napi_get_reference_value(env, callback, &fn);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, fn, 0, nullptr, &result);
    napi_close_handle_scope(env, scope);
  });
  const uint32_t id = ++nextId;
  clickSubscriptions.emplace(id, std::move(subscription));
  napi_value result;
  napi_create_uint32(env, id, &result);
  return result;
}

static napi_value UnwatchOutsideClicks(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument, result;
  uint32_t id = 0;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr);
  napi_get_value_uint32(env, argument, &id);
  clickSubscriptions.erase(id);
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"track", nullptr, Track, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"untrack", nullptr, Untrack, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"watchOutsideClicks", nullptr, WatchOutsideClicks, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unwatchOutsideClicks", nullptr, UnwatchOutsideClicks, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 4, methods);
  napi_add_env_cleanup_hook(env, [](void *) { clickSubscriptions.clear(); trackers.clear(); }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
