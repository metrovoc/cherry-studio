# macOS auxiliary panels

`trackAuxiliaryPanels(browserWindow.getNativeWindowHandle())` connects native non-key panels (including IME candidates) to their focused editor window so they inherit its Space. It preserves existing parents and keyboard focus. Call the returned disposer when the owner closes; process shutdown also releases all observers and relationships.

This package uses public AppKit APIs on the Electron main thread. macOS installs compile the Node-API addon; other platforms skip compilation. WindowManager enables it for Quick Assistant and Selection Assistant.

`preventWindowActivation(handle)` prevents content clicks from activating a toolbar's application while preserving click delivery. A local monitor applies the public AppKit ordering callbacks to the clicked native view, including replacement renderer views. It uses per-view subclasses and leaves other windows untouched. Call the returned disposer on close; disposal and process shutdown remove the monitor and restore owned view classes.

`watchOutsideClicks(handle, callback)` observes mouse clicks outside the owner and its native children. Call `setCompanions(handles)` on its subscription to also exempt those windows and their native children. Refresh the handles when companion windows are created or destroyed; pooled windows keep their exemption on reuse. Keyboard-focus changes leave the panel open. Local and global AppKit monitors are removed by `dispose()` and at process shutdown.
