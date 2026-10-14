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
const { runInteractionChecks } = require('./cherryInteractionChecks.cjs')

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Desktop proof runs only in isolated GitHub Actions')
if (!process.argv[2] || !process.argv[3])
  throw new Error('Usage: cherryDesktopProof.cjs <app bundle or source root> <evidence> [mode] [--tray-startup]')
const bundle = resolve(process.argv[2])
const sourceRoot = existsSync(join(bundle, 'package.json')) ? bundle : null
const output = resolve(process.argv[3])
const mode = process.argv[4] || 'baseline'
if (!['baseline', 'prevents-activation', 'join-all-applications', 'fixed'].includes(mode))
  throw new Error('Unknown actual-app candidate mode')
const trayStartup = process.argv[5] === '--tray-startup'
if (process.argv[5] && !trayStartup) throw new Error('Unknown startup option')
if (trayStartup && (!sourceRoot || mode !== 'fixed')) throw new Error('Tray startup requires source/fixed mode')
const profile = join(output, 'cherry-profile')
const executable = sourceRoot
  ? require(require.resolve('electron', { paths: [sourceRoot] }))
  : join(bundle, 'Contents', 'MacOS', 'Cherry Studio')
const bootConfigDirectory = join(homedir(), '.cherrystudio')
const bootConfigPath = join(bootConfigDirectory, 'boot-config.json')
const helper = join(output, 'desktop-probe')
const native = (...args) => execFileSync(helper, args.map(String), { encoding: 'utf8' })
const nativeAsync = (...args) => promisify(execFile)(helper, args.map(String), { encoding: 'utf8' })
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2))
const results = {
  scope: `${sourceRoot ? 'Built Cherry source' : 'Published Cherry application'}, actual managed toolbar and Translate action, ${mode === 'fixed' ? 'production window behavior' : 'native activation comparison'}`,
  selectionSource: 'selection.text_selected IPC; native selection hook remains disabled',
  mode,
  trials: []
}
let cherry
let source
let inspector
let createdBootConfig = false
let createdBootConfigDirectory = false
let createdProfile = false
let startedAt
const applicationExpression = `Object.values(process.mainModule.require('module')._cache)
  .map(module => module.exports?.application).find(value => value?.get && value?.getPath)`

async function poll(label, operation, timeout = 20000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    if (cherry?.spawnError) throw cherry.spawnError
    if (cherry && (cherry.exitCode !== null || cherry.signalCode !== null))
      throw new Error(`Cherry exited with ${cherry.signalCode || cherry.exitCode}`)
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

async function launchCherry(logPrefix = 'cherry') {
  const stdout = openSync(join(output, `${logPrefix}-stdout.log`), 'w')
  const stderr = openSync(join(output, `${logPrefix}-stderr.log`), 'w')
  try {
    cherry = spawn(
      executable,
      [
        ...(sourceRoot ? [sourceRoot] : []),
        '--inspect=9230',
        '--remote-debugging-port=9444',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`
      ],
      {
        stdio: ['ignore', stdout, stderr],
        cwd: sourceRoot || undefined,
        env: sourceRoot ? { ...process.env, CS_DEV_PROFILE_ROOT: profile } : process.env
      }
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
    const application = ${applicationExpression};
    const main = application?.isReady() && application.get('WindowManager').getWindowsByType('main')[0];
    return !!main && !main.webContents.isLoadingMainFrame();
  })()`),
    60000
  )
}

async function prepareTrayStartup() {
  await launchCherry('cherry-tray-prepare')
  results.trayStartup = {
    prepared: await inspector.evaluate(`(async () => {
    const application = ${applicationExpression};
    const actualProfile = application.getPath('app.userdata');
    if (!actualProfile.startsWith(${JSON.stringify(profile + sep)})) throw Error('Preparation profile is not isolated');
    const preferences = application.get('PreferenceService');
    await preferences.set('app.tray.enabled', true);
    await preferences.set('app.tray.on_launch', true);
    return {pid:process.pid, profile:actualProfile, enabled:preferences.get('app.tray.enabled'), onLaunch:preferences.get('app.tray.on_launch')};
  })()`)
  }
  await inspector.evaluate(`(() => {
    const application = ${applicationExpression};
    setTimeout(() => application.quit(), 100);
    return true;
  })()`)
  inspector.close()
  inspector = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cherry.removeListener('exit', exited)
      reject(new Error('Tray preparation did not quit cleanly'))
    }, 20000)
    const exited = (code, signal) => {
      clearTimeout(timer)
      results.trayStartup.preparationExit = { code, signal }
      if (code === 0 && !signal) resolve()
      else reject(new Error(`Tray preparation exited with ${signal || code}`))
    }
    if (cherry.exitCode !== null || cherry.signalCode !== null) exited(cherry.exitCode, cherry.signalCode)
    else cherry.once('exit', exited)
  })
}

async function captureTrayStartup() {
  await poll('Tray launch suppression completed', () =>
    inspector.evaluate(`(() => {
    const application = ${applicationExpression};
    return application.get('MainWindowService').suppressInitialLaunchShow === false;
  })()`)
  )
  results.trayStartup.native = await poll('Native accessory startup policy', () => {
    const state = JSON.parse(native('application', cherry.pid))
    results.trayStartup.native = state
    return state.activationPolicy === 1 && !state.terminated ? state : false
  })
  results.trayStartup.started = await inspector.evaluate(`(() => {
    const application = ${applicationExpression};
    const preferences = application.get('PreferenceService'), tray = application.get('TrayService');
    const main = application.get('WindowManager').getWindowsByType('main')[0];
    return {pid:process.pid, enabled:preferences.get('app.tray.enabled'), onLaunch:preferences.get('app.tray.on_launch'),
      trayActivated:tray.isActivated, trayPresent:!!tray.tray && !tray.tray.isDestroyed(), mainVisible:main.isVisible(),
      dockVisible:process.mainModule.require('electron').app.dock.isVisible()};
  })()`)
  results.trayStartup.windows = JSON.parse(native('snapshot'))
  results.trayStartup.image = screenshot('cherry-tray-startup')
  save('cherry-results.json', results)
  const started = results.trayStartup.started
  if (
    !started.enabled ||
    !started.onLaunch ||
    !started.trayActivated ||
    !started.trayPresent ||
    started.mainVisible ||
    started.dockVisible ||
    results.trayStartup.native.activationPolicy !== 1
  )
    throw new Error('Relaunch did not enter the real accessory tray startup state')
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
      throw Error('App did not honor its isolated profile: ' + actualProfile);
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
      record, css:null, toolbar:null, actions:[],
      async cleanup() {
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
    if (${['prevents-activation', 'join-all-applications'].includes(mode)}) {
      probe.candidate = require(${JSON.stringify(join(output, 'candidateOptions.node'))});
      probe.candidateBeforeShow = JSON.parse(probe.candidate.apply(toolbar.getNativeWindowHandle(), ${JSON.stringify(mode)}));
    }
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
      actions:probe.actions, timeline, input:await toolbar.webContents.executeJavaScript('window.__desktopInput || []'),
      candidate:probe.candidate && JSON.parse(probe.candidate.snapshot(toolbar.getNativeWindowHandle()))
    });
    return {pid:process.pid, version:electron.app.getVersion(), electron:process.versions.electron,
      profile:actualProfile, logs:application.getPath('app.logs'), toolbarId:id, toolbarBrowserWindowId:toolbar.id,
      mainBrowserWindowId:main.id, selectionEnabled:preferences.get('feature.selection.enabled'),
      candidateBeforeShow:probe.candidateBeforeShow};
  })()`)
}

async function run() {
  mkdirSync(output, { recursive: true })
  if (existsSync(profile)) throw new Error('Owned proof profile must be fresh')
  mkdirSync(profile, { recursive: true })
  createdProfile = true
  results.capabilities = JSON.parse(native('capabilities'))
  if (!results.capabilities.postEvents || !results.capabilities.accessibility || !results.capabilities.screenCapture)
    throw new Error('Runner lacks existing native input, accessibility, or capture permissions')
  results.stageManagerEnabled =
    execFileSync('defaults', ['read', 'com.apple.WindowManager', 'GloballyEnabled'], { encoding: 'utf8' }).trim() ===
    '1'
  if (!results.stageManagerEnabled) throw new Error('Stage Manager is not enabled')
  if (!sourceRoot) {
    if (existsSync(bootConfigPath)) throw new Error('Hosted runner already has a Cherry boot configuration')
    createdBootConfigDirectory = !existsSync(bootConfigDirectory)
    mkdirSync(bootConfigDirectory, { recursive: true })
    writeFileSync(bootConfigPath, JSON.stringify({ 'app.user_data_path': { [executable]: profile } }))
    createdBootConfig = true
  }
  startedAt = Date.now()
  if (trayStartup) await prepareTrayStartup()
  await launchCherry()
  if (trayStartup) await captureTrayStartup()
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
  await inspector.evaluate('__cherryDesktopProof.application.get("MainWindowService").showMainWindow()')
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
  for (const guarded of [mode !== 'baseline', mode !== 'baseline']) {
    const trial = { guarded, name: `cherry-${results.trials.length}-${guarded ? 'guarded' : 'baseline'}` }
    results.trials.push(trial)
    await inspector.evaluate(`(() => {
      const probe = __cherryDesktopProof;
      probe.service.closeActionWindows();
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
    if (mode === 'fixed' && trial.passed) {
      trial.resultInteraction = await interactWithResult(trial)
      trial.passed = trial.resultInteraction.passed
    }
    save('cherry-results.json', results)
  }
  results.passed = results.trials.length === 2 && results.trials.every((trial) => trial.passed)
  if (!results.passed) throw new Error('Actual Cherry window behavior checks failed; inspect per-trial evidence')
  if (mode === 'fixed') {
    results.interactions = await runInteractionChecks({
      evaluate: inspector.evaluate.bind(inspector),
      nativeAsync,
      native,
      screenshot,
      output
    })
    results.passed = results.interactions.passed
  }
}

function mainGeometry(snapshot) {
  return snapshot.windows.find((window) => window.kCGWindowNumber === results.mainWindowNumber)?.kCGWindowBounds
}

function inStrip(snapshot) {
  const bounds = mainGeometry(snapshot)
  return bounds && bounds.Width > 20 && bounds.Width < 200 && bounds.Height < 200 && bounds.X < 150
}

async function interactWithResult(trial) {
  const result = trial.after.app.results.find((window) => window.visible && window.initData?.id === 'translate')
  const evidence = (trial.resultInteraction = { resultId: result.id, steps: [] })
  const windowExpression = `__cherryDesktopProof.wm.getWindow(${JSON.stringify(result.id)})`
  const renderer = (expression) =>
    inspector.evaluate(`${windowExpression}.webContents.executeJavaScript(${JSON.stringify(expression)})`)
  const capture = async (name) => {
    const step = {
      name,
      native: JSON.parse(native('snapshot')),
      app: await inspector.evaluate('__cherryDesktopProof.inspect()'),
      image: screenshot(`${trial.name}-result-${name}`)
    }
    step.mainRemainedInStrip =
      step.app.main.visible &&
      inStrip(step.native) &&
      !step.app.main.focused &&
      !step.app.timeline.slice(trial.after.app.timeline.length).some((event) => event.event === 'main.focus')
    evidence.steps.push(step)
    save('cherry-results.json', results)
  }
  try {
    evidence.input = await poll('Editable Translate language search', () =>
      inspector.evaluate(`(async () => {
      const window = ${windowExpression};
      const rect = await window.webContents.executeJavaScript(${JSON.stringify(`(() => {
        const input = document.querySelector('[data-ui="selection.action"] input[role="combobox"]:not(:disabled)');
        if (!input) return false;
        const rect = input.getBoundingClientRect();
        return rect.width && rect.height ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : false;
      })()`)});
      if (!rect) return false;
      const bounds = window.getBounds(), zoom = window.webContents.getZoomFactor();
      return {x:Math.round(bounds.x+(rect.x+rect.width/2)*zoom),y:Math.round(bounds.y+(rect.y+rect.height/2)*zoom)};
    })()`)
    )
    await renderer(`window.__ordinaryInput = [];
      window.__ordinaryInputHandler = event => {
        if (event.target.matches?.('input[role="combobox"]')) window.__ordinaryInput.push({
          type:event.type,trusted:event.isTrusted,value:event.target.value,at:Date.now()
        });
      };
      for (const type of ['mousedown','click','input']) window.addEventListener(type,window.__ordinaryInputHandler,true);`)
    await nativeAsync('click', evidence.input.x, evidence.input.y)
    await poll('Translate search keyboard focus', () =>
      renderer(`
      document.activeElement?.matches('[data-ui="selection.action"] input[role="combobox"][aria-expanded="true"]')`)
    )
    await capture('input-focused')
    await nativeAsync('type', 'French')
    await poll('Native text input', () => renderer(`document.activeElement?.value === 'French'`))
    evidence.typed = await renderer(`({value:document.activeElement.value,events:window.__ordinaryInput})`)
    await capture('typed')
    await nativeAsync('click', result.bounds.x + 30, result.bounds.y + result.bounds.height - 80)
    await poll('Language popup closed', () =>
      renderer(`
      !document.querySelector('[data-ui="selection.action"] input[role="combobox"][aria-expanded="true"]')`)
    )
    await capture('popup-closed')
    evidence.drag = await inspector.evaluate(`(() => {
      const before = ${windowExpression}.getBounds();
      const area = process.mainModule.require('electron').screen.getDisplayMatching(before).workArea;
      return {before,dx:before.x+before.width+60<=area.x+area.width?60:-60,
        dy:before.y+before.height+45<=area.y+area.height?45:-45};
    })()`)
    await nativeAsync(
      'drag',
      evidence.drag.before.x + 180,
      evidence.drag.before.y + 16,
      evidence.drag.dx,
      evidence.drag.dy
    )
    evidence.drag.after = await inspector.evaluate(`${windowExpression}.getBounds()`)
    await capture('dragged')
    evidence.passed =
      evidence.typed.value === 'French' &&
      ['mousedown', 'click', 'input'].every((type) =>
        evidence.typed.events.some((event) => event.type === type && event.trusted)
      ) &&
      evidence.steps.every((step) => step.mainRemainedInStrip) &&
      Math.abs(evidence.drag.after.x - evidence.drag.before.x - evidence.drag.dx) <= 2 &&
      Math.abs(evidence.drag.after.y - evidence.drag.before.y - evidence.drag.dy) <= 2 &&
      evidence.drag.after.width === evidence.drag.before.width &&
      evidence.drag.after.height === evidence.drag.before.height
    return evidence
  } finally {
    await renderer(`for (const type of ['mousedown','click','input'])
      window.removeEventListener(type,window.__ordinaryInputHandler,true);
      delete window.__ordinaryInput; delete window.__ordinaryInputHandler;`)
  }
}

run()
  .catch((error) => {
    results.passed = false
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
        results.passed = false
        process.exitCode = 1
      }
      inspector.close()
    }
    await stop(cherry)
    await stop(source)
    try {
      const logs =
        results.application?.logs ||
        (sourceRoot ? join(profile, 'logs') : join(homedir(), 'Library', 'Logs', 'CherryStudio'))
      if (startedAt && existsSync(logs))
        for (const name of readdirSync(logs)) {
          if (name.startsWith('app.') && name.endsWith('.log') && statSync(join(logs, name)).mtimeMs >= startedAt)
            copyFileSync(join(logs, name), join(output, `cherry-${name}`))
        }
      const reports = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
      if (startedAt && existsSync(reports))
        for (const name of readdirSync(reports)) {
          if (
            /^(Cherry Studio|Electron)[_-].*\.(ips|crash)$/.test(name) &&
            statSync(join(reports, name)).mtimeMs >= startedAt
          )
            copyFileSync(join(reports, name), join(output, name))
        }
    } catch (error) {
      results.evidenceError = error.stack
      results.passed = false
      process.exitCode = 1
    } finally {
      if (createdProfile) rmSync(profile, { recursive: true, force: true })
      if (createdBootConfig) rmSync(bootConfigPath, { force: true })
      if (createdBootConfigDirectory) rmSync(bootConfigDirectory, { recursive: true, force: true })
      rmSync(join(output, 'Cherry External Source.app'), { recursive: true, force: true })
    }
    results.ownedProcessesStopped = [cherry, source].every(
      (child) => !child || child.exitCode !== null || child.signalCode !== null
    )
    save('cherry-results.json', results)
  })
