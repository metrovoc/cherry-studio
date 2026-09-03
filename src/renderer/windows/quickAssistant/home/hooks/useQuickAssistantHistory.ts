import { useDataChange, useInfiniteFlatItems, useInfiniteQuery } from '@renderer/data/hooks/useDataApi'
import { useCallback } from 'react'

export function useQuickAssistantHistory(assistantId: string | undefined, enabled: boolean) {
  const query = useInfiniteQuery('/assistants/:assistantId/topics', {
    params: { assistantId: assistantId ?? '' },
    limit: 50,
    enabled: enabled && Boolean(assistantId)
  })
  const topics = useInfiniteFlatItems(query.pages)
  const { refresh } = query

  useDataChange(
    '/topics',
    useCallback(() => {
      if (enabled && assistantId) void refresh()
    }, [assistantId, enabled, refresh])
  )

  return { ...query, topics }
}
