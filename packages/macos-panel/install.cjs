if (process.platform === 'darwin') {
  process.env.npm_config_build_from_source = 'true'
  require('node-gyp-build/bin.js')
}
