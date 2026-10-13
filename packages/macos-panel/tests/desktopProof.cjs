const { execFile, execFileSync, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Desktop input proof runs only in isolated GitHub Actions')
const { app, BrowserWindow, ipcMain } = require('electron')
const { preventWindowActivation } = require('../panel.cjs')
const output = resolve(process.argv[2])
const helper = join(output, 'desktop-probe')
const results = { scope: 'Electron toolbar with production macos-panel guard; synthetic action renderer', trials: [] }
let source
let actionCount = 0
let result
let main
let toolbar
let unguard
const timeline = []
const record = (event, detail = {}) => timeline.push({ event, uptime: process.uptime(), ...detail })
const nativeAsync = (...args) => promisify(execFile)(helper, args.map(String), { encoding: 'utf8' })
const native = (...args) => execFileSync(helper, args.map(String), { encoding: 'utf8' })
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2))
const state = () => ({
  native: JSON.parse(native('snapshot')),
  main: { bounds: main.getBounds(), focused: main.isFocused(), visible: main.isVisible() },
  toolbar: { bounds: toolbar.getBounds(), focused: toolbar.isFocused(), visible: toolbar.isVisible() },
  result: result && { bounds: result.getBounds(), focused: result.isFocused(), visible: result.isVisible() },
  actionCount
})
function screenshot(name) {
  const path = join(output, `${name}.png`)
  execFileSync('screencapture', ['-x', path])
  return JSON.parse(native('image-metrics', path))
}
function watch(window, name) {
  for (const event of ['show', 'hide', 'focus', 'blur', 'move', 'maximize', 'enter-full-screen']) {
    window.on(event, () => record(`${name}.${event}`, { bounds: window.getBounds() }))
  }
}
async function load(window, body) {
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Window did not become ready to show')), 15000)
    window.once('ready-to-show', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`)
  await ready
  await window.webContents.executeJavaScript('document.body.getBoundingClientRect().width')
}

app
  .whenReady()
  .then(async () => {
    mkdirSync(output, { recursive: true })
    const capabilities = JSON.parse(native('capabilities'))
    results.capabilities = capabilities
    if (!capabilities.postEvents || !capabilities.accessibility || !capabilities.screenCapture) {
      throw new Error('Runner lacks existing desktop permissions')
    }
    main = new BrowserWindow({ x: 260, y: 150, width: 650, height: 460, show: false, title: 'Assistant Main' })
    watch(main, 'main')
    await load(main, '<body style="margin:0;background:#d12b48;color:white"><h1>Assistant Main</h1></body>')
    main.show()
    await delay(1500)
    results.mainActive = statePlaceholder()
    results.mainActive.red = screenshot('main-active')
    const sourceBundle = join(output, 'External Source.app', 'Contents')
    mkdirSync(join(sourceBundle, 'MacOS'), { recursive: true })
    execFileSync('cp', [helper, join(sourceBundle, 'MacOS', 'source')])
    writeFileSync(
      join(sourceBundle, 'Info.plist'),
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>source</string><key>CFBundleIdentifier</key><string>org.cherrystudio.desktop-proof.source</string><key>CFBundleName</key><string>External Source</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
    )
    source = spawn(join(sourceBundle, 'MacOS', 'source'), ['source', join(output, 'source.plist')], {
      stdio: 'inherit'
    })
    await delay(2000)
    toolbar = new BrowserWindow({
      x: 420,
      y: 80,
      width: 350,
      height: 43,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: true,
      hasShadow: false,
      thickFrame: false,
      roundedCorners: false,
      type: 'panel',
      focusable: false,
      hiddenInMissionControl: true,
      acceptFirstMouse: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    watch(toolbar, 'toolbar')
    toolbar.setAlwaysOnTop(true, 'screen-saver')
    toolbar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    await load(
      toolbar,
      `<body style="margin:0;background:white"><div style="display:flex;height:43px"><div style="width:70px;-webkit-app-region:drag">Drag</div><button style="width:180px" onclick="require('electron').ipcRenderer.send('proof-action')">Translate</button></div><script>document.addEventListener('mousedown', e=>require('electron').ipcRenderer.send('proof-down',{trusted:e.isTrusted}));</script></body>`
    )
    ipcMain.on('proof-down', (_event, detail) => record('toolbar.mouseDown', detail))
    ipcMain.on('proof-action', async () => {
      actionCount++
      record('toolbar.action', { actionCount })
      toolbar.hide()
      result = new BrowserWindow({
        x: 440,
        y: 220,
        width: 500,
        height: 400,
        show: false,
        frame: false,
        transparent: true,
        maximizable: false,
        fullscreenable: false,
        type: 'panel',
        hiddenInMissionControl: true,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 12, y: 11 },
        hasShadow: false
      })
      watch(result, 'result')
      result.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      await load(
        result,
        '<body style="margin:0;background:#fff3ad"><div style="height:38px;-webkit-app-region:drag">Result title</div><p>Translated fixture text</p></body>'
      )
      result.show()
      record('result.opened')
    })
    for (const guarded of [false, true, false, true]) {
      if (result) {
        result.destroy()
        result = null
      }
      unguard?.()
      unguard = guarded ? preventWindowActivation(toolbar.getNativeWindowHandle()) : null
      main.show()
      await delay(500)
      native('activate', source.pid)
      await delay(1500)
      toolbar.showInactive()
      toolbar.setAlwaysOnTop(true, 'screen-saver')
      await delay(500)
      const name = `${results.trials.length}-${guarded ? 'guarded' : 'baseline'}`
      const before = state()
      const beforeRed = screenshot(`${name}-before`)
      const previousActions = actionCount
      const timelineStart = timeline.length
      record('input.begin', { guarded })
      await nativeAsync('click', 580, 101)
      await delay(2000)
      const after = state()
      const afterRed = screenshot(`${name}-after`)
      results.trials.push({
        guarded,
        sourcePid: source.pid,
        before,
        beforeRed,
        after,
        afterRed,
        mainFocusedDuringClick: timeline.slice(timelineStart).some((event) => event.event === 'main.focus'),
        trustedMouseDown: timeline
          .slice(timelineStart)
          .some((event) => event.event === 'toolbar.mouseDown' && event.trusted),
        sourceInitiallyActive: before.native.frontmostPid === source.pid && source.exitCode === null,
        delivered: actionCount === previousActions + 1 && result?.isVisible()
      })
      save('results.json', results)
    }
    results.stageManagerEnabled =
      execFileSync('defaults', ['read', 'com.apple.WindowManager', 'GloballyEnabled'], { encoding: 'utf8' }).trim() ===
      '1'
    const activePixels = results.mainActive.red.count
    for (const trial of results.trials) {
      trial.mainInitiallyInStrip =
        trial.beforeRed.count > 100 && trial.beforeRed.count < activePixels * 0.25 && trial.beforeRed.maxX < 250
      trial.mainPromoted =
        trial.afterRed.count > activePixels * 0.3 || trial.after.main.focused || trial.mainFocusedDuringClick
      trial.mainRemainedInStrip =
        trial.afterRed.count > 100 && trial.afterRed.count < activePixels * 0.25 && trial.afterRed.maxX < 250
    }
    results.passed =
      results.stageManagerEnabled &&
      results.trials.every(
        (t) =>
          t.delivered &&
          t.trustedMouseDown &&
          t.mainInitiallyInStrip &&
          (t.guarded ? t.mainRemainedInStrip && !t.mainPromoted : t.mainPromoted)
      )
    if (!results.passed)
      throw new Error('Stage Manager baseline/guarded proof did not satisfy all assertions; inspect evidence')
  })
  .catch((error) => {
    results.error = error.message
    process.exitCode = 1
  })
  .finally(() => {
    save('timeline.json', timeline)
    save('results.json', results)
    unguard?.()
    source?.kill('SIGTERM')
    app.exit(process.exitCode || 0)
  })
function statePlaceholder() {
  return { native: JSON.parse(native('snapshot')), main: { bounds: main.getBounds() } }
}
