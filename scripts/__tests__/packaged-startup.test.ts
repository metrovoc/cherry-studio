import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  launchEnvironment,
  requireHostedMac,
  runtimePaths,
  verifyPackagedStartup
} from '../release/verify-packaged-startup'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-startup-gate-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const output = path.join(root, 'evidence')
  const logs = path.join(home, 'Library/Logs/CherryStudio')
  const profile = path.join(home, 'Library/Application Support/CherryStudio')
  const bootstrap = { process: 'main', module: 'Lifecycle', level: 'info', message: 'Bootstrap complete (123.456ms)' }
  const version = '2.1.8'
  let child: ChildProcess
  let onLaunch = () => {
    fs.writeFileSync(path.join(logs, 'app.2026-01-01.log'), `${JSON.stringify(bootstrap)}\n`)
    fs.writeFileSync(path.join(profile, 'version.log'), `${version}|mac|prod|packaged|install|2026-01-01T00:00:00Z\n`)
  }
  const operations = {
    launch: async () => {
      fs.mkdirSync(logs, { recursive: true })
      fs.mkdirSync(profile, { recursive: true })
      fs.writeFileSync(path.join(profile, 'database.sqlite'), 'blank test profile')
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      children.push(child)
      await once(child, 'spawn')
      onLaunch()
      return child
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    },
    screenshot: (file: string) => fs.writeFileSync(file, 'failure screenshot fixture')
  }
  return {
    home,
    output,
    logs,
    profile,
    bootstrap,
    version,
    operations,
    options: {
      bundle: path.join(root, 'Cherry Studio.app'),
      output,
      home,
      version,
      timeoutMs: 1000,
      stableMs: 30,
      pollMs: 5
    },
    onLaunch: (callback: () => void) => {
      onLaunch = callback
    },
    child: () => child,
    report: () => JSON.parse(fs.readFileSync(path.join(output, 'startup.json'), 'utf8'))
  }
}

describe('packaged startup release gate', () => {
  it('accepts a fresh packaged bootstrap only after continued process health and removes its profile', async () => {
    const test = fixture()
    const report = await verifyPackagedStartup(test.options, test.operations)
    expect(report).toMatchObject({
      version: test.version,
      bootstrap: true,
      packagedVersion: true,
      stable: true,
      cleanup: true
    })
    expect(report.elapsedMs).toBeGreaterThanOrEqual(test.options.stableMs)
    expect(test.child().signalCode).toBe('SIGTERM')
    expect(runtimePaths(test.home).some(fs.existsSync)).toBe(false)
    expect(fs.readFileSync(path.join(test.output, 'app.2026-01-01.log'), 'utf8')).toContain('Bootstrap complete')
    expect(fs.readFileSync(path.join(test.output, 'version.log'), 'utf8')).toContain(test.version)
    expect(fs.existsSync(path.join(test.output, 'database.sqlite'))).toBe(false)
  })

  it('rejects a silent error modal with a living process and captures evidence before stopping it', async () => {
    const test = fixture()
    test.options.timeoutMs = 200
    test.onLaunch(() => {})
    test.operations.screenshot = (file) => {
      expect(test.child().exitCode).toBeNull()
      expect(test.child().signalCode).toBeNull()
      fs.writeFileSync(file, 'modal screenshot')
    }
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('stable bootstrap')
    expect(test.report()).toMatchObject({ bootstrap: false, stable: false, cleanup: true })
    expect(fs.readFileSync(path.join(test.output, 'startup-failure.png'), 'utf8')).toBe('modal screenshot')
    expect(test.child().signalCode).toBe('SIGTERM')
  })

  it.each(['wrong-version', 'unpackaged', 'renderer', 'other-module', 'plain-text'])(
    'rejects %s evidence instead of accepting an unrelated bootstrap marker',
    async (scenario) => {
      const test = fixture()
      test.options.timeoutMs = 200
      test.onLaunch(() => {
        const record = { ...test.bootstrap }
        if (scenario === 'renderer') record.process = 'renderer'
        if (scenario === 'other-module') record.module = 'Other'
        fs.writeFileSync(
          path.join(test.logs, 'app.2026-01-01.log'),
          scenario === 'plain-text' ? record.message : JSON.stringify(record)
        )
        fs.writeFileSync(
          path.join(test.profile, 'version.log'),
          `${scenario === 'wrong-version' ? '2.1.7' : test.version}|mac|prod|${scenario === 'unpackaged' ? 'unpackaged' : 'packaged'}|install|2026-01-01T00:00:00Z\n`
        )
      })
      await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('stable bootstrap')
      expect(test.report()).toMatchObject({ stable: false, cleanup: true })
    }
  )

  it('rejects an exit after bootstrap but before the stability window completes', async () => {
    const test = fixture()
    test.options.stableMs = 150
    const launch = test.operations.launch
    test.operations.launch = async () => {
      const child = await launch()
      child.kill('SIGTERM')
      await once(child, 'exit')
      return child
    }
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('exited during startup')
    expect(test.report()).toMatchObject({ stable: false, cleanup: true })
  })

  it.each([
    ['MainEntry', 'Fatal startup error: fixture'],
    ['Lifecycle', 'Fatal service initialization error: fixture'],
    ['CrashTelemetry', 'Uncaught Exception: fixture'],
    ['CrashTelemetry', 'Unhandled Rejection at: fixture'],
    ['WindowManager', 'Failed to load window content: fixture'],
    ['MainWindowService', 'Renderer process crashed with: fixture']
  ])('rejects a live process reporting %s / %s', async (module, message) => {
    const test = fixture()
    const launch = test.operations.launch
    test.operations.launch = async () => {
      const child = await launch()
      fs.appendFileSync(
        path.join(test.logs, 'app.2026-01-01.log'),
        `${JSON.stringify({ process: 'main', level: 'error', module, message })}\n`
      )
      return child
    }
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow(
      'fatal startup or renderer failure'
    )
    expect(test.report()).toMatchObject({ stable: false, cleanup: true })
  })

  it('still stops the process and preserves logs when screenshot capture fails', async () => {
    const test = fixture()
    test.operations.screenshot = () => {
      throw new Error('capture timeout')
    }
    test.options.stableMs = 300
    test.options.timeoutMs = 200
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('stable bootstrap')
    expect(test.report()).toMatchObject({ cleanup: true, screenshotError: 'capture timeout' })
    expect(fs.existsSync(path.join(test.output, 'app.2026-01-01.log'))).toBe(true)
    expect(test.child().signalCode).toBe('SIGTERM')
  })

  it('fails closed and preserves logs and a live process profile when process cleanup fails', async () => {
    const test = fixture()
    test.operations.stop = async () => {
      throw new Error('process still running')
    }
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('process still running')
    expect(test.report()).toMatchObject({ stable: true, cleanup: false, cleanupError: 'process still running' })
    expect(fs.existsSync(path.join(test.output, 'app.2026-01-01.log'))).toBe(true)
    expect(fs.existsSync(path.join(test.profile, 'database.sqlite'))).toBe(true)
  })

  it.each([0, 1, 2, 3, 4, 5])('preserves existing runtime location %i and never launches', async (index) => {
    const test = fixture()
    const existing = runtimePaths(test.home)[index]
    fs.mkdirSync(path.dirname(existing), { recursive: true })
    fs.writeFileSync(existing, 'existing user state')
    await expect(verifyPackagedStartup(test.options, test.operations)).rejects.toThrow('existing data was preserved')
    expect(fs.readFileSync(existing, 'utf8')).toBe('existing user state')
    expect(test.child()).toBeUndefined()
    expect(fs.existsSync(test.output)).toBe(false)
  })
})

describe('startup gate isolation and publication ordering', () => {
  it.each([
    ['darwin', {}],
    ['darwin', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['linux', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }]
  ])('refuses launch outside an isolated hosted macOS runner (%s / %j)', (platform, environment) => {
    expect(() => requireHostedMac(environment, platform)).toThrow('isolated GitHub-hosted macOS')
  })

  it('excludes credentials and Electron/profile overrides from the launched app', () => {
    expect(
      launchEnvironment({
        HOME: '/runner',
        PATH: '/bin',
        CSC_KEY_PASSWORD: 'private',
        GH_TOKEN: 'private',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require injected.js',
        CS_DEV_PROFILE_ROOT: '/other'
      })
    ).toEqual({ HOME: '/runner', PATH: '/bin' })
  })

  it('requires startup after archive verification for both newly built and resumed releases', () => {
    const workflow = parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/downstream-release.yml'), 'utf8')
    )
    const steps = workflow.jobs.release.steps
    const startup = steps.findIndex((step: { id?: string }) => step.id === 'startup')
    const verification = steps.findIndex((step: { run?: string }) => step.run?.includes('ditto -x -k'))
    const publication = steps.findIndex((step: { run?: string }) => step.run?.includes('--draft=false'))
    expect(startup).toBeGreaterThan(verification)
    expect(publication).toBeGreaterThan(startup)
    expect(steps[startup].if).toBeUndefined()
    expect(steps[startup]['continue-on-error']).toBeUndefined()
    expect(steps[publication].if).toBeUndefined()
    const upload = steps.find((step: { with?: { name?: string } }) =>
      step.with?.name?.startsWith('downstream-startup-failure-')
    )
    expect(upload.if).toBe("failure() && steps.startup.outcome == 'failure'")
    expect(upload.with.path).toBe('${{ runner.temp }}/startup-evidence/')
  })
})
