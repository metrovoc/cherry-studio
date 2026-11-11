import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'

export default function ImageAttachments({
  attachments,
  onRemove
}: {
  attachments: ComposerAttachment[]
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2 py-2 [-webkit-app-region:no-drag]">
      {attachments.map((attachment) => (
        <ImageAttachment key={attachment.fileTokenSourceId} attachment={attachment} onRemove={onRemove} />
      ))}
    </div>
  )
}

function ImageAttachment({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: (id: string) => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!attachment.blob) return
    const next = URL.createObjectURL(attachment.blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [attachment.blob])
  return (
    <div className="relative rounded-md border border-border bg-muted p-1">
      {url && <img src={url} alt={attachment.origin_name} className="h-16 w-24 rounded object-contain" />}
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className="absolute right-0 top-0 size-5"
        aria-label={t('quickAssistant.images.remove', { name: attachment.origin_name })}
        onClick={() => onRemove(attachment.fileTokenSourceId)}>
        <X className="size-3" />
      </Button>
    </div>
  )
}
