/** Refresh selected models and their offers without importing unrelated upstream drift. */
export function scopeModelRefresh<M extends { id: string }, O extends { modelId: string }>(
  current: { models: M[]; overrides: O[] },
  generated: { models: M[]; overrides: O[] },
  modelIds: readonly string[]
): { models: M[]; overrides: O[] } {
  const selected = new Set(modelIds)
  const generatedModelIds = new Set(generated.models.map((model) => model.id))
  const generatedIds = new Set([...generatedModelIds, ...generated.overrides.map((offer) => offer.modelId)])
  for (const id of selected) {
    if (!generatedIds.has(id)) throw new Error(`Cannot refresh unknown model: ${id}`)
  }
  return {
    models: [
      ...current.models.filter((model) => !selected.has(model.id) || !generatedModelIds.has(model.id)),
      ...generated.models.filter((model) => selected.has(model.id))
    ],
    overrides: [
      ...current.overrides.filter((row) => !selected.has(row.modelId)),
      ...generated.overrides.filter((row) => selected.has(row.modelId))
    ]
  }
}
