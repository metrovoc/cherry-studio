const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

if (process.platform === 'darwin') {
  const directory = mkdtempSync(join(tmpdir(), 'macos-panel-test-'))
  try {
    const binary = join(directory, 'panel-test')
    execFileSync(
      'xcrun',
      [
        'clang++',
        '-std=c++17',
        '-fobjc-arc',
        '-framework',
        'AppKit',
        join(__dirname, 'auxiliaryPanels.mm'),
        '-o',
        binary
      ],
      { stdio: 'inherit' }
    )
    execFileSync(binary, [], { stdio: 'inherit' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
