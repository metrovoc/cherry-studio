# macOS auxiliary panels

`trackAuxiliaryPanels(browserWindow.getNativeWindowHandle())` connects native non-key panels (including IME candidates) to their focused editor window so they inherit its Space. It preserves existing parents and keyboard focus. Call the returned disposer when the owner closes; process shutdown also releases all observers and relationships.

This package runs on the Electron main thread. macOS installs compile the Node-API addon; other platforms skip compilation. WindowManager enables it for Quick Assistant and Selection Assistant.

`preventWindowActivation(handle)` initializes a fresh nonactivating panel before its first show. On macOS 27 and later it uses the private AppKit `_setPreventsActivation:` setter proposed in [Electron #54807](https://github.com/electron/electron/pull/54807) for [Electron #53889](https://github.com/electron/electron/issues/53889). It checks selector availability and leaves older macOS versions unchanged. The setting belongs to the native window's lifetime; there are no monitors, view subclasses, or disposal toggles.

`preventWindowFill(handle)` blocks title-bar double-click Fill, which bypasses Electron's disabled zoom button. A local event monitor changes the second click's count over native/custom draggable areas while delivering both mouse-down and mouse-up. Content, controls, ordinary dragging/resizing, and other double-click preferences retain their behavior. Dispose the returned callback when the window closes; process shutdown also removes the monitor.

`watchOutsideClicks(handle, callback)` observes mouse clicks outside the owner and its native children. Call `setCompanions(handles)` on its subscription to also exempt those windows and their native children. Refresh the handles when companion windows are created or destroyed; pooled windows keep their exemption on reuse. Keyboard-focus changes leave the panel open. Local and global AppKit monitors are removed by `dispose()` and at process shutdown.
