const { execFile, execFileSync, spawn } = require('node:child_process')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { promisify } = require('node:util')

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Desktop proof runs only in isolated GitHub Actions')
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: cherryDesktopProof.cjs <app bundle> <evidence>')
const bundle = resolve(process.argv[2])
const output = resolve(process.argv[3])
const profile = join(output, 'cherry-profile')
const executable = join(bundle, 'Contents', 'MacOS', 'Cherry Studio')
const bootConfigDirectory = join(homedir(), '.cherrystudio')
const bootConfigPath = join(bootConfigDirectory, 'boot-config.json')
const helper = join(output, 'desktop-probe')
const native = (...args) => execFileSync(helper, args.map(String), { encoding: 'utf8' })
const nativeAsync = (...args) => promisify(execFile)(helper, args.map(String), { encoding: 'utf8' })
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2))
const results = {
  scope:
    'Published Cherry application, actual managed toolbar and Translate action, repository native activation guard',
  selectionSource: 'selection.text_selected IPC; native selection hook remains disabled',
  trials: []
}
let cherry
let source
let inspector
let createdBootConfig = false
let createdBootConfigDirectory = false
let startedAt

async function poll(label, operation, timeout = 20000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    if (cherry?.spawnError) throw cherry.spawnError
    if (cherry && cherry.exitCode !== null) throw new Error(`Cherry exited with ${cherry.exitCode}`)
    try {
      const value = await operation()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Inspector disconnected'))
    }
    pending.clear()
  })
  return {
    close: () => socket.close(),
    async evaluate(expression) {
      const id = ++sequence
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Inspector evaluation timed out'))
        }, 30000)
        pending.set(id, { resolve, reject, timer })
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true }
          })
        )
      })
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
  }
}

function screenshot(name) {
  const path = join(output, `${name}.png`)
  execFileSync('screencapture', ['-x', path])
  return JSON.parse(native('image-metrics', path))
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(8000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

async function installProbe() {
  return inspector.evaluate(`(async () => {
    const require = process.mainModule.require.bind(process.mainModule);
    const application = Object.values(require('module')._cache)
      .map(module => module.exports?.application).find(value => value?.get && value?.getPath);
    if (!application?.isReady()) throw Error('Application bootstrap is incomplete');
    const service = application.get('SelectionService');
    const preferences = application.get('PreferenceService');
    const wm = application.get('WindowManager');
    const electron = require('electron');
    if (service.getSelectionHook() || preferences.get('feature.selection.enabled') || service.isActivated)
      throw Error('Selection hook must be disabled for this isolated proof');
    const main = wm.getWindowsByType('main')[0];
    if (!main || main.webContents.isLoadingMainFrame()) throw Error('Main window is not ready');
    const expectedProfile = ${JSON.stringify(profile)};
    const actualProfile = application.getPath('app.userdata');
    if (actualProfile !== expectedProfile && !actualProfile.startsWith(expectedProfile + ${JSON.stringify(sep)}))
      throw Error('Packaged app did not honor the isolated user-data-dir: ' + actualProfile);
    const originals = new Map();
    const preferenceValues = new Map();
    const timeline = [];
    const listeners = [];
    const record = (event, detail = {}) => timeline.push({event, at:Date.now(), uptime:process.uptime(), ...detail});
    const replace = (key, value) => {
      originals.set(key, Object.getOwnPropertyDescriptor(service, key));
      service[key] = value;
    };
    const watch = (window, name) => {
      for (const event of ['show', 'hide', 'focus', 'blur', 'move', 'maximize', 'enter-full-screen']) {
        const listener = () => record(name + '.' + event, {bounds:window.getBounds()});
        window.on(event, listener);
        listeners.push(() => { if (!window.isDestroyed()) window.removeListener(event, listener); });
      }
    };
    const probe = globalThis.__cherryDesktopProof = {
      application, service, preferences, wm, main, timeline, listeners, originals, preferenceValues,
      record, unguard:null, trace:null, css:null, toolbar:null, actions:[],
      async cleanup() {
        this.unguard?.(); this.unguard = null;
        this.trace?.stop(); this.trace = null;
        service.hideToolbar();
        if (this.toolbar && !this.toolbar.isDestroyed()) await this.toolbar.webContents.executeJavaScript(
          'window.removeEventListener("mousedown", window.__desktopInputHandler, true);' +
          'window.removeEventListener("click", window.__desktopInputHandler, true);' +
          'delete window.__desktopInputHandler; delete window.__desktopInput;');
        if (this.css && !main.isDestroyed()) await main.webContents.removeInsertedCSS(this.css);
        for (const dispose of listeners) dispose();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(service, key, descriptor); else delete service[key];
        }
        for (const [key, value] of preferenceValues) await preferences.set(key, value);
        delete globalThis.__cherryDesktopProof;
        return { restored:true, hookLoaded:!!service.getSelectionHook() };
      }
    };
    replace('startHideByMouseKeyListener', () => {});
    replace('stopHideByMouseKeyListener', () => {});
    const originalProcessAction = service.processAction;
    replace('processAction', function(action) {
      probe.actions.push({id:action.id, selectedText:action.selectedText});
      record('selection.processAction', {id:action.id});
      return originalProcessAction.call(this, action);
    });
    for (const key of ['feature.selection.auto_close', 'feature.selection.auto_pin']) {
      preferenceValues.set(key, preferences.get(key));
      await preferences.set(key, false);
    }
    watch(main, 'main');
    const subscription = wm.onWindowCreatedByType('selectionAction', ({window}) => watch(window, 'result'));
    listeners.push(() => subscription.dispose());
    const id = wm.open('selectionToolbar');
    const toolbar = wm.getWindow(id);
    probe.toolbar = toolbar;
    probe.id = id;
    if (!toolbar || service.toolbarWindow !== toolbar) throw Error('Managed toolbar service binding is missing');
    service.toolbarWindowId = id;
    watch(toolbar, 'toolbar');
    main.setMinimumSize(500, 350);
    main.setBounds({x:260, y:150, width:650, height:460});
    probe.css = await main.webContents.insertCSS('html, body, body * {background:#d12b48!important;background-image:none!important}');
    probe.inspect = async () => ({
      main:{bounds:main.getBounds(), visible:main.isVisible(), focused:main.isFocused()},
      toolbar:{bounds:toolbar.getBounds(), visible:toolbar.isVisible(), focused:toolbar.isFocused()},
      results:wm.getWindowsByType('selectionAction').map(window => ({
        id:wm.getWindowId(window), visible:window.isVisible(), focused:window.isFocused(),
        url:window.webContents.getURL(), bounds:window.getBounds(), initData:wm.getInitData(wm.getWindowId(window))
      })),
      actions:probe.actions, timeline, input:await toolbar.webContents.executeJavaScript('window.__desktopInput || []')
    });
    return {pid:process.pid, version:electron.app.getVersion(), electron:process.versions.electron,
      profile:actualProfile, toolbarId:id, toolbarBrowserWindowId:toolbar.id,
      mainBrowserWindowId:main.id, selectionEnabled:preferences.get('feature.selection.enabled')};
  })()`)
}

async function run() {
  mkdirSync(output, { recursive: true })
  mkdirSync(profile, { recursive: true })
  results.capabilities = JSON.parse(native('capabilities'))
  if (!results.capabilities.postEvents || !results.capabilities.accessibility || !results.capabilities.screenCapture)
    throw new Error('Runner lacks existing native input, accessibility, or capture permissions')
  results.stageManagerEnabled =
    execFileSync('defaults', ['read', 'com.apple.WindowManager', 'GloballyEnabled'], { encoding: 'utf8' }).trim() ===
    '1'
  if (!results.stageManagerEnabled) throw new Error('Stage Manager is not enabled')
  if (existsSync(bootConfigPath)) throw new Error('Hosted runner already has a Cherry boot configuration')
  createdBootConfigDirectory = !existsSync(bootConfigDirectory)
  mkdirSync(bootConfigDirectory, { recursive: true })
  writeFileSync(bootConfigPath, JSON.stringify({ 'app.user_data_path': { [executable]: profile } }))
  createdBootConfig = true
  startedAt = Date.now()
  const stdout = openSync(join(output, 'cherry-stdout.log'), 'w')
  const stderr = openSync(join(output, 'cherry-stderr.log'), 'w')
  try {
    cherry = spawn(
      executable,
      [
        '--inspect=9230',
        '--remote-debugging-port=9444',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`
      ],
      { stdio: ['ignore', stdout, stderr] }
    )
  } finally {
    closeSync(stdout)
    closeSync(stderr)
  }
  cherry.on('error', (error) => {
    cherry.spawnError = error
  })
  const target = await poll(
    'Main-process inspector',
    async () => {
      const targets = await fetch('http://127.0.0.1:9230/json/list').then((response) => response.json())
      return targets.find((target) => target.webSocketDebuggerUrl)
    },
    60000
  )
  inspector = await connect(target.webSocketDebuggerUrl)
  await poll(
    'Cherry bootstrap',
    () =>
      inspector.evaluate(`(() => {
    const require = process.mainModule?.require.bind(process.mainModule);
    if (!require) return false;
    const app = Object.values(require('module')._cache).map(module => module.exports?.application).find(value => value?.get && value?.getPath);
    return !!app?.isReady() && !!app.get('WindowManager').getWindowsByType('main')[0] &&
      !app.get('WindowManager').getWindowsByType('main')[0].webContents.isLoadingMainFrame();
  })()`),
    60000
  )
  results.application = await installProbe()
  await poll('Actual toolbar renderer', () =>
    inspector.evaluate(`!__cherryDesktopProof.toolbar.webContents.isLoadingMainFrame() &&
    __cherryDesktopProof.toolbar.webContents.executeJavaScript(${JSON.stringify('!!document.querySelector(\'[data-ui="selection.toolbar"] button\')')})`)
  )
  await inspector.evaluate(
    `__cherryDesktopProof.toolbar.webContents.executeJavaScript(${JSON.stringify(`
    window.__desktopInput = [];
    window.__desktopInputHandler = event => window.__desktopInput.push({
      type:event.type, at:Date.now(), trusted:event.isTrusted,
      label:event.target.closest?.('button')?.getAttribute('aria-label') ?? null
    });
    window.addEventListener('mousedown', window.__desktopInputHandler, true);
    window.addEventListener('click', window.__desktopInputHandler, true);
  `)})`
  )
  await inspector.evaluate('__cherryDesktopProof.main.show()')
  native('activate', cherry.pid)
  await delay(1500)
  results.mainActive = { native: JSON.parse(native('snapshot')), red: screenshot('cherry-main-active') }
  results.mainWindowNumber = results.mainActive.native.windows.find(
    (window) =>
      window.kCGWindowOwnerPID === cherry.pid &&
      window.kCGWindowBounds.X === 260 &&
      window.kCGWindowBounds.Y === 150 &&
      window.kCGWindowBounds.Width === 650 &&
      window.kCGWindowBounds.Height === 460
  )?.kCGWindowNumber
  if (!results.mainWindowNumber) throw new Error('Cannot identify Main in WindowServer state')
  if (results.mainActive.red.count < 50000)
    throw new Error('Main window marker is not visible enough for strip comparison')
  const contents = join(output, 'Cherry External Source.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  copyFileSync(helper, join(contents, 'MacOS', 'source'))
  writeFileSync(
    join(contents, 'Info.plist'),
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>source</string><key>CFBundleIdentifier</key><string>org.cherrystudio.desktop-proof.source</string><key>CFBundleName</key><string>External Source</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
  )
  source = spawn(join(contents, 'MacOS', 'source'), ['source', join(output, 'cherry-source.plist')], {
    stdio: 'inherit'
  })
  source.on('error', (error) => {
    source.spawnError = error
  })
  await delay(1500)
  if (source.spawnError) throw source.spawnError
  const guardModule = resolve(__dirname, '../panel.cjs')
  for (const guarded of [false, true, false, true]) {
    const trial = { guarded, name: `cherry-${results.trials.length}-${guarded ? 'guarded' : 'baseline'}` }
    results.trials.push(trial)
    await inspector.evaluate(`(() => {
      const probe = __cherryDesktopProof;
      probe.service.closeActionWindows();
      probe.unguard?.(); probe.unguard = null;
      if (${guarded}) probe.unguard = process.mainModule.require(${JSON.stringify(guardModule)}).preventWindowActivation(probe.toolbar.getNativeWindowHandle());
      probe.main.show();
    })()`)
    await poll('Previous action windows closed', () =>
      inspector.evaluate(
        `__cherryDesktopProof.wm.getWindowsByType('selectionAction').every(window => !window.isVisible())`
      )
    )
    native('activate', cherry.pid)
    await delay(600)
    native('activate', source.pid)
    await delay(1500)
    trial.button = await inspector.evaluate(`(async () => {
      const probe = __cherryDesktopProof;
      const point = {x:420,y:100};
      const payload = {text:'The assistant must open independently of its main window.', programName:'External Source',
        startTop:point,startBottom:point,endTop:point,endBottom:point,mousePosStart:point,mousePosEnd:point,
        method:1,posLevel:0,isFullscreen:false};
      probe.application.get('IpcApiService').send(probe.id, 'selection.text_selected', payload);
      probe.service.showToolbarAtPosition(point, 'bottomRight');
      const actions = probe.preferences.get('feature.selection.action_items').filter(action => action.enabled);
      const index = actions.findIndex(action => action.id === 'translate');
      if (index < 0) throw Error('Translate action is unavailable');
      const rect = await probe.toolbar.webContents.executeJavaScript(${JSON.stringify(`(index => {
        const button = document.querySelectorAll('[data-ui="selection.toolbar"] button')[index];
        if (!button || button.disabled) throw Error('Translate button is not usable');
        const rect = button.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,label:button.getAttribute('aria-label')};
      })(`)} + index + ')');
      const bounds = probe.toolbar.getBounds(), zoom = probe.toolbar.webContents.getZoomFactor();
      return {actionId:'translate', label:rect.label, x:Math.round(bounds.x+(rect.x+rect.width/2)*zoom),
        y:Math.round(bounds.y+(rect.y+rect.height/2)*zoom)};
    })()`)
    await delay(400)
    trial.before = {
      native: JSON.parse(native('snapshot')),
      app: await inspector.evaluate('__cherryDesktopProof.inspect()')
    }
    trial.beforeRed = screenshot(`${trial.name}-before`)
    trial.sourceInitiallyActive = trial.before.native.frontmostPid === source.pid && source.exitCode === null
    trial.mainInitiallyInStrip = trial.before.app.main.visible && inStrip(trial.before.native)
    save('cherry-results.json', results)
    if (!trial.sourceInitiallyActive || !trial.mainInitiallyInStrip)
      throw new Error('Trial did not start with the external source active and Main visibly in the Stage Manager strip')
    if (results.trials.length === 4) {
      await inspector.evaluate(`(() => {
        const probe = __cherryDesktopProof;
        probe.trace = process.mainModule.require(${JSON.stringify(join(output, 'activationTrace.node'))});
        probe.trace.start(probe.toolbar.getNativeWindowHandle(), ${JSON.stringify(join(output, 'cherry-guarded-native.jsonl'))}, 60000);
        probe.trace.checkpoint('before-native-click');
      })()`)
    }
    await nativeAsync('click', trial.button.x, trial.button.y)
    await poll('Actual Translate result', () =>
      inspector.evaluate(`__cherryDesktopProof.wm.getWindowsByType('selectionAction')
      .some(window => window.isVisible() && window.webContents.getURL().includes('/selection/action/'))`)
    )
    await delay(1000)
    trial.after = {
      native: JSON.parse(native('snapshot')),
      app: await inspector.evaluate('__cherryDesktopProof.inspect()')
    }
    trial.afterRed = screenshot(`${trial.name}-after`)
    if (results.trials.length === 4) await inspector.evaluate(`__cherryDesktopProof.trace.checkpoint('after-result')`)

    const newInput = trial.after.app.input.slice(trial.before.app.input.length)
    trial.trustedMouseDown = newInput.some(
      (event) => event.type === 'mousedown' && event.trusted && event.label === trial.button.label
    )
    trial.trustedClick = newInput.some(
      (event) => event.type === 'click' && event.trusted && event.label === trial.button.label
    )
    const actions = trial.after.app.actions.slice(trial.before.app.actions.length)
    trial.delivered =
      actions.length === 1 &&
      actions[0].id === 'translate' &&
      actions[0].selectedText === 'The assistant must open independently of its main window.' &&
      trial.after.app.results.some(
        (window) => window.visible && window.url.includes('/selection/action/') && window.initData?.id === 'translate'
      )
    trial.mainFocusedDuringClick = trial.after.app.timeline
      .slice(trial.before.app.timeline.length)
      .some((event) => event.event === 'main.focus')
    trial.mainPromoted =
      mainGeometry(trial.after.native)?.Width >= 500 || trial.after.app.main.focused || trial.mainFocusedDuringClick
    trial.mainRemainedInStrip = trial.after.app.main.visible && inStrip(trial.after.native)
    trial.passed =
      trial.delivered &&
      trial.trustedMouseDown &&
      trial.trustedClick &&
      (guarded
        ? trial.mainRemainedInStrip && !trial.mainPromoted
        : trial.mainPromoted && mainGeometry(trial.after.native)?.Width >= 500)
    save('cherry-results.json', results)
  }
  results.passed = results.trials.length === 4 && results.trials.every((trial) => trial.passed)
  if (!results.passed) throw new Error('Actual Cherry baseline/guard comparison failed; inspect per-trial evidence')
}

function mainGeometry(snapshot) {
  return snapshot.windows.find((window) => window.kCGWindowNumber === results.mainWindowNumber)?.kCGWindowBounds
}

function inStrip(snapshot) {
  const bounds = mainGeometry(snapshot)
  return bounds && bounds.Width > 20 && bounds.Width < 200 && bounds.Height < 200 && bounds.X < 150
}

run()
  .catch((error) => {
    results.error = error.stack
    try {
      screenshot('cherry-failure')
    } catch (captureError) {
      results.captureError = captureError.message
    }
    process.exitCode = 1
  })
  .finally(async () => {
    if (inspector) {
      try {
        results.cleanup = await inspector.evaluate('globalThis.__cherryDesktopProof?.cleanup()')
      } catch (error) {
        results.cleanupError = error.message
        process.exitCode = 1
      }
      inspector.close()
    }
    await stop(cherry)
    await stop(source)
    rmSync(profile, { recursive: true, force: true })
    if (createdBootConfig) rmSync(bootConfigPath, { force: true })
    if (createdBootConfigDirectory) rmSync(bootConfigDirectory, { recursive: true, force: true })
    rmSync(join(output, 'Cherry External Source.app'), { recursive: true, force: true })
    const logs = join(homedir(), 'Library', 'Logs', 'CherryStudio')
    if (startedAt && existsSync(logs))
      for (const name of readdirSync(logs)) {
        if (name.startsWith('app.') && name.endsWith('.log') && statSync(join(logs, name)).mtimeMs >= startedAt)
          copyFileSync(join(logs, name), join(output, `cherry-${name}`))
      }
    results.ownedProcessesStopped = [cherry, source].every(
      (child) => !child || child.exitCode !== null || child.signalCode !== null
    )
    save('cherry-results.json', results)
  })
