import { createWriteStream, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import {
  MANUAL_ROOT,
  MODEL_ROOT,
  RESERVED_LEGACY_NAMES,
  legacyImageKey,
  legacyLabelKey,
  legacyMetadataKey,
  modelLabelKey,
  modelManifestKey,
  modelMetadataKey,
  sharedImageKey,
} from "./annotation-storage.mjs";

export const BUCKET =
  process.env.RETRAINING_BUCKET ??
  "icu-solarcam-storage-bacancy-ap-southeast-2";
export const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const SAMPLE_INTERVAL = Number(process.env.RETRAINING_SAMPLE_INTERVAL ?? 15);
const CACHE_ROOT = join(
  tmpdir(),
  `icu-retraining-dashboard-node-cache-${process.pid}`,
);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FFMPEG = ffmpegPath;
const FFPROBE = ffprobeStatic.path;

function legacyAnnotationReadsEnabled() {
  return process.env.ANNOTATION_LEGACY_READ !== "false";
}

function legacyAnnotationWritesEnabled() {
  return process.env.ANNOTATION_LEGACY_WRITE !== "false";
}

const CLASS_NAMES = {
  "phone-usage-detection": ["in_hand", "on_ear"],
  "sleep-detection": ["sleeping"],
  "fire-smoke-detection": ["fire", "smoke"],
  "fall-detection": ["falling", "standing", "sitting", "lying"],
  "running-detection": ["running"],
  "climb-detection": ["climbing"],
  "restricted-zone": ["person"],
  "people-count": ["person"],
  "group-detection": ["group"],
  "ppe-compliance": ["person", "helmet", "vest", "no_helmet", "no_vest"],
  "mmc-vehicle-classification": [
    "vehicle",
    "car",
    "motorcycle",
    "truck",
    "bus",
  ],
};

const MODEL_NAMES = {
  "ppe-compliance": "PPE compliance",
  "running-detection": "Running detection",
  "climb-detection": "Climb detection",
  "sleep-detection": "Sleep detection",
  "phone-usage-detection": "Phone usage",
  "fire-smoke-detection": "Fire smoke detection",
  "fall-detection": "Fall detection",
  "restricted-zone": "Restricted zone",
  "people-count": "People count",
  "group-detection": "Group detection",
  "mmc-vehicle-classification": "Vehicle classification",
  "videomae-aggression": "Aggression",
};

const MODEL_COLORS = {
  "ppe-compliance": "#f59e0b",
  "sleep-detection": "#8b5cf6",
  "phone-usage-detection": "#e8546b",
  "fire-smoke-detection": "#64748b",
  "fall-detection": "#64748b",
  "running-detection": "#64748b",
  "climb-detection": "#64748b",
  "restricted-zone": "#64748b",
  "people-count": "#64748b",
  "group-detection": "#64748b",
  "mmc-vehicle-classification": "#16a89a",
  "videomae-aggression": "#ef4444",
};

const MANUAL_MODEL_IDS = [
  "ppe-compliance",
  "running-detection",
  "climb-detection",
  "phone-usage-detection",
  "sleep-detection",
  "videomae-aggression",
  "fall-detection",
  "restricted-zone",
  "mmc-vehicle-classification",
  "fire-smoke-detection",
  "people-count",
  "group-detection",
];

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const cache = {
  jobs: { at: 0, value: [] },
  correctedJobs: { at: 0, value: new Set() },
  reviewableJobs: { at: 0, value: new Set() },
  pages: new Map(),
  summaries: new Map(),
  jobsById: new Map(),
  health: { at: 0, value: null },
  videos: new Map(),
  videoPromises: new Map(),
  batches: new Map(),
  frames: new Map(),
  previews: new Map(),
};

// Every process owns a unique cache folder, so a deployment cannot inherit an
// active.mp4 created by another OS user. Synchronous exit cleanup is deliberate:
// async work is not guaranteed to finish once Node's exit event starts.
process.once("exit", () => {
  try {
    rmSync(CACHE_ROOT, { recursive: true, force: true });
  } catch {
    // /tmp cleanup is best-effort and must never interrupt shutdown.
  }
});
const MAX_FRAME_BATCH_SIZE = 100;
const FRAME_CACHE_LIMIT = 125;
const VIDEO_SUFFIXES = [".mp4", ".webm", ".avi", ".mov", ".mkv", ".m4v"];

const defaultClients = {
  s3: new S3Client({ region: REGION }),
  sts: new STSClient({ region: REGION }),
};

function fresh(entry, ttlMs = 60_000) {
  return entry && Date.now() - entry.at < ttlMs;
}

function validateId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new HttpError(400, `Invalid ${label}`);
  }
  return value;
}

function isMissing(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function bodyBytes(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(s3, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return JSON.parse((await bodyBytes(response.Body)).toString("utf8"));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) {
      throw new HttpError(404, `S3 object is unavailable: ${key}`);
    }
    throw error;
  }
}

async function tryBytes(s3, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return bodyBytes(response.Body);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function listKeys(s3, prefix) {
  const rows = [];
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    rows.push(...(response.Contents ?? []));
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return rows;
}

async function listPrefixes(s3, prefix) {
  const prefixes = [];
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    prefixes.push(
      ...(response.CommonPrefixes ?? [])
        .map((row) => String(row.Prefix ?? ""))
        .filter(Boolean),
    );
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return prefixes;
}

async function loadCorrectedJobIds(s3) {
  if (fresh(cache.correctedJobs)) return cache.correctedJobs.value;
  const jobIds = new Set();
  if (legacyAnnotationReadsEnabled()) {
    for (const prefix of await listPrefixes(s3, `${MANUAL_ROOT}/`)) {
      const match = /^manual-annotations\/([^/]+)\/$/.exec(prefix);
      if (
        match &&
        !RESERVED_LEGACY_NAMES.has(match[1]) &&
        SAFE_ID.test(match[1])
      ) {
        jobIds.add(match[1]);
      }
    }
  }
  for (const modelPrefix of await listPrefixes(s3, `${MODEL_ROOT}/`)) {
    for (const jobPrefix of await listPrefixes(s3, modelPrefix)) {
      const match = /^manual-annotations\/models\/[^/]+\/([^/]+)\/$/.exec(
        jobPrefix,
      );
      if (match && SAFE_ID.test(match[1])) jobIds.add(match[1]);
    }
  }
  cache.correctedJobs = { at: Date.now(), value: jobIds };
  return jobIds;
}

async function loadReviewableJobIds(s3) {
  if (fresh(cache.reviewableJobs)) return cache.reviewableJobs.value;
  const jobIds = new Set();
  const layouts = [
    {
      prefix: "storage/uploads/UNASSIGNED_",
      jobId(key) {
        const fileName = key.slice(this.prefix.length).split("/")[0];
        const suffix = extname(fileName).toLowerCase();
        return VIDEO_SUFFIXES.includes(suffix)
          ? fileName.slice(0, -suffix.length)
          : "";
      },
    },
    {
      prefix: "storage/UNASSIGNED/uploads/",
      jobId(key) {
        const fileName = key.slice(this.prefix.length).split("/")[0];
        const suffix = extname(fileName).toLowerCase();
        return VIDEO_SUFFIXES.includes(suffix)
          ? fileName.slice(0, -suffix.length)
          : "";
      },
    },
  ];
  for (const layout of layouts) {
    for (const row of await listKeys(s3, layout.prefix)) {
      const jobId = layout.jobId(String(row.Key ?? ""));
      if (SAFE_ID.test(jobId)) jobIds.add(jobId);
    }
  }
  cache.reviewableJobs = { at: Date.now(), value: jobIds };
  return jobIds;
}

export function reviewerIdentity(environment = process.env) {
  const name = String(environment.REVIEWER_NAME ?? "Review Team").trim() ||
    "Review Team";
  const role = String(environment.REVIEWER_ROLE ?? "Reviewer").trim() ||
    "Reviewer";
  const words = name.split(/\s+/).filter(Boolean);
  const initials = `${words[0]?.[0] ?? "R"}${words.length > 1 ? words.at(-1)[0] : ""}`
    .toUpperCase()
    .slice(0, 2);
  return { name, role, initials };
}

export function encodePageCursor(offset) {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

export function decodePageCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^offset:(\d+)$/.exec(value);
    if (!match) throw new Error("invalid");
    return Number(match[1]);
  } catch {
    throw new HttpError(400, "Invalid continuation token");
  }
}

export function resultKind(modelId) {
  if (modelId === "mmc-vehicle-classification") return "vehicle";
  if (modelId === "people-count") return "people";
  if (modelId === "group-detection") return "group";
  if (modelId.includes("aggression")) return "segment";
  return "box";
}

function shortName(modelId) {
  if (modelId === "mmc-vehicle-classification") return "MMC";
  if (modelId === "ppe-compliance") return "PPE";
  if (modelId === "phone-usage-detection") return "Phone";
  if (modelId === "sleep-detection") return "Sleep";
  if (modelId.includes("aggression")) return "Aggression";
  return modelId.split("-")[0]?.replace(/^./, (value) => value.toUpperCase());
}

export function manualModelCatalog() {
  return MANUAL_MODEL_IDS.map((modelId) => ({
    id: modelId,
    name:
      MODEL_NAMES[modelId] ??
      modelId.replaceAll("-", " ").replace(/\b\w/g, (value) => value.toUpperCase()),
    short: shortName(modelId),
    color: MODEL_COLORS[modelId] ?? "#64748b",
    kind: resultKind(modelId),
    classes: CLASS_NAMES[modelId] ?? ["aggression"],
    manual_enabled: true,
  }));
}

function humanAge(modified) {
  const seconds = Math.max(0, Math.floor((Date.now() - modified.getTime()) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} min ago`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function workflows(results) {
  const names = [];
  if (results.some((result) => resultKind(String(result.model_id ?? "")) === "box")) {
    names.push("Boxes");
  }
  if (
    results.some((result) => resultKind(String(result.model_id ?? "")) === "vehicle")
  ) {
    names.push("MMC");
  }
  if (
    results.some((result) => resultKind(String(result.model_id ?? "")) === "segment")
  ) {
    names.push("Aggression");
  }
  return names;
}

function failureSummary(results) {
  const failed = results.filter((result) => result.status === "FAILED");
  if (!failed.length) return null;
  const messages = failed.map((result) =>
    String(result.error?.message ?? "").toLowerCase(),
  );
  if (
    messages.every(
      (message) =>
        message.includes("connection refused") ||
        message.includes("failed to resolve") ||
        message.includes("nameresolutionerror"),
    )
  ) {
    return "Model services unavailable";
  }
  if (
    messages.some(
      (message) =>
        message.includes("unable to decode") || message.includes("no readable frames"),
    )
  ) {
    return "Source video could not be decoded";
  }
  if (
    messages.some(
      (message) =>
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("exceeded 90s"),
    )
  ) {
    return "One or more models timed out";
  }
  if (
    messages.some(
      (message) => message.includes("400 client error") || message.includes("422 client error"),
    )
  ) {
    return "One or more models rejected the input";
  }
  return "One or more model executions failed";
}

function findPreviewKey(results) {
  for (const result of results) {
    if (result.status !== "SUCCESS") continue;
    const key = result.output_media?.annotated_image_s3_key;
    if (key) return String(key);
  }
  return null;
}

async function loadJobs(s3) {
  if (fresh(cache.jobs)) return cache.jobs.value;
  const responseObjects = (await listKeys(s3, "jobs/"))
    .filter(
      (row) =>
        String(row.Key ?? "").split("/").length === 3 &&
        String(row.Key ?? "").endsWith("/response.json"),
    )
    .sort((left, right) => right.LastModified - left.LastModified);
  const jobs = responseObjects.map((row, index) => ({
    id: row.Key.split("/")[1],
    captured: row.LastModified.toISOString(),
    time: humanAge(row.LastModified),
    preview_tone: index % 4,
  }));
  cache.jobs = { at: Date.now(), value: jobs };
  return jobs;
}

async function hydrateJobSummary(s3, job) {
  const cached = cache.summaries.get(job.id);
  if (fresh(cached)) return { ...job, ...cached.value };
  const response = await readJson(s3, `jobs/${job.id}/response.json`);
  const results = response.results ?? [];
  const successful = results.filter((result) => result.status === "SUCCESS");
  let sourceAvailable = true;
  try {
    await resolveSourceKey(s3, job.id, response);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    sourceAvailable = false;
  }
  const summary = {
    models: results.length,
    successful_models: successful.length,
    status: response.status ?? "UNKNOWN",
    signal: successful.reduce(
      (total, result) => total + (result.detections?.length ?? 0),
      0,
    ),
    workflows: successful.length ? workflows(successful) : sourceAvailable ? ["Manual"] : [],
    preview_available: sourceAvailable || Boolean(findPreviewKey(results)),
    source_available: sourceAvailable,
    preferred_batch_size:
      Number(response.preferred_batch_size) === 100 ? 100 : undefined,
    failure_summary: failureSummary(results),
  };
  cache.summaries.set(job.id, { at: Date.now(), value: summary });
  return { ...job, ...summary };
}

async function objectExists(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function resolveSourceKey(s3, jobId, response = null) {
  const directCandidates = [
    response?.source_key,
    response?.footage_s3_key,
    response?.input?.footage_s3_key,
    response?.request?.footage_s3_key,
    ...VIDEO_SUFFIXES.flatMap((suffix) => [
      `storage/uploads/UNASSIGNED_${jobId}${suffix}`,
      `storage/UNASSIGNED/uploads/${jobId}${suffix}`,
    ]),
  ].filter((key, index, keys) =>
    typeof key === "string" && key.length > 0 && keys.indexOf(key) === index,
  );
  for (const key of directCandidates) {
    if (await objectExists(s3, key)) return key;
  }

  const legacyCandidates = await listKeys(s3, `storage/UNASSIGNED/uploads/${jobId}`);
  const exactLegacy = legacyCandidates.find((row) => {
    const key = String(row.Key ?? "");
    const fileName = key.split("/").at(-1) ?? "";
    const suffix = extname(fileName).toLowerCase();
    return VIDEO_SUFFIXES.includes(suffix) && fileName.slice(0, -suffix.length) === jobId;
  });
  if (exactLegacy?.Key) return exactLegacy.Key;
  for (const row of await listKeys(s3, `jobs/${jobId}/`)) {
    if (!String(row.Key ?? "").endsWith("/input.json")) continue;
    try {
      const payload = await readJson(s3, row.Key);
      if (payload.footage_s3_key) return String(payload.footage_s3_key);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  throw new HttpError(404, "The job does not contain a resolvable source-video key");
}

async function loadJob(s3, jobId) {
  const cached = cache.jobsById.get(jobId);
  if (fresh(cached)) return cached.value;
  const response = await readJson(s3, `jobs/${jobId}/response.json`);
  response.job_id = jobId;
  response.source_key = await resolveSourceKey(s3, jobId, response);
  const source = await s3.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: response.source_key }),
  );
  response.source_etag = String(source.ETag ?? "").replaceAll('"', "");
  cache.jobsById.set(jobId, { at: Date.now(), value: response });
  return response;
}

async function buildLabelIndex(s3, jobId, modelIds = []) {
  const index = new Map();
  const priorities = new Map();
  const roots = [
    ["training", false, 1],
    ["prelabels", false, 2],
    ...(legacyAnnotationReadsEnabled()
      ? [["legacy-manual", true, 3]]
      : []),
  ];
  for (const [root, manual, priority] of roots) {
    const prefix =
      root === "legacy-manual"
        ? `${MANUAL_ROOT}/${jobId}/labels/`
        : `${root}/${jobId}/`;
    for (const row of await listKeys(s3, prefix)) {
      const match = /frame_(\d+)\.txt$/.exec(String(row.Key ?? ""));
      if (!match) continue;
      const parts = row.Key.split("/");
      const modelId = root === "legacy-manual" ? parts[3] : parts[2];
      if (!modelId) continue;
      const frame = Number(match[1]);
      const mapKey = `${modelId}\0${frame}`;
      if (priority >= (priorities.get(mapKey) ?? 0)) {
        priorities.set(mapKey, priority);
        index.set(mapKey, { key: row.Key, manual, modelId, frame });
      }
    }
  }
  for (const modelId of [...new Set(modelIds)].filter((id) => SAFE_ID.test(id))) {
    const prefix = `${MODEL_ROOT}/${modelId}/${jobId}/labels/`;
    for (const row of await listKeys(s3, prefix)) {
      const match = /frame_(\d+)\.txt$/.exec(String(row.Key ?? ""));
      if (!match) continue;
      const frame = Number(match[1]);
      const mapKey = `${modelId}\0${frame}`;
      priorities.set(mapKey, 4);
      index.set(mapKey, {
        key: row.Key,
        manual: true,
        modelId,
        frame,
      });
    }
  }
  return index;
}

export function frameNumbers(response, labelIndex) {
  const numbers = new Set([...labelIndex.values()].map((item) => item.frame));
  for (const key of ["sampled_frames", "frame_numbers"]) {
    if (Array.isArray(response[key])) {
      response[key].forEach((value) => {
        if (/^\d+$/.test(String(value))) numbers.add(Number(value));
      });
    }
    if (Array.isArray(response.sampling?.[key])) {
      response.sampling[key].forEach((value) => {
        if (/^\d+$/.test(String(value))) numbers.add(Number(value));
      });
    }
  }
  for (const result of response.results ?? []) {
    for (const detection of result.detections ?? []) {
      for (const instance of detection.instances ?? []) {
        const value = instance.attributes?.frame_number ?? instance.frame_number;
        if (value !== undefined && value !== null) numbers.add(Number(value));
      }
      if (detection.best_frame_number !== undefined && detection.best_frame_number !== null) {
        numbers.add(Number(detection.best_frame_number));
      }
    }
  }
  const sorted = [...numbers].filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted : [0];
}

export function sampleInterval(response) {
  const candidates = [
    response.sample_interval,
    response.frame_interval,
    response.sampling?.sample_interval,
    response.sampling?.frame_interval,
    SAMPLE_INTERVAL,
  ];
  for (const candidate of candidates) {
    const interval = Number(candidate);
    if (Number.isInteger(interval) && interval > 0) return interval;
  }
  return 15;
}

export function completeFrameNumbers(response, labelIndex, frameCount) {
  const discovered = new Set(frameNumbers(response, labelIndex));
  const interval = sampleInterval(response);
  for (let frame = 0; frame < Math.max(frameCount, 1); frame += interval) {
    discovered.add(frame);
  }
  return [...discovered]
    .filter((frame) => frame >= 0 && frame < frameCount)
    .sort((a, b) => a - b);
}

export function selectBatch(numbers, batch, size) {
  const start = batch * size;
  return {
    selected: numbers.slice(start, start + size),
    totalBatches: Math.max(1, Math.ceil(numbers.length / size)),
  };
}

export function selectRequestedBatch(numbers, batch, size, requestedFrame) {
  let resolvedBatch = batch;
  if (
    requestedFrame !== undefined &&
    requestedFrame !== null &&
    requestedFrame !== ""
  ) {
    const frame = Number(requestedFrame);
    if (!Number.isInteger(frame) || frame < 0) {
      throw new HttpError(422, "Invalid frame number");
    }
    const frameIndex = numbers.indexOf(frame);
    if (frameIndex < 0) {
      throw new HttpError(404, `Frame ${frame} is not in this job's review set`);
    }
    resolvedBatch = Math.floor(frameIndex / size);
  }
  return {
    batch: resolvedBatch,
    ...selectBatch(numbers, resolvedBatch, size),
  };
}

function runProcess(executable, args, { collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => {
      if (collectStdout) stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            `${basename(executable)} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-1200)}`,
          ),
        );
      }
    });
  });
}

async function ensureCacheRoot() {
  await mkdir(CACHE_ROOT, { recursive: true });
}

async function ensureVideo(s3, jobId, sourceKey) {
  const cacheKey = `${jobId}\0${sourceKey}`;
  const cached = cache.videos.get(cacheKey);
  if (cached) return cached.path;
  const pending = cache.videoPromises.get(cacheKey);
  if (pending) return pending;
  const promise = (async () => {
    await ensureCacheRoot();
    const folder = await mkdtemp(join(CACHE_ROOT, `${jobId}-`));
    const suffix = extname(sourceKey) || ".mp4";
    const path = join(folder, `source${suffix}`);
    try {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }),
      );
      if (!response.Body)
        throw new HttpError(404, "The source video has no body");
      await pipeline(response.Body, createWriteStream(path));
      cache.videos.set(cacheKey, { jobId, sourceKey, path, folder });
      cache.batches.delete(jobId);
      return path;
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();
  cache.videoPromises.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    cache.videoPromises.delete(cacheKey);
  }
}

async function videoMetadata(s3, jobId, sourceKey) {
  const path = await ensureVideo(s3, jobId, sourceKey);
  let raw;
  try {
    raw = await runProcess(
      FFPROBE,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,nb_frames,width,height,duration",
        "-of",
        "json",
        path,
      ],
      { collectStdout: true },
    );
  } catch (error) {
    throw new HttpError(422, `FFprobe could not open the source video: ${error.message}`);
  }
  const stream = JSON.parse(raw.toString("utf8")).streams?.[0];
  if (!stream) throw new HttpError(422, "FFprobe found no video stream");
  const [numerator, denominator] = String(stream.avg_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  const fps = denominator ? numerator / denominator : 0;
  let frameCount = Number(stream.nb_frames);
  if (!Number.isFinite(frameCount) || frameCount <= 0) {
    frameCount = Math.round(Number(stream.duration ?? 0) * fps);
  }
  if (!fps || !frameCount) throw new HttpError(422, "The source video metadata is incomplete");
  return {
    fps,
    frame_count: frameCount,
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

function rememberFrame(jobId, frameNumber, data) {
  const key = `${jobId}\0${frameNumber}`;
  cache.frames.delete(key);
  cache.frames.set(key, data);
  while (cache.frames.size > FRAME_CACHE_LIMIT) {
    cache.frames.delete(cache.frames.keys().next().value);
  }
}

async function primeFrameBatch(s3, jobId, sourceKey, numbers) {
  const wanted = [...new Set(numbers)].sort((a, b) => a - b);
  if (!wanted.length) return;
  const signature = `${jobId}:${wanted.join(",")}`;
  if (
    cache.batches.get(jobId) === signature &&
    wanted.every((frame) => cache.frames.has(`${jobId}\0${frame}`))
  ) {
    return;
  }
  const path = await ensureVideo(s3, jobId, sourceKey);
  const outputDirectory = await mkdtemp(join(CACHE_ROOT, "batch-"));
  const expression = wanted.map((frame) => `eq(n\\,${frame})`).join("+");
  try {
    await runProcess(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path,
      "-vf",
      `select=${expression}`,
      "-fps_mode",
      "vfr",
      "-q:v",
      "4",
      join(outputDirectory, "frame-%03d.jpg"),
    ]);
    const files = (await readdir(outputDirectory))
      .filter((name) => name.endsWith(".jpg"))
      .sort();
    if (files.length !== wanted.length) {
      throw new HttpError(404, `Frames outside the source video: ${wanted.slice(files.length, files.length + 3).join(", ")}`);
    }
    for (let index = 0; index < wanted.length; index += 1) {
      rememberFrame(jobId, wanted[index], await readFile(join(outputDirectory, files[index])));
    }
    cache.batches.set(jobId, signature);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function extractFrame(s3, jobId, frameNumber) {
  const cacheKey = `${jobId}\0${frameNumber}`;
  const cached = cache.frames.get(cacheKey);
  if (cached) {
    cache.frames.delete(cacheKey);
    cache.frames.set(cacheKey, cached);
    return cached;
  }
  const job = await loadJob(s3, jobId);
  const path = await ensureVideo(s3, jobId, job.source_key);
  let data;
  try {
    data = await runProcess(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path,
        "-vf",
        `select=eq(n\\,${frameNumber})`,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { collectStdout: true },
    );
  } catch {
    throw new HttpError(404, `Frame ${frameNumber} is outside the source video`);
  }
  if (!data.length) throw new HttpError(404, `Frame ${frameNumber} is outside the source video`);
  rememberFrame(jobId, frameNumber, data);
  return data;
}

function classLabel(modelId, classId) {
  return CLASS_NAMES[modelId]?.[classId] ?? `class_${classId}`;
}

function classIdForLabel(modelId, label, fallback = 0) {
  const index = (CLASS_NAMES[modelId] ?? []).indexOf(label);
  return index >= 0 ? index : fallback;
}

function validatedClassId(modelId, label, classId) {
  const classes = CLASS_NAMES[modelId];
  if (!classes) return classId;
  const known = classes.indexOf(label);
  if (known >= 0) return known;
  if (Number.isInteger(classId) && classId >= 0 && classId < classes.length) {
    return classId;
  }
  throw new HttpError(422, `Unknown class '${label}' for ${modelId}`);
}

async function labelBytes(s3, labelIndex, modelId, frame) {
  const entry = labelIndex.get(`${modelId}\0${frame}`);
  if (!entry) return { data: null, manual: false };
  const response = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: entry.key }),
  );
  return { data: await bodyBytes(response.Body), manual: entry.manual };
}

async function manualMetadata(s3, jobId, modelId, frame) {
  const raw =
    (await tryBytes(s3, modelMetadataKey(modelId, jobId, frame))) ??
    (legacyAnnotationReadsEnabled()
      ? await tryBytes(s3, legacyMetadataKey(jobId, modelId, frame))
      : null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseYolo(data, modelId, frame, manual, metadata) {
  const richAnnotations = metadata?.annotations ?? [];
  return data
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line, index) => {
      const values = line.trim().split(/\s+/).map(Number);
      if (values.length < 5 || values.some((value) => !Number.isFinite(value))) return [];
      const [classId, centerX, centerY, width, height] = values;
      const rich =
        richAnnotations[index] && typeof richAnnotations[index] === "object"
          ? richAnnotations[index]
          : {};
      return {
        id: `${modelId}-${frame}-${index}`,
        model_id: modelId,
        class_id: classId,
        label: classLabel(modelId, classId),
        confidence: manual ? 1 : 0.75,
        x: (centerX - width / 2) * 100,
        y: (centerY - height / 2) * 100,
        width: width * 100,
        height: height * 100,
        track_id: rich.track_id,
        attributes: rich.attributes,
        manual,
      };
    });
}

function instanceAnnotations(result, frame, width, height) {
  const modelId = String(result.model_id ?? "");
  const rows = [];
  for (const [detectionIndex, detection] of (result.detections ?? []).entries()) {
    for (const [index, instance] of (detection.instances ?? []).entries()) {
      const attributes = instance.attributes ?? {};
      const instanceFrame =
        attributes.frame_number ??
        instance.frame_number ??
        detection.best_frame_number;
      if (Number(instanceFrame) !== frame || !instance.bbox) continue;
      const box = instance.bbox;
      rows.push({
        id: `${modelId}-${frame}-${detectionIndex}-${index}`,
        model_id: modelId,
        class_id: classIdForLabel(
          modelId,
          String(detection.label ?? "detection"),
          Number(instance.class_id ?? 0),
        ),
        label: detection.label ?? "detection",
        confidence: Number(instance.confidence ?? 1),
        x: (Number(box.x) / width) * 100,
        y: (Number(box.y) / height) * 100,
        width: (Number(box.w) / width) * 100,
        height: (Number(box.h) / height) * 100,
        track_id: attributes.track_id,
        attributes,
        manual: false,
      });
    }
  }
  return rows;
}

function segmentsForFrame(result, frame, fps) {
  const timestampMs = (frame / Math.max(fps, 1)) * 1000;
  return (result.detections ?? []).flatMap((detection) => {
    const start = detection.first_seen_ms ?? detection.start_ms;
    const end = detection.last_seen_ms ?? detection.end_ms;
    if (start === undefined || end === undefined) return [];
    if (Number(start) > timestampMs || Number(end) < timestampMs) return [];
    return {
      label: detection.label ?? "aggression",
      start_ms: Number(start),
      end_ms: Number(end),
      confidence: Number(detection.confidence ?? 1),
    };
  });
}

export async function frameReview(s3, frame, response, metadata, labelIndex) {
  const models = [];
  const outputResults = response.results ?? [];
  const resultsById = new Map(
    outputResults.map((result) => [String(result.model_id), result]),
  );
  const catalog = manualModelCatalog();
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const manualModelIds = new Set(
    [...labelIndex.values()]
      .filter((item) => item.manual)
      .map((item) => item.modelId),
  );
  const modelIds = [
    ...resultsById.keys(),
    ...catalog.map((model) => model.id).filter((id) => !resultsById.has(id)),
  ];
  for (const modelId of modelIds) {
    const outputResult = resultsById.get(modelId);
    const result = outputResult ?? {
      model_id: modelId,
      status: "MANUAL_ONLY",
      detections: [],
    };
    const definition = catalogById.get(modelId);
    const kind = resultKind(modelId);
    let annotations = [];
    let segments = [];
    let storedMetadata = null;
    if (kind === "segment") {
      const manualEntry = labelIndex.get(`${modelId}\0${frame}`);
      if (manualEntry) {
        storedMetadata = await manualMetadata(s3, response.job_id, modelId, frame);
        if (Array.isArray(storedMetadata?.segments)) segments = storedMetadata.segments;
        else if (storedMetadata?.segment) segments = [storedMetadata.segment];
      } else if (result.status === "SUCCESS") {
        segments = segmentsForFrame(result, frame, metadata.fps);
      }
    } else {
      const storedLabel = await labelBytes(s3, labelIndex, modelId, frame);
      const rich = result.status === "SUCCESS"
        ? instanceAnnotations(result, frame, metadata.width, metadata.height)
        : [];
      storedMetadata = storedLabel.manual
        ? await manualMetadata(s3, response.job_id, modelId, frame)
        : null;
      // Group training labels currently contain the nested person boxes, not
      // the outer group boxes. Only a manual group override may supersede the
      // rich group result; non-manual YOLO rows must not be rendered as groups.
      annotations = kind === "group" && !storedLabel.manual
        ? rich
        : storedLabel.data
          ? parseYolo(storedLabel.data, modelId, frame, storedLabel.manual, storedMetadata)
          : rich;
      if (rich.length && !storedLabel.manual) annotations = rich;
    }
    const classes = [
      ...(definition?.classes ?? CLASS_NAMES[modelId] ?? []),
      ...(result.detections ?? []).map((detection) => String(detection.label)).filter(Boolean),
      ...annotations.map((annotation) => String(annotation.label)).filter(Boolean),
    ].filter((value, index, values) => values.indexOf(value) === index);
    const groupPeopleCounts = annotations
      .map((annotation) => Number(annotation.attributes?.people_count))
      .filter(Number.isFinite);
    models.push({
      id: modelId,
      name:
        definition?.name ??
        MODEL_NAMES[modelId] ??
        modelId.replaceAll("-", " ").replace(/\b\w/g, (value) => value.toUpperCase()),
      short: definition?.short ?? shortName(modelId),
      color: definition?.color ?? MODEL_COLORS[modelId] ?? "#64748b",
      kind,
      status: result.status,
      source: outputResult
        ? "model_output"
        : manualModelIds.has(modelId)
          ? "manual_saved"
          : "manual_available",
      annotations,
      segments,
      segment: segments[0] ?? null,
      count: kind === "segment" ? segments.length : annotations.length,
      people_count:
        kind === "people"
          ? Number.isInteger(storedMetadata?.people_count)
            ? storedMetadata.people_count
            : annotations.length
          : undefined,
      group_count: kind === "group" ? annotations.length : undefined,
      grouped_people_count:
        kind === "group" && groupPeopleCounts.length === annotations.length
          ? groupPeopleCounts.reduce((total, count) => total + count, 0)
          : undefined,
      classes: classes.length ? classes : ["detection"],
    });
  }
  const correctedModels = [...labelIndex.values()]
    .filter((item) => item.frame === frame && item.manual)
    .map((item) => item.modelId)
    .sort();
  return {
    frame_number: frame,
    timestamp_ms: Math.round((frame / Math.max(metadata.fps, 1)) * 1000),
    models,
    reviewed: correctedModels.length > 0,
    corrected_models: correctedModels,
  };
}

function numberInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new HttpError(422, `${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeCorrection(correction) {
  const modelId = validateId(correction?.model_id, "model ID");
  if (!MANUAL_MODEL_IDS.includes(modelId)) {
    throw new HttpError(422, `Model '${modelId}' is not available for manual annotation`);
  }
  const annotations = Array.isArray(correction?.annotations)
    ? correction.annotations.map((item, index) => ({
        id: String(item.id ?? `${modelId}-${index}`),
        class_id: Math.max(0, Math.floor(Number(item.class_id ?? 0))),
        label: String(item.label ?? "detection"),
        confidence: numberInRange(item.confidence ?? 1, 0, 1, "confidence"),
        x: numberInRange(item.x, 0, 100, "x"),
        y: numberInRange(item.y, 0, 100, "y"),
        width: numberInRange(item.width, 0, 100, "width"),
        height: numberInRange(item.height, 0, 100, "height"),
        track_id:
          item.track_id === undefined || item.track_id === null
            ? undefined
            : Number(item.track_id),
        attributes:
          item.attributes && typeof item.attributes === "object"
            ? item.attributes
            : undefined,
      }))
    : [];
  const inputSegments = Array.isArray(correction?.segments)
    ? correction.segments
    : correction?.segment
      ? [correction.segment]
      : [];
  const segments = inputSegments.map((segment) => {
    const start = numberInRange(segment.start_ms, 0, Number.MAX_SAFE_INTEGER, "start_ms");
    const end = numberInRange(segment.end_ms, 0, Number.MAX_SAFE_INTEGER, "end_ms");
    if (end < start) throw new HttpError(422, "Aggression segment end must not be before its start");
    return {
      label: String(segment.label ?? "aggression"),
      start_ms: start,
      end_ms: end,
      confidence: numberInRange(segment.confidence ?? 1, 0, 1, "confidence"),
    };
  });
  const peopleCount = correction?.people_count === undefined
    ? undefined
    : Math.floor(numberInRange(
        correction.people_count,
        0,
        Number.MAX_SAFE_INTEGER,
        "people_count",
      ));
  return { modelId, annotations, segments, peopleCount };
}

async function optionalJson(s3, key) {
  const raw = await tryBytes(s3, key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function correctionReviewStatus(correction) {
  if (
    correction.annotations.length === 0 &&
    correction.segments.length === 0 &&
    (!Number.isInteger(correction.peopleCount) || correction.peopleCount === 0)
  ) {
    return "reviewed_empty";
  }
  return "corrected";
}

async function updateModelManifest(
  s3,
  jobId,
  frameNumber,
  correction,
  updatedAt,
) {
  const key = modelManifestKey(correction.modelId, jobId);
  const existing = (await optionalJson(s3, key)) ?? {};
  const manifest = {
    schema_version: 2,
    model_id: correction.modelId,
    job_id: jobId,
    updated_at: updatedAt,
    frames: {
      ...(existing.frames && typeof existing.frames === "object"
        ? existing.frames
        : {}),
      [String(frameNumber)]: {
        frame_number: frameNumber,
        review_status: correctionReviewStatus(correction),
        image_key: sharedImageKey(jobId, frameNumber),
        label_key: modelLabelKey(correction.modelId, jobId, frameNumber),
        metadata_key: modelMetadataKey(correction.modelId, jobId, frameNumber),
        updated_at: updatedAt,
      },
    },
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }),
  );
  return key;
}

async function ensureDualFrameImage(s3, jobId, frameNumber) {
  const currentKey = sharedImageKey(jobId, frameNumber);
  const legacyKey = legacyImageKey(jobId, frameNumber);
  const shouldReadLegacy = legacyAnnotationReadsEnabled();
  const shouldWriteLegacy = legacyAnnotationWritesEnabled();
  const currentExists = await objectExists(s3, currentKey);
  const legacyExists =
    shouldReadLegacy || shouldWriteLegacy
      ? await objectExists(s3, legacyKey)
      : false;
  if (currentExists && (!shouldWriteLegacy || legacyExists)) {
    return shouldWriteLegacy ? [currentKey, legacyKey] : [currentKey];
  }
  const currentBytes = currentExists ? await tryBytes(s3, currentKey) : null;
  const legacyBytes =
    shouldReadLegacy && legacyExists ? await tryBytes(s3, legacyKey) : null;
  const body =
    currentBytes ??
    legacyBytes ??
    (await extractFrame(s3, jobId, frameNumber));
  if (!currentExists) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: currentKey,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
  }
  if (shouldWriteLegacy && !legacyExists) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: legacyKey,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
  }
  return shouldWriteLegacy ? [currentKey, legacyKey] : [currentKey];
}

export async function writeFrameCorrections(s3, jobId, frameNumber, corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return [];
  const normalizedCorrections = corrections.map(normalizeCorrection);
  const written = [];
  written.push(...(await ensureDualFrameImage(s3, jobId, frameNumber)));
  for (const correction of normalizedCorrections) {
    const lines = correction.annotations.map((item) => {
      const classId = validatedClassId(
        correction.modelId,
        item.label,
        item.class_id,
      );
      const centerX = (item.x + item.width / 2) / 100;
      const centerY = (item.y + item.height / 2) / 100;
      return `${classId} ${centerX.toFixed(6)} ${centerY.toFixed(6)} ${(item.width / 100).toFixed(6)} ${(item.height / 100).toFixed(6)}`;
    });
    const labelBody = lines.length ? `${lines.join("\n")}\n` : "";
    const currentLabelKey = modelLabelKey(
      correction.modelId,
      jobId,
      frameNumber,
    );
    const oldLabelKey = legacyLabelKey(jobId, correction.modelId, frameNumber);
    const labelKeys = legacyAnnotationWritesEnabled()
      ? [currentLabelKey, oldLabelKey]
      : [currentLabelKey];
    for (const key of labelKeys) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: labelBody,
          ContentType: "text/plain",
        }),
      );
      written.push(key);
    }
    const updatedAt = new Date().toISOString();
    const metadata = {
      version: 2,
      schema_version: 2,
      job_id: jobId,
      model_id: correction.modelId,
      kind: resultKind(correction.modelId),
      frame_number: frameNumber,
      image_key: sharedImageKey(jobId, frameNumber),
      review_status: correctionReviewStatus(correction),
      reviewer: reviewerIdentity(),
      annotations: correction.annotations,
      people_count: correction.peopleCount,
      segments: correction.segments,
      segment: correction.segments[0] ?? null,
      updated_at: updatedAt,
    };
    const currentMetadataKey = modelMetadataKey(
      correction.modelId,
      jobId,
      frameNumber,
    );
    const oldMetadataKey = legacyMetadataKey(
      jobId,
      correction.modelId,
      frameNumber,
    );
    const metadataKeys = legacyAnnotationWritesEnabled()
      ? [currentMetadataKey, oldMetadataKey]
      : [currentMetadataKey];
    for (const key of metadataKeys) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: JSON.stringify(metadata),
          ContentType: "application/json",
        }),
      );
      written.push(key);
    }
    written.push(
      await updateModelManifest(
        s3,
        jobId,
        frameNumber,
        correction,
        updatedAt,
      ),
    );
  }
  return written;
}

async function verifySourceEtag(s3, job, sourceEtag, plural = false) {
  const response = await s3.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: job.source_key }),
  );
  const current = String(response.ETag ?? "").replaceAll('"', "");
  if (!sourceEtag || sourceEtag !== current) {
    throw new HttpError(
      409,
      `The source video changed after ${plural ? "these frames were" : "this frame was"} loaded; reload before saving`,
    );
  }
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(1, values.length)) }, worker),
  );
  return results;
}

function dateQuery(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(422, `Invalid ${label} timestamp`);
  return date;
}

export function cacheKeyForPage(query) {
  return JSON.stringify([
    query.range,
    query.start ?? null,
    query.end ?? null,
    query.limit,
    query.continuation_token ?? null,
    query.filter ?? "all",
  ]);
}

export async function getHealth({
  s3 = defaultClients.s3,
  sts = defaultClients.sts,
  environment = process.env,
} = {}) {
  await ensureCacheRoot();
  if (fresh(cache.health)) return cache.health.value;
  try {
    const [identity] = await Promise.all([
      sts.send(new GetCallerIdentityCommand({})),
      s3.send(new HeadBucketCommand({ Bucket: BUCKET })),
    ]);
    const value = {
      status: "ok",
      bucket: BUCKET,
      region: REGION,
      account: identity.Account,
      reviewer: reviewerIdentity(environment),
    };
    cache.health = { at: Date.now(), value };
    return value;
  } catch {
    throw new HttpError(503, "AWS session or bucket access is unavailable");
  }
}

export async function getJobs(query = {}, { s3 = defaultClients.s3 } = {}) {
    await ensureCacheRoot();
    const range = query.range ?? "24h";
    if (!["1h", "24h", "7d", "custom", "all"].includes(range)) {
      throw new HttpError(422, "Invalid date range");
    }
    const limit = Number(query.limit ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new HttpError(422, "limit must be between 1 and 25");
    }
    let rangeStart = null;
    let rangeEnd = null;
    if (range === "custom") {
      rangeStart = dateQuery(query.start, "start");
      rangeEnd = dateQuery(query.end, "end");
      if (!rangeStart || !rangeEnd) {
        throw new HttpError(422, "Custom range requires start and end timestamps");
      }
      if (rangeStart > rangeEnd) {
        throw new HttpError(422, "Custom range start must be before end");
      }
    } else if (range !== "all") {
      const hours = { "1h": 1, "24h": 24, "7d": 168 }[range];
      rangeStart = new Date(Date.now() - hours * 3_600_000);
    }
    const search = String(query.search ?? "").trim();
    const filter = String(query.filter ?? "all");
    if (!new Set(["all", "reviewable", "corrected"]).has(filter)) {
      throw new HttpError(422, "Invalid job filter");
    }
    const correctedJobIds = await loadCorrectedJobIds(s3);
    const reviewableJobIds =
      filter === "reviewable" ? await loadReviewableJobIds(s3) : null;
    if (search) {
      if (SAFE_ID.test(search)) {
        try {
          const head = await s3.send(
            new HeadObjectCommand({
              Bucket: BUCKET,
              Key: `jobs/${search}/response.json`,
            }),
          );
          const modified = head.LastModified;
          if (
            (!rangeStart || modified >= rangeStart) &&
            (!rangeEnd || modified <= rangeEnd)
          ) {
            const job = await hydrateJobSummary(s3, {
              id: search,
              captured: modified.toISOString(),
              time: humanAge(modified),
              preview_tone: 0,
            });
            if (filter === "corrected" && !correctedJobIds.has(job.id)) {
              return {
                jobs: [],
                count: 0,
                total_count: 0,
                limit,
                next_continuation_token: null,
              };
            }
            if (filter === "reviewable" && !job.source_available) {
              return {
                jobs: [],
                count: 0,
                total_count: 0,
                limit,
                next_continuation_token: null,
              };
            }
            return {
              jobs: [{ ...job, has_corrections: correctedJobIds.has(job.id) }],
              count: 1,
              total_count: 1,
              limit,
              next_continuation_token: null,
            };
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return {
        jobs: [],
        count: 0,
        total_count: 0,
        limit,
        next_continuation_token: null,
      };
    }
    const pageCacheKey = cacheKeyForPage({ ...query, range, limit });
    const cached = cache.pages.get(pageCacheKey);
    if (fresh(cached)) return cached.value;
    const offset = decodePageCursor(query.continuation_token);
    const matches = (await loadJobs(s3))
      .filter((job) => {
        const captured = new Date(job.captured);
        return (
          (!rangeStart || captured >= rangeStart) &&
          (!rangeEnd || captured <= rangeEnd) &&
          (filter !== "corrected" || correctedJobIds.has(job.id)) &&
          (filter !== "reviewable" || reviewableJobIds.has(job.id))
        );
      })
      .sort((left, right) => right.captured.localeCompare(left.captured));
    const rows = matches.slice(offset, offset + limit);
    const hydrated = await mapLimit(rows, 6, async (row) => {
      try {
        return await hydrateJobSummary(s3, row);
      } catch (error) {
        if (error instanceof HttpError) return null;
        throw error;
      }
    });
    const visible = hydrated
      .filter(Boolean)
      .map((job) => ({
        ...job,
        has_corrections: correctedJobIds.has(job.id),
      }));
    const nextOffset = offset + rows.length;
    const value = {
      jobs: visible,
      count: visible.length,
      total_count: matches.length,
      limit,
      next_continuation_token:
        nextOffset < matches.length ? encodePageCursor(nextOffset) : null,
    };
    cache.pages.set(pageCacheKey, { at: Date.now(), value });
    return value;
}

export async function getJobDetail(jobIdValue, query = {}, { s3 = defaultClients.s3 } = {}) {
    await ensureCacheRoot();
    const jobId = validateId(jobIdValue, "job ID");
    const batch = Number(query.batch ?? 0);
    const size = Number(query.size ?? 20);
    if (!Number.isInteger(batch) || batch < 0) throw new HttpError(422, "Invalid batch");
    if (!Number.isInteger(size) || size < 1 || size > MAX_FRAME_BATCH_SIZE) {
      throw new HttpError(
        422,
        `size must be between 1 and ${MAX_FRAME_BATCH_SIZE}`,
      );
    }
    const response = await loadJob(s3, jobId);
    const metadata = await videoMetadata(s3, jobId, response.source_key);
    const labels = await buildLabelIndex(
      s3,
      jobId,
      [
        ...(response.results ?? []).map((result) =>
          String(result.model_id ?? ""),
        ),
        ...manualModelCatalog().map((model) => model.id),
      ],
    );
    const numbers = completeFrameNumbers(response, labels, metadata.frame_count);
    const selection = selectRequestedBatch(numbers, batch, size, query.frame);
    const { selected, totalBatches } = selection;
    if (selection.batch >= totalBatches) {
      throw new HttpError(404, "The requested frame batch does not exist");
    }
    await primeFrameBatch(s3, jobId, response.source_key, selected);
    const reviewedFrames = [...new Set(
      [...labels.values()].filter((item) => item.manual).map((item) => item.frame),
    )].sort((a, b) => a - b);
    return {
      job_id: jobId,
      status: response.status,
      source_key: response.source_key,
      source_etag: response.source_etag,
      metadata,
      total_frames: numbers.length,
      batch: selection.batch,
      sample_interval: sampleInterval(response),
      reviewed_frames: reviewedFrames,
      batch_size: size,
      total_batches: totalBatches,
      available_models: manualModelCatalog(),
      frames: await mapLimit(selected, 6, (frame) =>
        frameReview(s3, frame, response, metadata, labels),
      ),
      failed_models: (response.results ?? [])
        .filter((result) => result.status === "FAILED")
        .map((result) => ({
          id: result.model_id,
          error: result.error?.message,
        })),
    };
}

async function sourcePreview(s3, job) {
    const cacheKey = `${job.job_id}\0${job.source_etag}`;
    const cached = cache.previews.get(cacheKey);
    if (cached?.data) return cached.data;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
      await ensureCacheRoot();
      const folder = await mkdtemp(join(CACHE_ROOT, "preview-"));
      const sourcePath = join(folder, `source${extname(job.source_key) || ".mp4"}`);
      const previewPath = join(folder, "preview.jpg");
      try {
        const response = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET, Key: job.source_key }),
        );
        if (!response.Body) throw new HttpError(404, "The source video has no body");
        await pipeline(response.Body, createWriteStream(sourcePath));
        await runProcess(FFMPEG, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          sourcePath,
          "-frames:v",
          "1",
          "-vf",
          "scale=320:-2",
          "-q:v",
          "5",
          previewPath,
        ]);
        return await readFile(previewPath);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, `Could not create a source-video preview: ${error.message}`);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    })();
    cache.previews.set(cacheKey, { promise });
    try {
      const data = await promise;
      cache.previews.set(cacheKey, { data });
      while (cache.previews.size > 100) {
        cache.previews.delete(cache.previews.keys().next().value);
      }
      return data;
    } catch (error) {
      cache.previews.delete(cacheKey);
      throw error;
    }
}

export async function getPreviewImage(jobIdValue, { s3 = defaultClients.s3 } = {}) {
    const jobId = validateId(jobIdValue, "job ID");
    const response = await loadJob(s3, jobId);
    const key = findPreviewKey(response.results ?? []);
    if (key) {
      const redirectUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: 300 },
      );
      return { redirectUrl, data: null };
    }
    return { redirectUrl: null, data: await sourcePreview(s3, response) };
}

export async function getFrameImage(jobIdValue, frameNumberValue, { s3 = defaultClients.s3 } = {}) {
    await ensureCacheRoot();
    const jobId = validateId(jobIdValue, "job ID");
    const frameNumber = Number(frameNumberValue);
    if (!Number.isInteger(frameNumber) || frameNumber < 0) {
      throw new HttpError(400, "Invalid frame number");
    }
    for (const savedKey of [
      sharedImageKey(jobId, frameNumber),
      ...(legacyAnnotationReadsEnabled()
        ? [legacyImageKey(jobId, frameNumber)]
        : []),
    ]) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: savedKey }));
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: savedKey }),
          { expiresIn: 300 },
        );
        return { redirectUrl: url, data: null };
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return { redirectUrl: null, data: await extractFrame(s3, jobId, frameNumber) };
}

export async function saveFrameCorrections(jobIdValue, frameNumberValue, body, { s3 = defaultClients.s3 } = {}) {
    await ensureCacheRoot();
    const jobId = validateId(jobIdValue, "job ID");
    const frameNumber = Number(frameNumberValue);
    if (!Number.isInteger(frameNumber) || frameNumber < 0) {
      throw new HttpError(400, "Invalid frame number");
    }
    const job = await loadJob(s3, jobId);
    await verifySourceEtag(s3, job, body?.source_etag);
    const written = await writeFrameCorrections(
      s3,
      jobId,
      frameNumber,
      body?.corrections ?? [],
    );
    if (written.length) {
      cache.correctedJobs.value.add(jobId);
      cache.correctedJobs.at = Date.now();
      cache.pages.clear();
    }
    cache.jobsById.delete(jobId);
    return { saved: true, written };
}

export async function saveBatchCorrections(jobIdValue, body, { s3 = defaultClients.s3 } = {}) {
    await ensureCacheRoot();
    const jobId = validateId(jobIdValue, "job ID");
    const frames = body?.frames;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 100) {
      throw new HttpError(422, "frames must contain between 1 and 100 items");
    }
    const job = await loadJob(s3, jobId);
    await verifySourceEtag(s3, job, body?.source_etag, true);
    const results = [];
    for (const frame of frames) {
      const frameNumber = Number(frame.frame_number);
      if (!Number.isInteger(frameNumber) || frameNumber < 0) {
        results.push({
          frame_number: frame.frame_number,
          saved: false,
          error: "Invalid frame number",
        });
        continue;
      }
      try {
        const written = await writeFrameCorrections(
          s3,
          jobId,
          frameNumber,
          frame.corrections ?? [],
        );
        if (written.length) cache.correctedJobs.value.add(jobId);
        results.push({ frame_number: frameNumber, saved: true, written });
      } catch (error) {
        results.push({
          frame_number: frameNumber,
          saved: false,
          error: error.message ?? String(error),
        });
      }
    }
    cache.jobsById.delete(jobId);
    cache.correctedJobs.at = Date.now();
    cache.pages.clear();
    const failedCount = results.filter((result) => !result.saved).length;
    return {
      saved: failedCount === 0,
      saved_count: results.length - failedCount,
      failed_count: failedCount,
      results,
    };
}

export async function routeResponse(operation) {
  try {
    const result = await operation();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    const statusCode = error.statusCode ?? error.$metadata?.httpStatusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return Response.json({ detail: error.message }, { status: statusCode });
    }
    const credentialError =
      error.name === "CredentialsProviderError" ||
      error.name === "ExpiredToken" ||
      error.name === "UnauthorizedException";
    if (credentialError) {
      return Response.json(
        { detail: "AWS session or bucket access is unavailable" },
        { status: 503 },
      );
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return Response.json(
        {
          detail:
            "The dashboard frame cache is not writable. Restart the service with a writable temporary directory.",
        },
        { status: 503 },
      );
    }
    if (error.code === "ENOSPC") {
      return Response.json(
        { detail: "The server has insufficient temporary disk space for video frames." },
        { status: 507 },
      );
    }
    console.error("Dashboard route failed", error);
    return Response.json(
      { detail: error.message ?? "Dashboard API failed" },
      { status: 500 },
    );
  }
}

export function resetCachesForTests() {
  cache.jobs = { at: 0, value: [] };
  cache.correctedJobs = { at: 0, value: new Set() };
  cache.reviewableJobs = { at: 0, value: new Set() };
  cache.pages.clear();
  cache.summaries.clear();
  cache.jobsById.clear();
  cache.health = { at: 0, value: null };
  cache.videos.clear();
  cache.videoPromises.clear();
  cache.batches.clear();
  cache.frames.clear();
  cache.previews.clear();
}
