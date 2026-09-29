import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  MANUAL_ROOT,
  migrationTarget,
  modelLabelKey,
  modelManifestKey,
  modelMetadataKey,
  parseLegacyAnnotationKey,
  sharedImageKey,
} from "../annotation-storage.mjs";

const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const BUCKET =
  process.env.RETRAINING_BUCKET ??
  "icu-solarcam-storage-bacancy-ap-southeast-2";
const APPLY = process.argv.includes("--apply");

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

async function headObject(s3, key) {
  try {
    return await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
  } catch (error) {
    if (
      error?.name === "NotFound" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

async function exists(s3, key) {
  return Boolean(await headObject(s3, key));
}

function copySource(key) {
  return encodeURIComponent(`${BUCKET}/${key}`).replaceAll("%2F", "/");
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
  const response = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return JSON.parse((await bodyBytes(response.Body)).toString("utf8"));
}

function reviewStatus(metadata) {
  const hasAnnotations = Array.isArray(metadata?.annotations) &&
    metadata.annotations.length > 0;
  const hasSegments = Array.isArray(metadata?.segments) &&
    metadata.segments.length > 0;
  const hasPeople = Number.isInteger(metadata?.people_count) &&
    metadata.people_count > 0;
  return hasAnnotations || hasSegments || hasPeople
    ? "corrected"
    : "reviewed_empty";
}

async function buildManifests(s3, rows) {
  const manifests = new Map();
  const metadataByFrame = new Map();
  const nonEmptyLabels = new Set();
  for (const row of rows) {
    const parsed = parseLegacyAnnotationKey(row.Key);
    if (parsed?.kind === "labels" && parsed.modelId && Number(row.Size) > 0) {
      nonEmptyLabels.add(
        `${parsed.modelId}\0${parsed.jobId}\0${parsed.frameNumber}`,
      );
    }
    if (parsed?.kind !== "metadata" || !parsed.modelId) continue;
    metadataByFrame.set(
      `${parsed.modelId}\0${parsed.jobId}\0${parsed.frameNumber}`,
      await readJson(s3, row.Key),
    );
  }
  for (const row of rows) {
    const parsed = parseLegacyAnnotationKey(row.Key);
    if (!parsed?.modelId) continue;
    const mapKey = `${parsed.modelId}\0${parsed.jobId}`;
    const manifest = manifests.get(mapKey) ?? {
      schema_version: 2,
      model_id: parsed.modelId,
      job_id: parsed.jobId,
      migrated_at: new Date().toISOString(),
      frames: {},
    };
    const frameKey = String(parsed.frameNumber);
    const recordKey = `${parsed.modelId}\0${parsed.jobId}\0${parsed.frameNumber}`;
    const metadata = metadataByFrame.get(recordKey);
    manifest.frames[frameKey] ??= {
      frame_number: parsed.frameNumber,
      review_status:
        reviewStatus(metadata) === "corrected" || nonEmptyLabels.has(recordKey)
          ? "corrected"
          : "reviewed_empty",
      image_key: sharedImageKey(parsed.jobId, parsed.frameNumber),
      label_key: modelLabelKey(
        parsed.modelId,
        parsed.jobId,
        parsed.frameNumber,
      ),
      metadata_key: modelMetadataKey(
        parsed.modelId,
        parsed.jobId,
        parsed.frameNumber,
      ),
    };
    manifests.set(mapKey, manifest);
  }
  return { manifests, metadataByFrame };
}

async function main() {
  const s3 = new S3Client({ region: REGION });
  const rows = await listKeys(s3, `${MANUAL_ROOT}/`);
  const migrations = rows.flatMap((row) => {
    const parsed = parseLegacyAnnotationKey(row.Key);
    const target = migrationTarget(row.Key);
    return target ? [{ source: row.Key, target, parsed }] : [];
  });
  const { manifests, metadataByFrame } = await buildManifests(s3, rows);
  const modelFrames = {};
  for (const manifest of manifests.values()) {
    modelFrames[manifest.model_id] =
      (modelFrames[manifest.model_id] ?? 0) +
      Object.keys(manifest.frames).length;
  }
  const summary = {
    mode: APPLY ? "apply" : "dry-run",
    bucket: BUCKET,
    region: REGION,
    legacy_objects: migrations.length,
    manifests: manifests.size,
    copied: 0,
    already_present: 0,
    verified: 0,
    model_frames: modelFrames,
  };

  for (const item of migrations) {
    const targetPresent = await exists(s3, item.target);
    if (targetPresent) {
      if (item.parsed.kind !== "metadata") {
        summary.already_present += 1;
        continue;
      }
      const existingMetadata = await readJson(s3, item.target);
      if (existingMetadata.schema_version === 2) {
        summary.already_present += 1;
        continue;
      }
    }
    if (!APPLY) continue;
    if (item.parsed.kind === "metadata") {
      const mapKey = `${item.parsed.modelId}\0${item.parsed.jobId}\0${item.parsed.frameNumber}`;
      const legacy = metadataByFrame.get(mapKey) ?? {};
      const migrated = {
        ...legacy,
        version: 2,
        schema_version: 2,
        job_id: item.parsed.jobId,
        model_id: item.parsed.modelId,
        frame_number: item.parsed.frameNumber,
        image_key: sharedImageKey(
          item.parsed.jobId,
          item.parsed.frameNumber,
        ),
        review_status: reviewStatus(legacy),
        migrated_from: item.source,
        migrated_at: new Date().toISOString(),
      };
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: item.target,
          Body: JSON.stringify(migrated),
          ContentType: "application/json",
        }),
      );
    } else {
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: copySource(item.source),
          Key: item.target,
          MetadataDirective: "COPY",
        }),
      );
    }
    summary.copied += 1;
  }

  if (APPLY) {
    for (const manifest of manifests.values()) {
      const key = modelManifestKey(manifest.model_id, manifest.job_id);
      const existing = (await exists(s3, key)) ? await readJson(s3, key) : {};
      const merged = {
        ...manifest,
        ...existing,
        schema_version: 2,
        model_id: manifest.model_id,
        job_id: manifest.job_id,
        frames: {
          ...manifest.frames,
          ...(existing.frames && typeof existing.frames === "object"
            ? existing.frames
            : {}),
        },
      };
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: JSON.stringify(merged),
          ContentType: "application/json",
        }),
      );
    }
    for (const item of migrations) {
      const [sourceHead, targetHead] = await Promise.all([
        headObject(s3, item.source),
        headObject(s3, item.target),
      ]);
      if (!sourceHead || !targetHead) {
        throw new Error(`Migration verification failed for ${item.target}`);
      }
      if (item.parsed.kind === "metadata") {
        const metadata = await readJson(s3, item.target);
        if (
          metadata.schema_version !== 2 ||
          metadata.job_id !== item.parsed.jobId ||
          metadata.model_id !== item.parsed.modelId ||
          metadata.frame_number !== item.parsed.frameNumber ||
          metadata.image_key !==
            sharedImageKey(item.parsed.jobId, item.parsed.frameNumber)
        ) {
          throw new Error(`Metadata verification failed for ${item.target}`);
        }
      } else if (sourceHead.ContentLength !== targetHead.ContentLength) {
        throw new Error(`Object size verification failed for ${item.target}`);
      }
      summary.verified += 1;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply after reviewing this summary.");
  }
}

main().catch((error) => {
  console.error(`${error?.name ?? "Error"}: ${error?.message ?? "Migration failed"}`);
  process.exitCode = 1;
});
