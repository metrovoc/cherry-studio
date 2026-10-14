#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <string>
#include <unordered_map>

static NSWindow *__weak owner;
static NSMapTable<id, NSValue *> *originalClasses;
static NSMapTable<id, NSValue *> *traceClasses;
static NSMutableArray *observers;
static NSFileHandle *output;
static id monitor;
static NSTimer *timer;
static bool active = false;
static NSUInteger sequence = 0, count = 0;
static char traceClassKey;

static NSDictionary *WindowState(NSWindow *window) {
  if (!window) return @{};
  return @{@"number": @(window.windowNumber), @"class": NSStringFromClass(object_getClass(window)),
      @"styleMask": @(window.styleMask), @"collectionBehavior": @(window.collectionBehavior),
      @"level": @(window.level), @"key": @(window.isKeyWindow), @"main": @(window.isMainWindow),
      @"visible": @(window.isVisible), @"canBecomeKey": @(window.canBecomeKeyWindow),
      @"canBecomeMain": @(window.canBecomeMainWindow), @"parent": @(window.parentWindow.windowNumber)};
}

static void Record(NSString *name, id receiver, NSEvent *event, NSDictionary *extra = nil) {
  if (!active || ++count > 4096) return;
  NSMutableDictionary *row = [@{@"sequence": @(++sequence), @"uptime": @(NSProcessInfo.processInfo.systemUptime),
      @"event": name, @"active": @(NSApp.isActive),
      @"frontmostPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
      @"owner": WindowState(owner), @"key": WindowState(NSApp.keyWindow), @"main": WindowState(NSApp.mainWindow)} mutableCopy];
  if (receiver) row[@"receiverClass"] = NSStringFromClass(object_getClass(receiver));
  if (event && (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp)) {
    row[@"type"] = @(event.type);
    row[@"eventNumber"] = @(event.eventNumber);
    row[@"timestamp"] = @(event.timestamp);
    row[@"eventWindow"] = @(event.windowNumber);
  }
  if (extra) [row addEntriesFromDictionary:extra];
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  [output writeData:data];
  [output writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

static bool IsMouse(NSEvent *event) {
  return event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp;
}

static bool InScope(id receiver, NSEvent *event) {
  if (!active || !IsMouse(event) || event.window != owner) return false;
  return ![receiver isKindOfClass:NSView.class] || [(NSView *)receiver window] == owner;
}

static void TraceViews(NSView *view);

static Class TraceClass(Class original) {
  static std::unordered_map<Class, Class> classes;
  const auto found = classes.find(original);
  if (found != classes.end()) return found->second;
  NSString *name = [NSString stringWithFormat:@"CherryActivationTrace_%s", class_getName(original)];
  Class traced = objc_allocateClassPair(original, name.UTF8String, 0);
  objc_setAssociatedObject(traced, &traceClassKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  for (NSString *methodName in @[@"shouldDelayWindowOrderingForEvent:", @"acceptsFirstMouse:"]) {
    const SEL selector = NSSelectorFromString(methodName);
    Method method = class_getInstanceMethod(original, selector);
    if (!method) continue;
    const auto invoke = (BOOL (*)(id, SEL, NSEvent *))method_getImplementation(method);
    class_addMethod(traced, selector, imp_implementationWithBlock(^BOOL(NSView *view, NSEvent *event) {
      const BOOL value = invoke(view, selector, event);
      if (InScope(view, event)) Record(methodName, view, event, @{@"result": @(value)});
      return value;
    }), method_getTypeEncoding(method));
  }
  for (NSString *methodName in @[@"mouseDown:", @"mouseUp:"]) {
    const SEL selector = NSSelectorFromString(methodName);
    Method method = class_getInstanceMethod(original, selector);
    if (!method) continue;
    const auto invoke = (void (*)(id, SEL, NSEvent *))method_getImplementation(method);
    class_addMethod(traced, selector, imp_implementationWithBlock(^(NSView *view, NSEvent *event) {
      const bool scoped = InScope(view, event);
      if (scoped) Record([methodName stringByAppendingString:@".enter"], view, event);
      invoke(view, selector, event);
      if (scoped) Record([methodName stringByAppendingString:@".exit"], view, event);
    }), method_getTypeEncoding(method));
  }
  objc_registerClassPair(traced);
  classes.emplace(original, traced);
  return traced;
}

static void TraceObject(NSView *view) {
  if (!view) return;
  Class original = object_getClass(view);
  if (objc_getAssociatedObject(original, &traceClassKey)) return;
  for (Class current = original; current; current = class_getSuperclass(current)) {
    if ([NSStringFromClass(current) hasPrefix:@"NSKVONotifying_"]) return;
  }
  Class traced = TraceClass(original);
  [originalClasses setObject:[NSValue valueWithPointer:(__bridge void *)original] forKey:view];
  [traceClasses setObject:[NSValue valueWithPointer:(__bridge void *)traced] forKey:view];
  object_setClass(view, traced);
}

static void TraceViews(NSView *view) {
  if (!view) return;
  TraceObject(view);
  for (NSView *child in view.subviews) TraceViews(child);
}

static NSView *Hit(NSEvent *event) {
  NSView *root = owner.contentView.superview ?: owner.contentView;
  NSPoint point = root.superview ? [root.superview convertPoint:event.locationInWindow fromView:nil]
                                : event.locationInWindow;
  return [root hitTest:point];
}

static void Stop() {
  if (!active) return;
  if (monitor) [NSEvent removeMonitor:monitor];
  monitor = nil;
  [timer invalidate]; timer = nil;
  for (id observer in observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
  [observers removeAllObjects];
  NSUInteger restored = 0, superseded = 0;
  for (id object in originalClasses.keyEnumerator.allObjects) {
    Class traced = (Class)[traceClasses objectForKey:object].pointerValue;
    if (object_getClass(object) == traced) {
      object_setClass(object, (Class)[originalClasses objectForKey:object].pointerValue);
      restored++;
    } else superseded++;
  }
  Record(@"trace.stop", nil, nil, @{@"restored": @(restored), @"superseded": @(superseded)});
  active = false;
  [output closeFile]; output = nil;
  originalClasses = nil; traceClasses = nil; observers = nil; owner = nil;
}

static NSString *String(napi_env env, napi_value value) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return nil;
  std::string bytes(size + 1, '\0');
  napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size);
  return [[NSString alloc] initWithBytes:bytes.data() length:size encoding:NSUTF8StringEncoding];
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 3, size = 0;
  napi_value args[3], result;
  void *data = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (active || !NSThread.isMainThread || argc < 2 ||
      napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void *)) {
    napi_throw_error(env, nullptr, "Expected inactive trace, native window handle, path, and optional duration on main thread");
    return nullptr;
  }
  NSString *file = String(env, args[1]);
  if (!file.isAbsolutePath || [NSFileManager.defaultManager fileExistsAtPath:file]) {
    napi_throw_error(env, nullptr, "Expected a new absolute trace output path"); return nullptr;
  }
  uint32_t duration = 60000;
  if (argc == 3) napi_get_value_uint32(env, args[2], &duration);
  if (duration == 0 || duration > 60000) {
    napi_throw_error(env, nullptr, "Trace duration must be between 1 and 60000 ms"); return nullptr;
  }
  owner = ((__bridge NSView *)*(void **)data).window;
  if (!owner) { napi_throw_error(env, nullptr, "Window handle has no owner"); return nullptr; }
  [NSFileManager.defaultManager createFileAtPath:file contents:nil attributes:@{NSFilePosixPermissions: @0600}];
  output = [NSFileHandle fileHandleForWritingAtPath:file];
  if (!output) { napi_throw_error(env, nullptr, "Unable to create trace output"); return nullptr; }
  active = true; count = 0; sequence = 0;
  originalClasses = [NSMapTable weakToStrongObjectsMapTable];
  traceClasses = [NSMapTable weakToStrongObjectsMapTable];
  observers = [NSMutableArray new];
  TraceViews(owner.contentView.superview ?: owner.contentView);
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
      handler:^NSEvent *(NSEvent *event) {
    if (event.window == owner) {
      NSView *hit = Hit(event);
      Record(@"monitor.enter", hit, event);
      TraceViews(owner.contentView.superview ?: owner.contentView);
      Record(@"monitor.exit", Hit(event), event);
    }
    return event;
  }];
  for (NSString *name in @[NSApplicationWillBecomeActiveNotification, NSApplicationDidBecomeActiveNotification,
      NSApplicationDidResignActiveNotification, NSWindowDidBecomeMainNotification, NSWindowDidBecomeKeyNotification]) {
    id token = [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil
        usingBlock:^(NSNotification *note) {
      Record(name, note.object, NSApp.currentEvent);
    }];
    [observers addObject:token];
  }
  timer = [NSTimer scheduledTimerWithTimeInterval:duration / 1000.0 repeats:NO block:^(NSTimer *) { Stop(); }];
  Record(@"trace.start", owner, nil, @{@"pid": @(NSProcessInfo.processInfo.processIdentifier)});
  napi_get_undefined(env, &result); return result;
}

static napi_value Dispose(napi_env env, napi_callback_info) {
  Stop(); napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Checkpoint(napi_env env, napi_callback_info info) {
  napi_value arg, result; size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  NSString *label = argc ? String(env, arg) : nil;
  if (label && label.length < 128) Record(@"checkpoint", nil, nil, @{@"label": label});
  napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"checkpoint", nullptr, Checkpoint, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 3, methods);
  napi_add_env_cleanup_hook(env, [](void *) { Stop(); }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
