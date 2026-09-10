import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import ffmpegPath from "ffmpeg-static";

const BUCKET = process.env.S3_BUCKET ?? "icu-solarcam-storage-bacancy-ap-southeast-2";
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const JOB_ID = "dashboard-100-frame-test-20260909";
const FIXTURE_KEY = "storage/UNASSIGNED/uploads/09490c13-fd73-57b5-890c-5ee1fb50a67e.mp4";
const SOURCE_KEY = `storage/UNASSIGNED/uploads/${JOB_ID}.mp4`;
const RESPONSE_KEY = `jobs/${JOB_ID}/response.json`;
const PREVIEW_KEY = `jobs/${JOB_ID}/preview.jpg`;
const FPS = 40;
const TOTAL_FRAMES = 105;
const FRAMES = Array.from({ length: TOTAL_FRAMES }, (_, frame) => frame);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
    });
  });
}

async function bodyToFile(body, path) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  await writeFile(path, Buffer.concat(chunks));
}

function instance(frame, x, y, w, h, confidence, attributes = {}) {
  return { class_id: 0, confidence, bbox: { x, y, w, h }, attributes: { frame_number: frame, ...attributes } };
}

function result(modelId, detections, preview = false) {
  return {
    model_id: modelId,
    model_version: "dashboard-100-frame-real-video-test-v1",
    status: "SUCCESS",
    processing_time_ms: 1120,
    output_media: {
      annotated_video_s3_key: null,
      annotated_image_s3_key: preview ? PREVIEW_KEY : null,
    },
    detections,
    error: null,
  };
}

function responseDocument() {
  const everyFifth = FRAMES.filter((frame) => frame % 5 === 0);
  return {
    job_id: JOB_ID,
    status: "SUCCESS",
    test_job: true,
    created_for: "100-frame dashboard batch performance test using a real CCTV video",
    created_at: new Date().toISOString(),
    preferred_batch_size: 100,
    sample_interval: 1,
    sampled_frames: FRAMES,
    results: [
      result("ppe-compliance", [
        { label: "person", instances: everyFifth.map((frame) => instance(frame, 710, 350, 115, 280, 0.93)) },
        { label: "no_helmet", instances: everyFifth.map((frame) => instance(frame, 735, 345, 48, 55, 0.88)) },
      ], true),
      result("phone-usage-detection", [
        { label: "in_hand", instances: FRAMES.filter((frame) => frame >= 25 && frame <= 55).map((frame) => instance(frame, 780, 430, 45, 72, 0.76)) },
      ]),
      result("sleep-detection", [
        { label: "sleeping", instances: FRAMES.filter((frame) => frame >= 70 && frame % 3 === 1).map((frame) => instance(frame, 315, 385, 145, 245, 0.61)) },
      ]),
      result("videomae-aggression", [
        { label: "aggression", confidence: 0.72, first_seen_ms: 1500, last_seen_ms: 2400, best_frame_number: 78 },
      ]),
    ],
    error: null,
    response_s3_key: RESPONSE_KEY,
  };
}

async function listKeys(s3, prefix) {
  const keys = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    keys.push(...(page.Contents ?? []).flatMap((row) => (row.Key ? [row.Key] : [])));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteKeys(s3, keys) {
  for (let start = 0; start < keys.length; start += 1000) {
    const objects = keys.slice(start, start + 1000).map((Key) => ({ Key }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }));
  }
}

async function exists(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (["NotFound", "NoSuchKey", 404].includes(error?.name ?? error?.Code ?? error?.$metadata?.httpStatusCode)) return false;
    throw error;
  }
}

async function create(replace) {
  const s3 = new S3Client({ region: REGION });
  if ((await exists(s3, RESPONSE_KEY)) && !replace)
    throw new Error(`Test job already exists: ${JOB_ID}. Run npm run test-job-105:replace.`);
  if (replace) await deleteKeys(s3, await listKeys(s3, `manual-annotations/${JOB_ID}/`));

  const folder = await mkdtemp(join(tmpdir(), "retrain-105-frame-test-"));
  try {
    const originalPath = join(folder, "original.mp4");
    const videoPath = join(folder, `${JOB_ID}.mp4`);
    const previewPath = join(folder, "preview.jpg");
    const fixture = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: FIXTURE_KEY }));
    if (!fixture.Body) throw new Error("The real CCTV fixture has no body");
    await bodyToFile(fixture.Body, originalPath);
    await run(ffmpegPath, [
      "-y", "-i", originalPath,
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
      "-frames:v", String(TOTAL_FRAMES), "-r", String(FPS),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath,
    ]);
    await run(ffmpegPath, ["-y", "-i", videoPath, "-vf", "select=eq(n\\,50)", "-frames:v", "1", previewPath]);
    const [video, preview] = await Promise.all([readFile(videoPath), readFile(previewPath)]);
    await Promise.all([
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: SOURCE_KEY, Body: video, ContentType: "video/mp4", Metadata: { "test-job": "true", frames: String(TOTAL_FRAMES) } })),
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: PREVIEW_KEY, Body: preview, ContentType: "image/jpeg", Metadata: { "test-job": "true" } })),
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: RESPONSE_KEY, Body: JSON.stringify(responseDocument(), null, 2), ContentType: "application/json", Metadata: { "test-job": "true", frames: String(TOTAL_FRAMES) } })),
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ created: true, job_id: JOB_ID, video_frames: TOTAL_FRAMES, sampled_frames: FRAMES.length, preferred_batch_size: 100, models: 4 }, null, 2));
}

async function remove() {
  const s3 = new S3Client({ region: REGION });
  const keys = [SOURCE_KEY];
  for (const prefix of [`jobs/${JOB_ID}/`, `manual-annotations/${JOB_ID}/`, `prelabels/${JOB_ID}/`, `training/${JOB_ID}/`])
    keys.push(...(await listKeys(s3, prefix)));
  const uniqueKeys = [...new Set(keys)].sort();
  await deleteKeys(s3, uniqueKeys);
  console.log(JSON.stringify({ deleted: true, job_id: JOB_ID, objects: uniqueKeys }, null, 2));
}

const [command, ...flags] = process.argv.slice(2);
if (command === "create") await create(flags.includes("--replace"));
else if (command === "delete") await remove();
else throw new Error("Usage: load-test-105-s3-job.mjs <create [--replace] | delete>");
