#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <node_api.h>
#include <string>

static NSWindow *Window(napi_env env, napi_value value) {
  void *data = nullptr;
  size_t size = 0;
  if (!NSThread.isMainThread || napi_get_buffer_info(env, value, &data, &size) != napi_ok ||
      size != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle on the main thread");
    return nil;
  }
  NSWindow *window = ((__bridge NSView *)*(void **)data).window;
  if (!window) napi_throw_error(env, nullptr, "Native handle has no window");
  return window;
}

static NSDictionary *State(NSWindow *window) {
  using Connection = int32_t (*)(void);
  using GetTags = int32_t (*)(int32_t, uint32_t, uint64_t *, int32_t);
  Connection connection = (Connection)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
  GetTags getTags = (GetTags)dlsym(RTLD_DEFAULT, "CGSGetWindowTags");
  if (!connection) connection = (Connection)dlsym(RTLD_DEFAULT, "SLSMainConnectionID");
  if (!getTags) getTags = (GetTags)dlsym(RTLD_DEFAULT, "SLSGetWindowTags");
  uint64_t tags = 0;
  const int32_t error = connection && getTags ? getTags(connection(), (uint32_t)window.windowNumber, &tags, 64) : -1;
  SEL getter = NSSelectorFromString(@"_isNonactivatingPanel");
  const BOOL hasGetter = [window respondsToSelector:getter];
  const BOOL nonactivating = hasGetter && ((BOOL (*)(id, SEL))[window methodForSelector:getter])(window, getter);
  return @{ @"number": @(window.windowNumber), @"class": NSStringFromClass(object_getClass(window)),
      @"visible": @(window.isVisible), @"key": @(window.isKeyWindow), @"main": @(window.isMainWindow),
      @"appActive": @(NSApp.isActive), @"styleMask": @(window.styleMask),
      @"collectionBehavior": @(window.collectionBehavior), @"canBecomeKey": @(window.canBecomeKeyWindow),
      @"canBecomeMain": @(window.canBecomeMainWindow), @"isNonactivatingPanel": @(nonactivating),
      @"hasPreventionSetter": @([window respondsToSelector:NSSelectorFromString(@"_setPreventsActivation:")]),
      @"preventsActivationTag": @((tags & (1ull << 16)) != 0), @"tagQueryError": @(error),
      @"tagsHex": [NSString stringWithFormat:@"0x%016llx", (unsigned long long)tags] };
}

static napi_value Json(napi_env env, NSDictionary *value) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  napi_value result;
  napi_create_string_utf8(env, (const char *)json.bytes, json.length, &result);
  return result;
}

static napi_value Snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  if (argc != 1) { napi_throw_type_error(env, nullptr, "Expected a native window handle"); return nullptr; }
  NSWindow *window = Window(env, arg);
  return window ? Json(env, State(window)) : nullptr;
}

static napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 2, size = 0;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || napi_get_value_string_utf8(env, args[1], nullptr, 0, &size) != napi_ok || size > 32) {
    napi_throw_type_error(env, nullptr, "Expected native handle and candidate mode"); return nullptr;
  }
  std::string mode(size + 1, '\0');
  napi_get_value_string_utf8(env, args[1], mode.data(), mode.size(), &size);
  mode.resize(size);
  const bool prevent = mode == "prevents-activation" || mode == "combined";
  const bool join = mode == "join-all-applications" || mode == "combined";
  if (!prevent && !join) { napi_throw_type_error(env, nullptr, "Unknown candidate mode"); return nullptr; }
  NSWindow *window = Window(env, args[0]);
  if (!window) return nullptr;
  if (window.isVisible) { napi_throw_error(env, nullptr, "Apply only before the fresh window's first show"); return nullptr; }
  SEL setter = NSSelectorFromString(@"_setPreventsActivation:");
  if (prevent && ![window respondsToSelector:setter]) {
    napi_throw_error(env, nullptr, "Native window lacks activation prevention setter"); return nullptr;
  }
  NSDictionary *before = State(window);
  if (join) {
    if (@available(macOS 13.0, *)) {
      window.collectionBehavior = (window.collectionBehavior &
          ~(NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary)) |
          NSWindowCollectionBehaviorCanJoinAllApplications;
    } else { napi_throw_error(env, nullptr, "Collection behavior requires macOS 13"); return nullptr; }
  }
  if (prevent) ((void (*)(id, SEL, BOOL))[window methodForSelector:setter])(window, setter, YES);
  return Json(env, @{ @"mode": [NSString stringWithUTF8String:mode.c_str()], @"before": before, @"after": State(window) });
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
