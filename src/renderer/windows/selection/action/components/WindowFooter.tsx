import { Button, Tooltip } from '@cherrystudio/ui'
import RefreshIcon from '@renderer/components/icons/RefreshIcon'
import { useTimer } from '@renderer/hooks/useTimer'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { isMac } from '@renderer/utils/platform'
import { cn } from '@renderer/utils/style'
import { CircleX, Copy, ListX, Loader2, Pause } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'

interface FooterProps {
  content?: string
  loading?: boolean
  onPause?: () => void | Promise<void>
  onRegenerate?: () => void
}

const WindowFooter: FC<FooterProps> = ({
  content = '',
  loading = false,
  onPause = undefined,
  onRegenerate = undefined
}) => {
  const { t } = useTranslation()

  const [isWindowFocus, setIsWindowFocus] = useState(true)
  const [isCopyHovered, setIsCopyHovered] = useState(false)
  const [isEscHovered, setIsEscHovered] = useState(false)
  const [isRegenerateHovered, setIsRegenerateHovered] = useState(false)
  const [isContainerHovered, setIsContainerHovered] = useState(false)
  const [isTooltipOpen, setIsTooltipOpen] = useState(false)
  const [isShowMe, setIsShowMe] = useState(true)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)
  const { setTimeoutTimer } = useTimer()

  useEffect(() => {
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    hideTimerRef.current = setTimeout(() => {
      setIsShowMe(false)
      hideTimerRef.current = null
    }, 3000)

    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
    }
  }, [])

  const showMePeriod = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
    }

    setIsShowMe(true)
    hideTimerRef.current = setTimeout(() => {
      setIsShowMe(false)
      hideTimerRef.current = null
    }, 2000)
  }

  useHotkeys('c', () => {
    showMePeriod()
    handleCopy()
  })

  useHotkeys('r', () => {
    showMePeriod()
    handleRegenerate()
  })

  useHotkeys('esc', () => {
    showMePeriod()
    handleEsc()
  })

  useIpcOn('selection.close_action_window', async () => {
    await onPause?.()
    void ipcApi.request('window.close')
  })

  const handleEsc = () => {
    setIsEscHovered(true)
    setTimeoutTimer(
      'handleEsc',
      () => {
        setIsEscHovered(false)
      },
      200
    )

    if (loading && onPause) {
      void onPause()
    } else {
      void ipcApi.request('window.close')
    }
  }

  const handleRegenerate = () => {
    setIsRegenerateHovered(true)
    setTimeoutTimer(
      'handleRegenerate_1',
      () => {
        setIsRegenerateHovered(false)
      },
      200
    )

    if (loading && onPause) {
      void onPause()
    }

    if (onRegenerate) {
      //wait for a little time
      setTimeoutTimer(
        'handleRegenerate_2',
        () => {
          onRegenerate()
        },
        200
      )
    }
  }

  const handleCopy = () => {
    if (!content || loading) return

    navigator.clipboard
      .writeText(content)
      .then(() => {
        toast.success(t('message.copy.success'))
        setIsCopyHovered(true)
        setTimeoutTimer(
          'handleCopy',
          () => {
            setIsCopyHovered(false)
          },
          200
        )
      })
      .catch(() => {
        toast.error(t('message.copy.failed'))
      })
  }

  const handleWindowFocus = () => {
    setIsWindowFocus(true)
  }

  const handleWindowBlur = () => {
    setIsWindowFocus(false)
  }

  const buttonClassName = 'h-7 min-w-12 gap-1.5 bg-muted px-2 text-muted-foreground text-xs'

  return (
    <div
      onMouseEnter={() => setIsContainerHovered(true)}
      onMouseLeave={() => setIsContainerHovered(false)}
      className={cn(
        '-translate-x-1/2 absolute bottom-0 left-1/2 flex w-[calc(100%-16px)] max-w-[480px] items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 backdrop-blur-sm transition-opacity duration-300 focus-within:opacity-100',
        isShowMe || isContainerHovered || isTooltipOpen ? 'opacity-100' : 'opacity-0'
      )}>
      <Tooltip
        asChild
        content={t(loading ? 'selection.action.window.esc_stop' : 'selection.action.window.esc_close')}
        onOpenChange={setIsTooltipOpen}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEsc}
          aria-label={t(loading ? 'selection.action.window.esc_stop' : 'selection.action.window.esc_close')}
          aria-keyshortcuts="Escape"
          className={cn(buttonClassName, loading && 'text-error hover:text-error', isEscHovered && 'bg-accent')}>
          {loading ? (
            <span className="relative size-4">
              <Pause className="absolute top-px left-px size-3.5" />
              <Loader2 className="absolute top-0 left-0 size-4 animate-spin" />
            </span>
          ) : (
            <CircleX className="size-3.5" />
          )}
          <span>Esc</span>
        </Button>
      </Tooltip>
      {onRegenerate && (
        <Tooltip asChild content={t('selection.action.window.r_regenerate')} onOpenChange={setIsTooltipOpen}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRegenerate}
            aria-label={t('selection.action.window.r_regenerate')}
            aria-keyshortcuts="R"
            className={cn(buttonClassName, isRegenerateHovered && 'bg-accent')}>
            <RefreshIcon className="size-3.5" />
            <span>R</span>
          </Button>
        </Tooltip>
      )}
      <Tooltip asChild content={t('selection.action.window.c_copy')} onOpenChange={setIsTooltipOpen}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          aria-label={t('selection.action.window.c_copy')}
          aria-keyshortcuts="C"
          disabled={!content || loading}
          className={cn(buttonClassName, isCopyHovered && 'bg-accent', !isWindowFocus && 'text-foreground-disabled')}>
          <Copy className="size-3.5" />
          <span>C</span>
        </Button>
      </Tooltip>
      <Tooltip asChild content={t('selection.action.window.close_all')} onOpenChange={setIsTooltipOpen}>
        <Button
          variant="ghost"
          size="sm"
          className={buttonClassName}
          aria-label={t('selection.action.window.close_all')}
          aria-keyshortcuts={isMac ? 'Meta+Escape' : undefined}
          onClick={() => void ipcApi.request('selection.close_action_windows')}>
          <ListX className="size-3.5" />
          {isMac && <span>⌘Esc</span>}
        </Button>
      </Tooltip>
    </div>
  )
}

export default WindowFooter
