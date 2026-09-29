export const MANUAL_ROOT = "manual-annotations";
export const MODEL_ROOT = `${MANUAL_ROOT}/models`;
export const IMAGE_ROOT = `${MANUAL_ROOT}/images`;
export const RESERVED_LEGACY_NAMES = new Set(["images", "models"]);

export function frameStem(frameNumber) {
  return `frame_${String(frameNumber).padStart(6, "0")}`;
}

export function legacyImageKey(jobId, frameNumber) {
  return `${MANUAL_ROOT}/${jobId}/images/${frameStem(frameNumber)}.jpg`;
}

export function sharedImageKey(jobId, frameNumber) {
  return `${IMAGE_ROOT}/${jobId}/${frameStem(frameNumber)}.jpg`;
}

export function legacyLabelKey(jobId, modelId, frameNumber) {
  return `${MANUAL_ROOT}/${jobId}/labels/${modelId}/${frameStem(frameNumber)}.txt`;
}

export function modelLabelKey(modelId, jobId, frameNumber) {
  return `${MODEL_ROOT}/${modelId}/${jobId}/labels/${frameStem(frameNumber)}.txt`;
}

export function legacyMetadataKey(jobId, modelId, frameNumber) {
  return `${MANUAL_ROOT}/${jobId}/metadata/${modelId}/${frameStem(frameNumber)}.json`;
}

export function modelMetadataKey(modelId, jobId, frameNumber) {
  return `${MODEL_ROOT}/${modelId}/${jobId}/metadata/${frameStem(frameNumber)}.json`;
}

export function modelManifestKey(modelId, jobId) {
  return `${MODEL_ROOT}/${modelId}/${jobId}/manifest.json`;
}

export function parseLegacyAnnotationKey(key) {
  const match = /^manual-annotations\/([^/]+)\/(images|labels|metadata)\/(?:([^/]+)\/)?frame_(\d+)\.(jpg|txt|json)$/.exec(
    String(key ?? ""),
  );
  if (!match || RESERVED_LEGACY_NAMES.has(match[1])) return null;
  const [, jobId, kind, modelId, frameText] = match;
  if ((kind === "labels" || kind === "metadata") && !modelId) return null;
  return {
    jobId,
    kind,
    modelId: modelId ?? null,
    frameNumber: Number(frameText),
  };
}

export function parseModelAnnotationKey(key) {
  const match = /^manual-annotations\/models\/([^/]+)\/([^/]+)\/(labels|metadata)\/frame_(\d+)\.(txt|json)$/.exec(
    String(key ?? ""),
  );
  if (!match) return null;
  return {
    modelId: match[1],
    jobId: match[2],
    kind: match[3],
    frameNumber: Number(match[4]),
  };
}

export function migrationTarget(key) {
  const parsed = parseLegacyAnnotationKey(key);
  if (!parsed) return null;
  if (parsed.kind === "images") {
    return sharedImageKey(parsed.jobId, parsed.frameNumber);
  }
  if (parsed.kind === "labels") {
    return modelLabelKey(parsed.modelId, parsed.jobId, parsed.frameNumber);
  }
  return modelMetadataKey(parsed.modelId, parsed.jobId, parsed.frameNumber);
}
