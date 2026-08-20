import { Input } from '@cherrystudio/ui'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import type { Model } from '@shared/data/types/model'
import React from 'react'

interface InputBarProps {
  text: string
  model?: Model
  placeholder: string
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

const InputBar = ({
  ref,
  text,
  model,
  placeholder,
  handleKeyDown,
  handleChange
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  return (
    <div ref={ref} className="mt-2.5 flex items-center gap-2">
      {model && <ModelAvatar model={model} size={30} />}
      <Input
        value={text}
        placeholder={placeholder}
        autoFocus
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        className="h-auto rounded-none border-0 bg-transparent px-0 py-0 text-lg shadow-none [-webkit-app-region:no-drag] placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
    </div>
  )
}
InputBar.displayName = 'InputBar'

export default InputBar
