import type { UpdateInfo } from 'builder-util-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appEditionState, netFetchMock, releaseNotesCheckMock, releaseNotesUpdaterInstances, trackAppUpdateMock } =
  vi.hoisted(() => ({
    appEditionState: { current: 'global' },
    netFetchMock: vi.fn(),
    releaseNotesCheckMock: vi.fn(),
    releaseNotesUpdaterInstances: [] as Array<Record<string, unknown>>,
    trackAppUpdateMock: vi.fn()
  }))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('@data/PreferenceService', async () => {
  const { MockMainPreferenceServiceExport } = await import('@test-mocks/main/PreferenceService')
  return MockMainPreferenceServiceExport
})

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const result = mockApplicationFactory()
  const originalGet = result.application.get.getMockImplementation()!
  result.application.get.mockImplementation((name: string) => {
    if (name === 'AnalyticsService') {
      return { trackAppUpdate: trackAppUpdateMock }
    }
    return originalGet(name)
  })
  return result
})

vi.mock('@main/core/lifecycle', () => {
  class MockBaseService {}
  return {
    BaseService: MockBaseService,
    Injectable: () => (target: unknown) => target,
    ServicePhase: () => (target: unknown) => target,
    DependsOn: () => (target: unknown) => target,
    Phase: { Background: 'background', WhenReady: 'whenReady', BeforeReady: 'beforeReady' }
  }
})

vi.mock('@main/core/platform', () => ({
  isWin: false
}))

vi.mock('@main/utils/appEdition', () => ({ getAppEdition: () => appEditionState.current }))
vi.mock('@main/services/RegionService', () => ({ regionService: { getCountry: vi.fn(async () => 'CN') } }))
vi.mock('@main/utils/systemInfo', () => ({
  generateUserAgent: vi.fn(() => 'test-user-agent'),
  getClientId: vi.fn(() => 'test-client-id')
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.0')
  },
  net: { fetch: netFetchMock }
}))

vi.mock('electron-updater', () => {
  class MockAppUpdater {
    allowPrerelease = true
    allowDowngrade = false
    autoDownload = true
    autoInstallOnAppQuit = true
    channel = ''
    forceDevUpdateConfig = false
    logger: unknown = null
    requestHeaders: Record<string, string> = {}

    constructor(public options?: unknown) {
      releaseNotesUpdaterInstances.push(this as unknown as Record<string, unknown>)
    }

    checkForUpdates() {
      return releaseNotesCheckMock()
    }
  }

  return {
    autoUpdater: {
      logger: null,
      forceDevUpdateConfig: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      requestHeaders: {},
      on: vi.fn(),
      removeListener: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      channel: '',
      allowPrerelease: true,
      allowDowngrade: false,
      disableDifferentialDownload: false,
      currentVersion: '1.0.0'
    },
    AppUpdater: MockAppUpdater,
    Logger: vi.fn(),
    NsisUpdater: vi.fn()
  }
})

import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import { application } from '@application'
import { UpgradeChannel } from '@shared/data/preference/preferenceTypes'

import { AppUpdaterService } from '../AppUpdaterService'

describe('AppUpdaterService', () => {
  let appUpdater: AppUpdaterService

  beforeEach(() => {
    vi.clearAllMocks()
    appEditionState.current = 'global'
    MockMainPreferenceServiceUtils.resetMocks()
    MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.enabled', false)
    MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.channel', UpgradeChannel.LATEST)
    vi.mocked(app.getVersion).mockReturnValue('1.0.0')
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValue(null)
    netFetchMock.mockReset()
    releaseNotesCheckMock.mockReset().mockResolvedValue(null)
    releaseNotesUpdaterInstances.length = 0
    autoUpdater.requestHeaders = {}
    autoUpdater.channel = ''
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false
    appUpdater = new AppUpdaterService()
  })

  describe('read-only update query', () => {
    it('reports an available release without using the application updater or analytics', async () => {
      releaseNotesCheckMock.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } })
      await expect(appUpdater.queryUpdateAvailability()).resolves.toEqual({
        status: 'available',
        currentVersion: '1.0.0',
        version: '2.0.0'
      })
      expect(releaseNotesUpdaterInstances[0]).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false })
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
      expect(trackAppUpdateMock).not.toHaveBeenCalled()
    })

    it('does not turn a failed or unsupported updater query into an up-to-date result', async () => {
      releaseNotesCheckMock.mockRejectedValueOnce(new Error('HTTP 503'))
      await expect(appUpdater.queryUpdateAvailability()).rejects.toThrow('HTTP 503')
      releaseNotesCheckMock.mockResolvedValueOnce(null)
      await expect(appUpdater.queryUpdateAvailability()).rejects.toThrow('did not produce a result')
    })
  })

  describe('fork stable update feed', () => {
    it.each([UpgradeChannel.RC, UpgradeChannel.BETA, UpgradeChannel.LATEST])(
      'uses stable fork updates despite the saved %s channel or installed prerelease',
      async (channel) => {
        vi.mocked(app.getVersion).mockReturnValue('2.1.3-rc.1')
        MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.enabled', true)
        MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.channel', channel)
        autoUpdater.allowPrerelease = true
        autoUpdater.allowDowngrade = true
        autoUpdater.requestHeaders = { 'Client-Id': 'old-client-id' }
        vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
          expect(autoUpdater).toMatchObject({
            channel: 'latest',
            allowPrerelease: false,
            allowDowngrade: false,
            requestHeaders: { 'User-Agent': 'CherryStudio/2.1.3-rc.1', 'Cache-Control': 'no-cache' }
          })
          return { isUpdateAvailable: true, updateInfo: { version: '2.1.3' } } as Awaited<
            ReturnType<typeof autoUpdater.checkForUpdates>
          >
        })

        await expect(appUpdater.checkForUpdates()).resolves.toMatchObject({ updateInfo: { version: '2.1.3' } })
        expect(autoUpdater.requestHeaders).not.toHaveProperty('Client-Id')
      }
    )

    it.each(['queryUpdateAvailability', 'getLatestReleaseNotes'] as const)(
      '%s uses the same stable-only policy as installation',
      async (method) => {
        MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.enabled', true)
        MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.channel', UpgradeChannel.BETA)
        releaseNotesCheckMock.mockImplementation(() => {
          expect(releaseNotesUpdaterInstances[0]).toMatchObject({
            channel: 'latest',
            allowPrerelease: false,
            allowDowngrade: false,
            autoDownload: false,
            autoInstallOnAppQuit: false
          })
          return { isUpdateAvailable: true, updateInfo: { version: '2.1.3', releaseNotes: 'Fork notes' } }
        })
        const result = await appUpdater[method]()
        expect(result).toMatchObject({ version: '2.1.3' })
      }
    )

    it('preserves the separately configured China edition feed and channel', async () => {
      appEditionState.current = 'cn'
      MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.enabled', true)
      MockMainPreferenceServiceUtils.setPreferenceValue('app.dist.test_plan.channel', UpgradeChannel.RC)
      releaseNotesCheckMock.mockImplementation(() => {
        expect(releaseNotesUpdaterInstances[0]).toMatchObject({ channel: 'rc-cn' })
        return { isUpdateAvailable: false }
      })
      netFetchMock.mockImplementation((url) => {
        expect(url).toBe('https://releases.cherry-ai.com/release-history.json')
        return new Response(
          JSON.stringify([
            { version: '1.0.0', releaseNotes: '<!--LANG:en-->Upstream<!--LANG:zh-CN-->上游<!--LANG:END-->' }
          ])
        )
      })
      await expect(appUpdater.getReleaseHistory()).resolves.toEqual([
        { version: '1.0.0', releaseNotes: '<!--LANG:en-->Upstream<!--LANG:zh-CN-->上游<!--LANG:END-->' }
      ])
    })

    it('fetches valid release history from the fork without upstream tracking headers', async () => {
      const releaseNotes = '<!--LANG:en-->Fork notes<!--LANG:zh-CN-->分支说明<!--LANG:END-->'
      const history = [{ releaseNotes, version: '2.1.3' }]
      netFetchMock.mockImplementation((url, options) => {
        expect(url).toBe('https://github.com/metrovoc/cherry-studio/releases/latest/download/release-history.json')
        expect(options.headers).toEqual({ 'User-Agent': 'CherryStudio/1.0.0', 'Cache-Control': 'no-cache' })
        return new Response(JSON.stringify(history))
      })
      await expect(appUpdater.getReleaseHistory()).resolves.toEqual(history)
    })

    it('merges a newer stable release with stable release history', async () => {
      const stableNotes = '<!--LANG:en-->Stable notes<!--LANG:zh-CN-->稳定版说明<!--LANG:END-->'
      const rcNotes = '<!--LANG:en-->RC notes<!--LANG:zh-CN-->测试版说明<!--LANG:END-->'
      netFetchMock.mockResolvedValue(new Response(JSON.stringify([{ releaseNotes: stableNotes, version: '1.1.0' }])))
      releaseNotesCheckMock.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: { releaseNotes: rcNotes, version: '1.2.0' }
      })

      await expect(appUpdater.getReleaseHistory()).resolves.toEqual([
        { releaseNotes: rcNotes, version: '1.2.0' },
        { releaseNotes: stableNotes, version: '1.1.0' }
      ])
    })

    it('keeps newer updater notes when release history is unavailable', async () => {
      netFetchMock.mockRejectedValue(new Error('offline'))
      releaseNotesCheckMock.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: { releaseNotes: 'New release notes', version: '1.1.0' }
      })

      await expect(appUpdater.getReleaseHistory()).resolves.toEqual([
        { releaseNotes: 'New release notes', version: '1.1.0' }
      ])
    })

    it('falls back to bundled history when the managed response is invalid', async () => {
      netFetchMock.mockResolvedValue(new Response(JSON.stringify([{ releaseNotes: 'English only', version: '1.1.0' }])))

      await expect(appUpdater.getReleaseHistory()).resolves.toBeNull()
    })

    it('falls back to bundled history when the managed request fails', async () => {
      netFetchMock.mockRejectedValue(new Error('offline'))

      await expect(appUpdater.getReleaseHistory()).resolves.toBeNull()
    })

    it('rejects release history larger than the response limit before reading it', async () => {
      const text = vi.fn()
      netFetchMock.mockResolvedValue({
        headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
        ok: true,
        status: 200,
        text
      })

      await expect(appUpdater.getReleaseHistory()).resolves.toBeNull()
      expect(text).not.toHaveBeenCalled()
    })
  })

  describe('processReleaseInfo', () => {
    it('localizes marked release notes', () => {
      MockMainPreferenceServiceUtils.setPreferenceValue('app.language', 'zh-CN')
      const releaseInfo = {
        version: '1.0.0',
        files: [],
        path: '',
        sha512: '',
        releaseDate: new Date().toISOString(),
        releaseNotes: '<!--LANG:en-->English notes<!--LANG:zh-CN-->中文说明<!--LANG:END-->'
      } as UpdateInfo

      const result = (appUpdater as any).processReleaseInfo(releaseInfo)

      expect(result.releaseNotes).toBe('中文说明')
    })

    it('leaves unmarked release notes unchanged', () => {
      const releaseInfo = {
        version: '1.0.0',
        files: [],
        path: '',
        sha512: '',
        releaseDate: new Date().toISOString(),
        releaseNotes: 'Simple release notes'
      } as UpdateInfo

      expect((appUpdater as any).processReleaseInfo(releaseInfo).releaseNotes).toBe('Simple release notes')
    })

    it('leaves array release notes unchanged', () => {
      const releaseInfo = {
        version: '1.0.0',
        files: [],
        path: '',
        sha512: '',
        releaseDate: new Date().toISOString(),
        releaseNotes: [
          { version: '1.0.0', note: 'Note 1' },
          { version: '1.0.1', note: 'Note 2' }
        ]
      } as UpdateInfo

      expect((appUpdater as any).processReleaseInfo(releaseInfo).releaseNotes).toEqual(releaseInfo.releaseNotes)
    })

    it('leaves null release notes unchanged', () => {
      const releaseInfo = {
        version: '1.0.0',
        files: [],
        path: '',
        sha512: '',
        releaseDate: new Date().toISOString(),
        releaseNotes: null
      } as UpdateInfo

      expect((appUpdater as any).processReleaseInfo(releaseInfo).releaseNotes).toBeNull()
    })

    it('leaves marked release notes unchanged when language lookup fails', () => {
      const releaseInfo = {
        version: '1.0.0',
        files: [],
        path: '',
        sha512: '',
        releaseDate: new Date().toISOString(),
        releaseNotes: '<!--LANG:en-->English notes<!--LANG:zh-CN-->中文说明<!--LANG:END-->'
      } as UpdateInfo
      vi.mocked(application.get('PreferenceService').get).mockImplementationOnce(() => {
        throw new Error('Test error')
      })

      expect((appUpdater as any).processReleaseInfo(releaseInfo).releaseNotes).toBe(releaseInfo.releaseNotes)
    })
  })
})
