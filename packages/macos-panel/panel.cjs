exports.trackAuxiliaryPanels = (handle) => {
  const native = require('node-gyp-build')(__dirname)
  const id = native.track(handle)
  let active = true
  return () => {
    if (!active) return
    active = false
    native.untrack(id)
  }
}
