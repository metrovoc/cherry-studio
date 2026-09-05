# macOS auxiliary panels

`trackAuxiliaryPanels(browserWindow.getNativeWindowHandle())` connects native non-key panels (including IME candidates) to their focused editor window so they inherit its Space. It preserves existing parents and keyboard focus. Call the returned disposer when the owner closes; process shutdown also releases all observers and relationships.

This package uses public AppKit APIs on the Electron main thread. macOS installs compile the Node-API addon; other platforms skip compilation. WindowManager enables it for Quick Assistant and Selection Assistant.

`watchOutsideClicks(handle, callback)` observes mouse clicks outside the owner and its native children. Keyboard-focus changes leave the panel open. Local and global AppKit monitors are removed by the returned disposer and at process shutdown.
