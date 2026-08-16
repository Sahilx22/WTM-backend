import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env.js'

const VIEW_URL_EXPIRY_SECONDS = 15 * 60

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  // Supabase's S3-compatible endpoint expects path-style requests
  // (https://<host>/<bucket>/<key>) rather than virtual-hosted-style.
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  }
})

export async function uploadObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  )
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  } catch {
    // Object may already be gone — nothing to do.
  }
}

export async function copyObject(sourceKey: string, destKey: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: env.S3_BUCKET,
      CopySource: `${env.S3_BUCKET}/${sourceKey}`,
      Key: destKey
    })
  )
}

// Short-lived, browser-openable URL for a private object. `inline` disposition
// tells the browser to render the file (image/video/PDF/etc) instead of
// downloading it, wherever the browser is capable of that.
export async function getSignedViewUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'inline'
  })
  return getSignedUrl(s3, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS })
}
