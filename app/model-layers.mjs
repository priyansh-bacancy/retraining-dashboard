export function visibleModelLayers(
  models,
  expanded,
  activeModelId = "",
  dirtyModelIds = new Set(),
) {
  if (expanded) return models;
  return models.filter(
    (model) =>
      model.source !== "manual_available" ||
      model.id === activeModelId ||
      dirtyModelIds.has(model.id) ||
      Number(model.count) > 0,
  );
}
