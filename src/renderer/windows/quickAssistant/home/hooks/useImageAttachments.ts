import { useCallback, useState } from 'react'

import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'

const imageExtensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const addImages = useCallback((files: Blob[], name?: string) => {
    const images = files.flatMap((blob): ComposerAttachment[] => {
      const ext = imageExtensions[blob.type]
      if (!ext) return []
      const filename = name ?? (blob instanceof File ? blob.name : `image${ext}`)
      return [
        {
          fileTokenSourceId: crypto.randomUUID(),
          blob,
          ext,
          name: filename,
          origin_name: filename,
          size: blob.size,
          type: 'image'
        }
      ]
    })
    setAttachments((current) => [...current, ...images])
  }, [])
  return { attachments, setAttachments, addImages }
}
