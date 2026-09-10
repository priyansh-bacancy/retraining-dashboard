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
const JOB_ID = "race-lounge-110-frame-test-20260909";
const SOURCE_KEY = `storage/UNASSIGNED/uploads/${JOB_ID}.mp4`;
const RESPONSE_KEY = `jobs/${JOB_ID}/response.json`;
const PREVIEW_KEY = `jobs/${JOB_ID}/preview.jpg`;
const FPS = 20;
const TOTAL_FRAMES = 110;
const FRAMES = Array.from({ length: TOTAL_FRAMES }, (_, frame) => frame);
const HERE = dirname(fileURLToPath(import.meta.url));
const KEYFRAMES = [1, 2, 3, 4].map((number) =>
  join(HERE, "..", "assets", `race-review-keyframe-${number}.png`),
);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(
        new Error(
          `FFmpeg failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`,
        ),
      );
    });
  });
}

function lerp(start, end, frame) {
  return Math.round(start + ((end - start) * frame) / (TOTAL_FRAMES - 1));
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
    model_version: "race-lounge-motion-test-v1",
    status: "SUCCESS",
    processing_time_ms: 1380,
    output_media: {
      annotated_video_s3_key: null,
      annotated_image_s3_key: preview ? PREVIEW_KEY : null,
    },
    detections,
    error: null,
  };
}

function responseDocument() {
  const carInstances = FRAMES.map((frame) =>
    instance(frame, lerp(180, 1090, frame), 38, 205, 78, 0.94, {
      track_id: 77,
      color: { label: "blue" },
      make_model: { make_model: "Track Race Car" },
    }),
  );
  const phoneInstances = FRAMES.map((frame) =>
    instance(frame, 170 + Math.round(4 * Math.sin(frame / 8)), 455, 42, 74, 0.91),
  );
  const sleepingInstances = FRAMES.map((frame) =>
    instance(frame, 540, 220 + Math.round(5 * Math.sin(frame / 12)), 185, 210, 0.89),
  );
  const spectatorInstances = FRAMES.filter((frame) => frame % 2 === 0).map((frame) =>
    instance(frame, 675, 65, 92, 280, 0.92),
  );

  return {
    job_id: JOB_ID,
    status: "SUCCESS",
    test_job: true,
    created_for: "Realistic 110-frame multi-model annotation and 100-frame browser-load test",
    created_at: new Date().toISOString(),
    preferred_batch_size: 100,
    sample_interval: 1,
    sampled_frames: FRAMES,
    results: [
      result(
        "ppe-compliance",
        [
          { label: "person", instances: spectatorInstances },
          {
            label: "no_helmet",
            instances: spectatorInstances.map((row) =>
              instance(row.attributes.frame_number, 692, 60, 48, 52, 0.86),
            ),
          },
        ],
        true,
      ),
      result("phone-usage-detection", [
        { label: "in_hand", instances: phoneInstances },
      ]),
      result("sleep-detection", [
        { label: "sleeping", instances: sleepingInstances },
      ]),
      result("mmc-vehicle-classification", [
        { label: "car", instances: carInstances },
      ]),
      result("videomae-aggression", [
        {
          label: "aggression",
          confidence: 0.9,
          first_seen_ms: 500,
          last_seen_ms: 5200,
          best_frame_number: 72,
        },
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
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(...(page.Contents ?? []).flatMap((row) => (row.Key ? [row.Key] : [])));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteKeys(s3, keys) {
  for (let start = 0; start < keys.length; start += 1000) {
    const objects = keys.slice(start, start + 1000).map((Key) => ({ Key }));
    if (objects.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
  }
}

async function exists(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (
      ["NotFound", "NoSuchKey", 404].includes(
        error?.name ?? error?.Code ?? error?.$metadata?.httpStatusCode,
      )
    )
      return false;
    throw error;
  }
}

async function create(replace) {
  const s3 = new S3Client({ region: REGION });
  if ((await exists(s3, RESPONSE_KEY)) && !replace)
    throw new Error(
      `Test job already exists: ${JOB_ID}. Run npm run race-test-job:replace.`,
    );
  if (replace)
    await deleteKeys(s3, await listKeys(s3, `manual-annotations/${JOB_ID}/`));

  const folder = await mkdtemp(join(tmpdir(), "race-lounge-test-"));
  try {
    const videoPath = join(folder, `${JOB_ID}.mp4`);
    const previewPath = join(folder, "preview.jpg");
    const inputArgs = KEYFRAMES.flatMap((path) => ["-loop", "1", "-t", "1.75", "-i", path]);
    const filter = [
      "[0:v]scale=1280:720,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v0]",
      "[1:v]scale=1280:720,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v1]",
      "[2:v]scale=1280:720,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v2]",
      "[3:v]scale=1280:720,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v3]",
      "[v0][v1]xfade=transition=fade:duration=0.5:offset=1.25[x1]",
      "[x1][v2]xfade=transition=fade:duration=0.5:offset=2.5[x2]",
      `[x2][v3]xfade=transition=fade:duration=0.5:offset=3.75,fps=${FPS}[out]`,
    ].join(";");
    await run(ffmpegPath, [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-frames:v",
      String(TOTAL_FRAMES),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ]);
    await run(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-vf",
      "select=eq(n\\,55)",
      "-frames:v",
      "1",
      previewPath,
    ]);
    const [video, preview] = await Promise.all([
      readFile(videoPath),
      readFile(previewPath),
    ]);
    await Promise.all([
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: SOURCE_KEY,
          Body: video,
          ContentType: "video/mp4",
          Metadata: { "test-job": "true", frames: String(TOTAL_FRAMES) },
        }),
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: PREVIEW_KEY,
          Body: preview,
          ContentType: "image/jpeg",
          Metadata: { "test-job": "true" },
        }),
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: RESPONSE_KEY,
          Body: JSON.stringify(responseDocument(), null, 2),
          ContentType: "application/json",
          Metadata: { "test-job": "true", frames: String(TOTAL_FRAMES) },
        }),
      ),
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      {
        created: true,
        job_id: JOB_ID,
        video_frames: TOTAL_FRAMES,
        sampled_frames: FRAMES.length,
        preferred_batch_size: 100,
        models: 5,
      },
      null,
      2,
    ),
  );
}

async function remove() {
  const s3 = new S3Client({ region: REGION });
  const keys = [SOURCE_KEY];
  for (const prefix of [
    `jobs/${JOB_ID}/`,
    `manual-annotations/${JOB_ID}/`,
    `prelabels/${JOB_ID}/`,
    `training/${JOB_ID}/`,
  ])
    keys.push(...(await listKeys(s3, prefix)));
  const uniqueKeys = [...new Set(keys)].sort();
  await deleteKeys(s3, uniqueKeys);
  console.log(
    JSON.stringify({ deleted: true, job_id: JOB_ID, objects: uniqueKeys }, null, 2),
  );
}

const [command, ...flags] = process.argv.slice(2);
if (command === "create") await create(flags.includes("--replace"));
else if (command === "delete") await remove();
else throw new Error("Usage: race-lounge-s3-job.mjs <create [--replace] | delete>");
