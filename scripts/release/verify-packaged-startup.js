const { execFileSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

function requireHostedMac(environment = process.env, platform = process.platform) {
  if (
    platform !== 'darwin' ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.RUNNER_ENVIRONMENT !== 'github-hosted'
  ) {
    throw new Error('Packaged startup verification requires an isolated GitHub-hosted macOS runner')
  }
}

function runtimePaths(home) {
  return [
    path.join(home, '.cherrystudio'),
    path.join(home, 'Library/Application Support/CherryStudio'),
    path.join(home, 'Library/Logs/CherryStudio'),
    path.join(home, 'Library/Caches/CherryStudio'),
    path.join(home, 'Library/Preferences/com.kangfenmao.CherryStudio.plist'),
    path.join(home, 'Library/Saved Application State/com.kangfenmao.CherryStudio.savedState')
  ]
}

function launchEnvironment(environment = process.env) {
  return Object.fromEntries(
    ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, environment[key]])
  )
}

async function launch(bundle, output) {
  requireHostedMac()
  const stdout = fs.openSync(path.join(output, 'stdout.log'), 'w')
  const stderr = fs.openSync(path.join(output, 'stderr.log'), 'w')
  try {
    const child = spawn(path.join(bundle, 'Contents/MacOS/Cherry Studio'), [], {
      detached: true,
      env: launchEnvironment(),
      stdio: ['ignore', stdout, stderr]
    })
    await once(child, 'spawn')
    return child
  } finally {
    fs.closeSync(stdout)
    fs.closeSync(stderr)
  }
}

function bundleProcesses(bundle) {
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000 })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => match && match[2].startsWith(`${bundle}/Contents/`))
    .map((match) => Number(match[1]))
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function stop(child, bundle) {
  for (const name of ['SIGTERM', 'SIGKILL']) {
    signal(-child.pid, name)
    for (const pid of bundleProcesses(bundle)) signal(pid, name)
    const deadline = Date.now() + (name === 'SIGTERM' ? 10000 : 5000)
    while (Date.now() < deadline) {
      if ((child.exitCode !== null || child.signalCode !== null) && !bundleProcesses(bundle).length) return
      await delay(100)
    }
  }
  throw new Error('Packaged startup processes did not stop')
}

function startupLogs(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => /^app(?:-error)?\..*\.log$/.test(name))
}

function startupRecords(directory) {
  return startupLogs(directory).flatMap((name) =>
    fs
      .readFileSync(path.join(directory, name), 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  )
}

async function verifyPackagedStartup(
  { bundle, output, version, home = os.homedir(), timeoutMs = 75000, stableMs = 3000, pollMs = 250 },
  operations = { launch, stop, screenshot: (file) => execFileSync('screencapture', ['-x', file], { timeout: 10000 }) }
) {
  const owned = runtimePaths(home)
  if (owned.some((directory) => fs.existsSync(directory))) {
    throw new Error('Startup verification requires an unused Cherry Studio profile; existing data was preserved')
  }
  fs.mkdirSync(output, { recursive: true })
  const logs = path.join(home, 'Library/Logs/CherryStudio')
  const versionLog = path.join(home, 'Library/Application Support/CherryStudio/version.log')
  const report = { version, bootstrap: false, packagedVersion: false, stable: false, cleanup: false }
  let child
  let failure
  const started = Date.now()
  try {
    child = await operations.launch(bundle, output)
    report.pid = child.pid
    let bootstrappedAt
    while (Date.now() - started < timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged app exited during startup')
      const records = startupRecords(logs).filter((record) => record?.process === 'main')
      if (
        records.some(
          (record) =>
            record.level === 'error' &&
            ((record.module === 'MainEntry' && record.message.startsWith('Fatal startup error:')) ||
              (record.module === 'Lifecycle' && record.message.startsWith('Fatal service initialization error:')) ||
              (record.module === 'CrashTelemetry' &&
                /^(Uncaught Exception:|Unhandled Rejection at:|Renderer unresponsive)/.test(record.message)) ||
              (record.module === 'WindowManager' && record.message.startsWith('Failed to load window content')) ||
              (record.module === 'MainWindowService' && record.message.startsWith('Renderer process crashed with:')))
        )
      )
        throw new Error('Packaged app reported a fatal startup or renderer failure')
      if (
        !report.bootstrap &&
        records.some(
          (record) =>
            record.module === 'Lifecycle' &&
            record.level === 'info' &&
            /^Bootstrap complete \(\d+(?:\.\d+)?ms\)$/.test(record.message)
        )
      ) {
        report.bootstrap = true
      }
      if (!report.packagedVersion && fs.existsSync(versionLog)) {
        report.packagedVersion = fs
          .readFileSync(versionLog, 'utf8')
          .split('\n')
          .some((line) => line.startsWith(`${version}|mac|prod|packaged|install|`))
      }
      if (report.bootstrap && report.packagedVersion && bootstrappedAt === undefined) {
        bootstrappedAt = Date.now()
      }
      if (bootstrappedAt !== undefined && Date.now() - bootstrappedAt >= stableMs) {
        report.stable = true
        break
      }
      await delay(pollMs)
    }
    if (!report.stable) throw new Error('Packaged app did not complete a stable bootstrap before the deadline')
  } catch (error) {
    failure = error
    report.error = error.message
    try {
      operations.screenshot(path.join(output, 'startup-failure.png'))
    } catch (captureError) {
      report.screenshotError = captureError.message
    }
  } finally {
    let stopped = !child
    try {
      if (child) await operations.stop(child, bundle)
      stopped = true
    } catch (error) {
      failure = failure ?? error
      report.cleanupError = error.message
    }
    try {
      for (const name of startupLogs(logs)) fs.copyFileSync(path.join(logs, name), path.join(output, name))
      if (fs.existsSync(versionLog)) fs.copyFileSync(versionLog, path.join(output, 'version.log'))
      if (stopped) {
        for (const directory of owned) fs.rmSync(directory, { recursive: true, force: true })
        report.cleanup = true
      }
    } catch (error) {
      failure = failure ?? error
      report.cleanupError = error.message
    }
    report.elapsedMs = Date.now() - started
    fs.writeFileSync(path.join(output, 'startup.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failure) throw failure
  return report
}

module.exports = { launchEnvironment, requireHostedMac, runtimePaths, verifyPackagedStartup }

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      requireHostedMac()
      if (process.argv.length !== 4)
        throw new Error('Usage: verify-packaged-startup.js <verified-app> <evidence-directory>')
      return verifyPackagedStartup({
        bundle: path.resolve(process.argv[2]),
        output: path.resolve(process.argv[3]),
        version: require('../../package.json').version
      })
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
