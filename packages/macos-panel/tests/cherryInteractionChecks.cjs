const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

async function runInteractionChecks({ evaluate, nativeAsync, native, screenshot, output }) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Interaction checks require isolated GitHub Actions')
  const report = {
    scope: 'Actual Cherry result and Quick Assistant windows with WindowServer mouse input',
    selectionSource: 'Native selection in Quick input, forwarded through selection.text_selected; hook disabled',
    toastFixture: 'Actual Copy Original error toast, with a temporary rejected clipboard write; no replacement DOM',
    checks: [],
    passed: false
  }
  let failure
  const save = () => writeFileSync(join(output, 'cherry-interactions.json'), JSON.stringify(report, null, 2))
  const app = (fn, ...args) => evaluate(`(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  async function poll(label, operation) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await operation()
      if (value) return value
      await delay(50)
    }
    throw new Error(`${label} timed out`)
  }
  const state = () => app(() => globalThis.__cherryDesktopProof.interactions.inspect())
  const renderer = (id, expression) =>
    app(
      (id, expression) => globalThis.__cherryDesktopProof.wm.getWindow(id).webContents.executeJavaScript(expression),
      id,
      expression
    )
  const capture = async (name) => ({
    app: await state(),
    native: JSON.parse(native('snapshot')),
    image: screenshot(name)
  })
  async function finishDrag(name) {
    const drag = await poll(name, () =>
      app((name) => {
        const drag = globalThis.__cherryDesktopProof.interactions.drags[name]
        return drag?.done ? drag : null
      }, name)
    )
    const evidence = { name, drag, after: await capture(`interaction-${name}`) }
    report.checks.push(evidence)
    evidence.passed =
      !drag.error &&
      drag.after &&
      Math.abs(drag.after.x - drag.before.x - drag.dx) <= 2 &&
      Math.abs(drag.after.y - drag.before.y - drag.dy) <= 2 &&
      drag.after.width === drag.before.width &&
      drag.after.height === drag.before.height
    save()
    check(evidence.passed, `${name}: the first native drag did not move the result by its requested delta`)
    return evidence
  }
  function cgWindow(snapshot, window) {
    const matches = snapshot.windows.filter((item) => {
      const bounds = item.kCGWindowBounds
      return (
        item.kCGWindowOwnerPID === report.pid &&
        item.kCGWindowIsOnscreen &&
        Math.abs(bounds.X - window.bounds.x) <= 1 &&
        Math.abs(bounds.Y - window.bounds.y) <= 1 &&
        Math.abs(bounds.Width - window.bounds.width) <= 1 &&
        Math.abs(bounds.Height - window.bounds.height) <= 1
      )
    })
    check(matches.length === 1, `Cannot uniquely identify visible window ${window.id} in WindowServer`)
    return {
      number: matches[0].kCGWindowNumber,
      index: snapshot.windows.indexOf(matches[0]),
      layer: matches[0].kCGWindowLayer
    }
  }
  async function checkStack(name, resultId) {
    const evidence = { name, ...(await capture(`interaction-${name}`)) }
    report.checks.push(evidence)
    const quick = evidence.app.quick
    const result = evidence.app.results.find((window) => window.id === resultId)
    check(quick?.visible && result?.visible, `${name}: Quick or result is hidden`)
    const q = quick.bounds,
      r = result.bounds
    evidence.overlap = {
      width: Math.min(q.x + q.width, r.x + r.width) - Math.max(q.x, r.x),
      height: Math.min(q.y + q.height, r.y + r.height) - Math.max(q.y, r.y)
    }
    evidence.quick = cgWindow(evidence.native, quick)
    evidence.result = cgWindow(evidence.native, result)
    evidence.passed =
      evidence.overlap.width > 100 && evidence.overlap.height > 100 && evidence.result.index < evidence.quick.index
    save()
    check(evidence.passed, `${name}: result does not visibly overlap above Quick Assistant`)
    return evidence
  }

  try {
    report.pid = await app(
      async (helper) => {
        if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Native gestures are CI-only')
        const probe = globalThis.__cherryDesktopProof
        const { wm, service, preferences } = probe
        if (service.getSelectionHook() || preferences.get('feature.selection.enabled'))
          throw Error('Selection hook must remain disabled')
        if (preferences.get('feature.quick_assistant.enabled'))
          throw Error('Interaction checks require a fresh disabled Quick Assistant')
        if (probe.interactions) throw Error('Interaction checks are already installed')
        const saved = new Map()
        const servicePositioning = {
          isFollowToolbar: service.isFollowToolbar,
          isRemeberWinSize: service.isRemeberWinSize
        }
        const jobs = new Set()
        const disposers = []
        const sessionState = (id) => {
          const session = service.actionWindows.get(id)
          return {
            requestId: session?.data.requestId ?? null,
            ready: session?.ready ?? null,
            storedRequestId: wm.getInitData(id)?.requestId ?? null
          }
        }
        const describe = (window) => ({
          id: wm.getWindowId(window),
          browserWindowId: window.id,
          nativeHandle: window.getNativeWindowHandle().toString('hex'),
          bounds: window.getBounds(),
          visible: window.isVisible(),
          maximized: window.isMaximized(),
          fullscreen: window.isFullScreen(),
          simpleFullscreen: window.isSimpleFullScreen(),
          minimized: window.isMinimized(),
          url: window.webContents.getURL(),
          initData: wm.getInitData(wm.getWindowId(window)),
          session: sessionState(wm.getWindowId(window))
        })
        const fixture = (probe.interactions = {
          drags: {},
          events: [],
          quick: null,
          inspect: () => ({
            quick: fixture.quick && !fixture.quick.isDestroyed() ? describe(fixture.quick) : null,
            results: wm.getWindowsByType('selectionAction').map(describe),
            events: fixture.events,
            actions: probe.actions
          }),
          closeResults() {
            wm.suspendPool('selectionAction')
            for (const window of wm.getWindowsByType('selectionAction')) wm.close(wm.getWindowId(window))
          },
          open(text) {
            const action = preferences
              .get('feature.selection.action_items')
              .find((action) => action.id === 'translate' && action.enabled)
            if (!action) throw Error('Translate action is unavailable')
            service.processAction({ ...action, selectedText: text })
            const window = wm
              .getWindowsByType('selectionAction')
              .find((window) => wm.getInitData(wm.getWindowId(window))?.selectedText === text)
            if (!window) throw Error('Action session was not created')
            return describe(window)
          },
          drag(window, name, trigger) {
            const before = window.getBounds()
            const area = process.mainModule.require('electron').screen.getDisplayMatching(before).workArea
            const dx = before.x + before.width + 60 <= area.x + area.width ? 60 : -60
            const dy = before.y + before.height + 45 <= area.y + area.height ? 45 : -45
            const headerY = name === 'toast-first-drag' ? 28 : 16
            const drag = (fixture.drags[name] = {
              trigger,
              before,
              dx,
              dy,
              headerY,
              at: Date.now(),
              id: wm.getWindowId(window),
              browserWindowId: window.id,
              requestId: wm.getInitData(wm.getWindowId(window))?.requestId
            })
            let child
            const job = new Promise((resolve) => {
              child = process.mainModule
                .require('node:child_process')
                .execFile(
                  helper,
                  ['drag', before.x + 180, before.y + headerY, dx, dy].map(String),
                  { timeout: 6000 },
                  (error, stdout, stderr) => {
                    drag.error = error?.message
                    drag.stdout = stdout
                    drag.stderr = stderr
                    drag.after = window.isDestroyed() ? null : window.getBounds()
                    drag.done = true
                    drag.completedAt = Date.now()
                    resolve()
                  }
                )
            })
            jobs.add(job)
            void job.finally(() => jobs.delete(job))
            disposers.push(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill()
            })
          },
          arm(window, name) {
            const shown = () => fixture.drag(window, name, 'native-show-event')
            window.once('show', shown)
            disposers.push(() => {
              if (!window.isDestroyed()) window.removeListener('show', shown)
            })
          },
          async cleanup() {
            for (const dispose of disposers) dispose()
            await Promise.all(jobs)
            service.hideToolbar()
            fixture.closeResults()
            await preferences.set('feature.quick_assistant.enabled', false)
            await probe.application.get('QuickAssistantService').deactivate()
            for (const [key, value] of saved) await preferences.set(key, value)
            Object.assign(service, servicePositioning)
            delete probe.interactions
            return { restored: true, nativeJobs: jobs.size, hookLoaded: !!service.getSelectionHook() }
          }
        })
        const readyDescriptor = Object.getOwnPropertyDescriptor(service, 'markActionWindowReady')
        const markReady = service.markActionWindowReady
        Object.defineProperty(service, 'markActionWindowReady', {
          configurable: true,
          writable: true,
          value(id, requestId) {
            const record = (event) =>
              fixture.events.push({ event, id, requestId, at: Date.now(), session: sessionState(id) })
            record('renderer-ready-before')
            try {
              return markReady.call(this, id, requestId)
            } finally {
              record('renderer-ready-after')
            }
          }
        })
        disposers.push(() => {
          if (readyDescriptor) Object.defineProperty(service, 'markActionWindowReady', readyDescriptor)
          else delete service.markActionWindowReady
        })
        service.isFollowToolbar = false
        service.isRemeberWinSize = false
        for (const [key, value] of Object.entries({
          'app.language': 'en-US',
          'feature.quick_assistant.read_clipboard_at_startup': false
        })) {
          saved.set(key, preferences.get(key))
          await preferences.set(key, value)
        }
        fixture.closeResults()
        service.hideToolbar()
        const subscription = wm.onWindowCreatedByType('selectionAction', ({ window }) => {
          for (const event of ['show', 'hide', 'move', 'resize', 'maximize', 'enter-full-screen']) {
            const listener = () => {
              const id = wm.getWindowId(window)
              fixture.events.push({ event, id, at: Date.now(), bounds: window.getBounds(), session: sessionState(id) })
            }
            window.on(event, listener)
            disposers.push(() => {
              if (!window.isDestroyed()) window.removeListener(event, listener)
            })
          }
        })
        disposers.push(() => subscription.dispose())
        return process.pid
      },
      join(output, 'desktop-probe')
    )

    report.cold = await app(() => {
      const { wm, interactions: fixture } = globalThis.__cherryDesktopProof
      const created = []
      const subscription = wm.onWindowCreatedByType('selectionAction', ({ window }) => {
        created.push(window.id)
        fixture.arm(window, 'cold-first-drag')
      })
      try {
        wm.resumePool('selectionAction')
        const result = fixture.open('Cold result first drag')
        if (created.length !== 1 || created[0] !== result.browserWindowId || result.visible)
          throw Error('Cold result must be a newly created window awaiting its first native show')
        return result
      } finally {
        // Keep the in-use window tracked without an idle spare taking its next pool slot.
        wm.suspendPool('selectionAction')
        subscription.dispose()
      }
    })
    await finishDrag('cold-first-drag')

    report.reused = await app((id) => {
      const { wm, interactions: fixture } = globalThis.__cherryDesktopProof
      wm.resumePool('selectionAction')
      wm.close(id)
      const window = wm.getWindow(id)
      if (!window || window.isVisible()) throw Error('Original result was not returned to the pool')
      fixture.arm(window, 'reused-first-drag')
      return fixture.open('Reused result first drag')
    }, report.cold.id)
    check(
      report.reused.browserWindowId === report.cold.browserWindowId &&
        report.reused.nativeHandle === report.cold.nativeHandle &&
        report.reused.initData.requestId !== report.cold.initData.requestId,
      'Reuse check did not obtain the same BrowserWindow with a new request'
    )
    await finishDrag('reused-first-drag')

    report.toast = await app(() => {
      const fixture = globalThis.__cherryDesktopProof.interactions
      fixture.closeResults()
      return fixture.open('Original text for a controlled clipboard failure')
    })
    await poll('Toast result visible', () =>
      app((id) => globalThis.__cherryDesktopProof.wm.getWindow(id)?.isVisible(), report.toast.id)
    )
    await poll('Show Original control', () =>
      renderer(
        report.toast.id,
        `(() => {
      const button = [...document.querySelectorAll('[data-ui="selection.action"] button')].find(button => button.textContent.trim() === 'Show Original');
      if (!button) return false;
      button.click(); return true;
    })()`
      )
    )
    await poll('Copy Original control', () =>
      renderer(report.toast.id, `!!document.querySelector('button[aria-label="Copy Original"]')`)
    )
    await renderer(
      report.toast.id,
      `(() => {
      const clipboard = navigator.clipboard;
      const descriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      Object.defineProperty(clipboard, 'writeText', { configurable:true, value:() => Promise.reject(Error('Desktop proof clipboard failure')) });
      try { document.querySelector('button[aria-label="Copy Original"]').click(); }
      finally { if (descriptor) Object.defineProperty(clipboard, 'writeText', descriptor); else delete clipboard.writeText; }
    })()`
    )
    report.toast.visible = await poll('Real error toast', () =>
      renderer(
        report.toast.id,
        `(() => {
      const toast = document.querySelector('[role="region"][aria-label="notifications"]');
      if (!toast || !toast.textContent.includes('Copy failed')) return false;
      const rect = toast.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? {text:toast.textContent, top:rect.top, bottom:rect.bottom} : false;
    })()`
      )
    )
    report.toast.before = await capture('interaction-toast-before-drag')
    report.toast.visibleAtDrag = await app(async (id) => {
      const { wm, interactions: fixture } = globalThis.__cherryDesktopProof
      const window = wm.getWindow(id)
      const visible = await window.webContents.executeJavaScript(`(() => {
        const toast = document.querySelector('[role="region"][aria-label="notifications"]');
        return !!toast && toast.textContent.includes('Copy failed') && toast.getBoundingClientRect().height > 0;
      })()`)
      if (!visible) throw Error('Toast expired before the native drag could begin')
      fixture.drag(window, 'toast-first-drag', 'visible-product-toast-after-clipboard-failure')
      return visible
    }, report.toast.id)
    await finishDrag('toast-first-drag')

    report.doubleClickSetting = execFileSync('defaults', ['read', '-g', 'AppleActionOnDoubleClick'], {
      encoding: 'utf8'
    }).trim()
    check(
      ['Maximize', 'Fill'].includes(report.doubleClickSetting),
      'Set AppleActionOnDoubleClick to Maximize or Fill before launching the tested app'
    )
    const doubleClick = { name: 'native-titlebar-double-click', before: await state() }
    report.checks.push(doubleClick)
    const before = doubleClick.before.results.find((window) => window.id === report.toast.id)
    await nativeAsync('click', before.bounds.x + 180, before.bounds.y + 16, 2)
    await delay(1000)
    doubleClick.after = await capture('interaction-double-click')
    const after = doubleClick.after.app.results.find((window) => window.id === report.toast.id)
    doubleClick.passed =
      after?.visible &&
      ['x', 'y', 'width', 'height'].every((key) => after.bounds[key] === before.bounds[key]) &&
      !after.maximized &&
      !after.fullscreen &&
      !after.simpleFullscreen &&
      !after.minimized &&
      !doubleClick.after.app.events
        .slice(doubleClick.before.events.length)
        .some(
          (event) => event.id === report.toast.id && ['resize', 'maximize', 'enter-full-screen'].includes(event.event)
        )
    save()
    check(doubleClick.passed, 'Native title-bar double-click changed result geometry or presentation')

    await app(async () => {
      const { application, preferences, interactions: fixture } = globalThis.__cherryDesktopProof
      fixture.closeResults()
      await preferences.set('feature.quick_assistant.enabled', true)
      await application.get('QuickAssistantService').activate()
      application.get('QuickAssistantService').setPinQuickAssistant(false)
      application.get('QuickAssistantService').showQuickAssistant()
      fixture.quick = globalThis.__cherryDesktopProof.wm.getWindowsByType('quickAssistant')[0]
      fixture.quick.setBounds({ x: 290, y: 170, width: 550, height: 400 })
    })
    report.quickInput = await poll('Actual Quick Assistant input', () =>
      app(async () => {
        const window = globalThis.__cherryDesktopProof.interactions.quick
        if (window.webContents.isLoadingMainFrame()) return false
        const rect = await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[data-ui="quick-assistant.view"] input');
        if (!input || input.disabled) return false;
        const rect = input.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,value:input.value};
      })()`)
        if (!rect || !rect.width) return false
        const bounds = window.getBounds(),
          zoom = window.webContents.getZoomFactor()
        return {
          id: globalThis.__cherryDesktopProof.wm.getWindowId(window),
          value: rect.value,
          x: Math.round(bounds.x + (rect.x + 1) * zoom),
          y: Math.round(bounds.y + (rect.y + rect.height / 2) * zoom),
          width: Math.round((rect.width - 2) * zoom)
        }
      })
    )
    check(report.quickInput.value === '', 'Fresh Quick Assistant input is not empty')
    await nativeAsync('click', report.quickInput.x, report.quickInput.y)
    await app(async () => {
      await globalThis.__cherryDesktopProof.interactions.quick.webContents.insertText('Selection from Quick Assistant')
    })
    await renderer(
      report.quickInput.id,
      `window.__interactionInput = []; window.__interactionInputHandler = event => {
      window.__interactionInput.push({type:event.type,trusted:event.isTrusted});
    }; for (const type of ['mousedown','mouseup','select']) window.addEventListener(type,window.__interactionInputHandler,true);`
    )
    await nativeAsync(
      'drag',
      report.quickInput.x + report.quickInput.width,
      report.quickInput.y,
      -report.quickInput.width,
      0
    )
    report.selection = await renderer(
      report.quickInput.id,
      `(() => {
      const input = document.querySelector('[data-ui="quick-assistant.view"] input');
      return {text:input.value.slice(input.selectionStart,input.selectionEnd), input:window.__interactionInput};
    })()`
    )
    check(
      report.selection.text === 'Selection from Quick Assistant' &&
        ['mousedown', 'mouseup'].every((type) =>
          report.selection.input.some((event) => event.type === type && event.trusted)
        ),
      'Native Quick input gesture did not select the expected real text'
    )
    report.quickBeforeAction = await state()
    const button = await app(
      async (text, point) => {
        const probe = globalThis.__cherryDesktopProof
        probe.application.get('IpcApiService').send(probe.id, 'selection.text_selected', {
          text,
          programName: 'Cherry Studio',
          startTop: point,
          startBottom: point,
          endTop: point,
          endBottom: point,
          mousePosStart: point,
          mousePosEnd: point,
          method: 1,
          posLevel: 0,
          isFullscreen: false
        })
        probe.service.showToolbarAtPosition(point, 'bottomRight')
        const index = probe.preferences
          .get('feature.selection.action_items')
          .filter((action) => action.enabled)
          .findIndex((action) => action.id === 'translate')
        const rect = await probe.toolbar.webContents.executeJavaScript(`(index => {
        window.__interactionInput = [];
        window.__interactionInputHandler = event => window.__interactionInput.push({type:event.type,trusted:event.isTrusted,label:event.target.closest?.('button')?.getAttribute('aria-label')});
        for (const type of ['mousedown','click']) window.addEventListener(type,window.__interactionInputHandler,true);
        const button = document.querySelectorAll('[data-ui="selection.toolbar"] button')[index];
        if (!button || button.disabled) throw Error('Translate button is unavailable');
        const rect = button.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,label:button.getAttribute('aria-label')};
      })(${index})`)
        const bounds = probe.toolbar.getBounds(),
          zoom = probe.toolbar.webContents.getZoomFactor()
        return {
          label: rect.label,
          x: Math.round(bounds.x + (rect.x + rect.width / 2) * zoom),
          y: Math.round(bounds.y + (rect.y + rect.height / 2) * zoom)
        }
      },
      report.selection.text,
      { x: report.quickInput.x + report.quickInput.width, y: report.quickInput.y + 20 }
    )
    await nativeAsync('click', button.x, button.y)
    report.quickResult = await poll('Quick selection result', async () => {
      const current = await state()
      return current.results.find((window) => window.visible && window.initData?.selectedText === report.selection.text)
    })
    const current = await state()
    report.quickActions = current.actions.slice(report.quickBeforeAction.actions.length)
    report.quickToolbarInput = await app(() =>
      globalThis.__cherryDesktopProof.toolbar.webContents.executeJavaScript('window.__interactionInput')
    )
    check(
      report.quickActions.length === 1 &&
        report.quickActions[0].id === 'translate' &&
        report.quickActions[0].selectedText === report.selection.text &&
        current.results.filter((window) => window.visible).length === 1 &&
        report.quickResult.url.includes('/selection/action/') &&
        ['mousedown', 'click'].every((type) =>
          report.quickToolbarInput.some((event) => event.type === type && event.trusted && event.label === button.label)
        ),
      'Quick selection did not deliver exactly one actual Translate action and result through a trusted toolbar click'
    )
    await checkStack('quick-result-stack', report.quickResult.id)
    const resultButton = await app(async (id) => {
      const window = globalThis.__cherryDesktopProof.wm.getWindow(id)
      const rect = await window.webContents.executeJavaScript(`(() => {
        window.__interactionInput = [];
        window.__interactionInputHandler = event => window.__interactionInput.push({type:event.type,trusted:event.isTrusted});
        for (const type of ['mousedown','click']) window.addEventListener(type,window.__interactionInputHandler,true);
        const button = [...document.querySelectorAll('[data-ui="selection.action"] button')].find(button => button.textContent.trim() === 'Show Original');
        if (!button) throw Error('Result Show Original control is unavailable');
        const rect = button.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      })()`)
      const bounds = window.getBounds(),
        zoom = window.webContents.getZoomFactor()
      return {
        x: Math.round(bounds.x + (rect.x + rect.width / 2) * zoom),
        y: Math.round(bounds.y + (rect.y + rect.height / 2) * zoom)
      }
    }, report.quickResult.id)
    const quickBounds = (await state()).quick.bounds
    check(
      resultButton.x > quickBounds.x &&
        resultButton.x < quickBounds.x + quickBounds.width &&
        resultButton.y > quickBounds.y &&
        resultButton.y < quickBounds.y + quickBounds.height,
      'Result click target must overlap Quick Assistant to prove click delivery'
    )
    await nativeAsync('click', resultButton.x, resultButton.y)
    report.resultClick = await renderer(
      report.quickResult.id,
      `(() => ({
      input:window.__interactionInput,
      originalShown:[...document.querySelectorAll('[data-ui="selection.action"] button')].some(button => button.textContent.trim() === 'Hide Original')
    }))()`
    )
    check(
      report.resultClick.originalShown &&
        ['mousedown', 'click'].every((type) =>
          report.resultClick.input.some((event) => event.type === type && event.trusted)
        ),
      'Clicking the overlapping result did not reach its actual Show Original control'
    )
    await checkStack('quick-result-click-stack', report.quickResult.id)
    await app(() => globalThis.__cherryDesktopProof.application.get('QuickAssistantService').hideQuickAssistant())
    await delay(300)
    report.quickHidden = await capture('interaction-quick-hidden')
    check(
      !report.quickHidden.app.quick.visible &&
        report.quickHidden.app.results.some((window) => window.id === report.quickResult.id && window.visible),
      'Hiding Quick Assistant also hid the result'
    )
    await app(() => globalThis.__cherryDesktopProof.application.get('QuickAssistantService').showQuickAssistant())
    await delay(300)
    await checkStack('quick-reopened-result-stack', report.quickResult.id)
    report.passed = report.checks.every((entry) => entry.passed)
  } catch (error) {
    failure = error
    report.error = error.stack
    try {
      report.failure = await capture('interaction-failure')
    } catch (captureError) {
      report.captureError = captureError.message
    }
  } finally {
    try {
      report.cleanup = await app(async () => {
        const probe = globalThis.__cherryDesktopProof
        if (!probe?.interactions) return { installed: false }
        const errors = []
        for (const window of [
          probe.toolbar,
          probe.interactions.quick,
          ...probe.wm.getWindowsByType('selectionAction')
        ]) {
          if (!window || window.isDestroyed()) continue
          try {
            await window.webContents.executeJavaScript(`for (const type of ['mousedown','mouseup','select','click'])
              window.removeEventListener(type,window.__interactionInputHandler,true);
              delete window.__interactionInput; delete window.__interactionInputHandler;`)
          } catch (error) {
            errors.push(error.message)
          }
        }
        const cleaned = await probe.interactions.cleanup()
        if (errors.length) throw Error(errors.join('; '))
        return cleaned
      })
    } catch (error) {
      report.cleanupError = error.stack
      report.passed = false
    }
    save()
    if (report.cleanupError && !failure) failure = new Error(`Interaction cleanup failed: ${report.cleanupError}`)
  }
  if (failure) throw failure
  return report
}

module.exports = { runInteractionChecks }
