import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import ffmpegPath from "ffmpeg-static";

const BUCKET = process.env.S3_BUCKET ?? "icu-solarcam-storage-bacancy-ap-southeast-2";
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const JOB_ID = "dashboard-load-test-20260907";
const SOURCE_KEY = `storage/UNASSIGNED/uploads/${JOB_ID}.mp4`;
const RESPONSE_KEY = `jobs/${JOB_ID}/response.json`;
const PREVIEW_KEY = `jobs/${JOB_ID}/test_preview.jpg`;
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET = join(HERE, "..", "assets", "realistic_warehouse_test_scene.png");
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 20;
const TOTAL_FRAMES = 450;
const FRAMES = Array.from({ length: TOTAL_FRAMES / 15 }, (_, index) => index * 15);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

function instance(frame, x, y, w, h, confidence, attributes = {}) {
  return {
    class_id: 0,
    confidence,
    bbox: { x, y, w, h },
    attributes: { frame_number: frame, ...attributes },
  };
}

function result(modelId, detections, preview = false) {
  return {
    model_id: modelId,
    model_version: "dashboard-complete-test-v3-node",
    status: "SUCCESS",
    processing_time_ms: 1250,
    output_media: {
      annotated_video_s3_key: null,
      annotated_image_s3_key: preview ? PREVIEW_KEY : null,
    },
    detections,
    error: null,
  };
}

function responseDocument() {
  const workers = FRAMES.map((frame) => instance(frame, 116, 160, 112, 300, 0.95));
  const helmets = FRAMES.map((frame) => instance(frame, 120, 160, 56, 45, 0.94));
  const vests = FRAMES.map((frame) => instance(frame, 120, 205, 80, 145, 0.93));
  const phones = FRAMES.map((frame) => instance(frame, frame === 150 ? 694 : 465, frame === 150 ? 300 : 410, 42, 74, 0.87));
  const sleepers = FRAMES.map((frame) => instance(frame, frame === 225 ? 650 : 712, frame === 225 ? 330 : 360, frame === 225 ? 400 : 335, frame === 225 ? 260 : 205, 0.91));
  const cars = FRAMES.filter((frame) => frame !== 315).map((frame) => instance(frame, 650, 58, 420, 165, 0.94, {
    track_id: 42,
    color: { label: "blue" },
    make_model: { make_model: "Blue Test Sedan" },
  }));

  return {
    job_id: JOB_ID,
    status: "SUCCESS",
    test_job: true,
    created_for: "Complete Retrain Studio annotation workflow testing",
    created_at: new Date().toISOString(),
    results: [
      result("ppe-compliance", [
        { label: "person", instances: workers },
        { label: "helmet", instances: helmets },
        { label: "vest", instances: vests },
        { label: "no_helmet", instances: [instance(60, 120, 160, 56, 45, 0.53)] },
      ], true),
      result("phone-usage-detection", [{ label: "in_hand", instances: phones }]),
      result("sleep-detection", [{ label: "sleeping", instances: sleepers }]),
      result("mmc-vehicle-classification", [
        { label: "car", instances: cars },
        { label: "truck", instances: [instance(315, 650, 58, 420, 165, 0.62, {
          track_id: 42,
          color: { label: "blue" },
          make_model: { make_model: "Blue Test Sedan" },
        })] },
      ]),
      result("videomae-aggression", [{
        label: "aggression",
        confidence: 0.74,
        first_seen_ms: 0,
        last_seen_ms: 22450,
        best_frame_number: 390,
      }]),
    ],
    error: null,
    response_s3_key: RESPONSE_KEY,
  };
}

async function listKeys(s3, prefix) {
  const keys = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    keys.push(...(page.Contents ?? []).flatMap((row) => row.Key ? [row.Key] : []));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteKeys(s3, keys) {
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000);
    if (batch.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
    }
  }
}

async function exists(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    const code = error?.name ?? error?.Code ?? error?.$metadata?.httpStatusCode;
    if (["NotFound", "NoSuchKey", 404].includes(code)) return false;
    throw error;
  }
}

async function create(replace) {
  const s3 = new S3Client({ region: REGION });
  if (await exists(s3, RESPONSE_KEY)) {
    if (!replace) throw new Error(`Test job already exists: ${JOB_ID}. Run npm run test-job:replace.`);
    await deleteKeys(s3, await listKeys(s3, `manual-annotations/${JOB_ID}/`));
  }

  const folder = await mkdtemp(join(tmpdir(), "retrain-test-job-"));
  try {
    const videoPath = join(folder, `${JOB_ID}.mp4`);
    const previewPath = join(folder, "preview.jpg");
    await run(ffmpegPath, [
      "-y", "-loop", "1", "-framerate", String(FPS), "-i", ASSET,
      "-t", String(TOTAL_FRAMES / FPS), "-vf", `scale=${WIDTH}:${HEIGHT}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), videoPath,
    ]);
    await run(ffmpegPath, ["-y", "-i", videoPath, "-frames:v", "1", previewPath]);
    const [video, preview] = await Promise.all([readFile(videoPath), readFile(previewPath)]);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: SOURCE_KEY, Body: video, ContentType: "video/mp4",
      Metadata: { "test-job": "true", fixture: "complete-v3-node" },
    }));
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: PREVIEW_KEY, Body: preview, ContentType: "image/jpeg",
      Metadata: { "test-job": "true" },
    }));
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: RESPONSE_KEY,
      Body: JSON.stringify(responseDocument(), null, 2), ContentType: "application/json",
      Metadata: { "test-job": "true", fixture: "complete-v3-node" },
    }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ created: true, job_id: JOB_ID, sampled_frames: FRAMES.length, models: 5 }, null, 2));
}

async function remove() {
  const s3 = new S3Client({ region: REGION });
  const keys = [SOURCE_KEY];
  for (const prefix of [`jobs/${JOB_ID}/`, `manual-annotations/${JOB_ID}/`, `prelabels/${JOB_ID}/`, `training/${JOB_ID}/`]) {
    keys.push(...await listKeys(s3, prefix));
  }
  const uniqueKeys = [...new Set(keys)].sort();
  await deleteKeys(s3, uniqueKeys);
  console.log(JSON.stringify({ deleted: true, job_id: JOB_ID, objects: uniqueKeys }, null, 2));
}

const [command, ...flags] = process.argv.slice(2);
if (command === "create") await create(flags.includes("--replace"));
else if (command === "delete") await remove();
else throw new Error("Usage: dummy-s3-job.mjs <create [--replace] | delete>");
