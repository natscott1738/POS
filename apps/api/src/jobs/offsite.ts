import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { env } from '../config/env.js';

/**
 * Uploads a backup to S3-compatible storage.
 *
 * Implemented with raw SigV4 rather than the AWS SDK: it is ~80 lines, works
 * against any S3-compatible endpoint (AWS, Backblaze B2, Wasabi, MinIO, DigitalOcean),
 * and keeps a very large dependency out of a system that handles payments.
 *
 * The file is already encrypted before it reaches here, so the storage provider
 * never holds readable customer data.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

export interface OffsiteResult {
  uploaded: boolean;
  key?: string;
  etag?: string;
  error?: string;
}

export function offsiteConfigured(): boolean {
  return Boolean(
    env.BACKUP_S3_BUCKET && env.BACKUP_S3_ACCESS_KEY_ID && env.BACKUP_S3_SECRET_ACCESS_KEY,
  );
}

/**
 * Uploads one file. Never throws: a failed off-site copy must be reported and
 * retried, not allowed to fail the backup that already succeeded locally.
 */
export async function uploadBackup(localPath: string): Promise<OffsiteResult> {
  if (!offsiteConfigured()) return { uploaded: false, error: 'off-site storage is not configured' };

  const bucket = env.BACKUP_S3_BUCKET as string;
  const region = env.BACKUP_S3_REGION;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID as string;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY as string;

  try {
    const body = await readFile(localPath);
    const filename = basename(localPath);
    // Date-prefixed so the bucket stays browsable as it fills up.
    const key = `${env.BACKUP_S3_PREFIX}${new Date().toISOString().slice(0, 10)}/${filename}`.replace(/^\/+/, '');

    const endpoint = env.BACKUP_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
    const url = new URL(endpoint);
    // Path-style addressing works everywhere; virtual-host style does not.
    const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    url.pathname = canonicalUri;

    const now = new Date();
    const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body);

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      // Server-side encryption as well as our own, where the provider offers it.
      'x-amz-server-side-encryption': 'AES256',
    };

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join('');

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, 's3'))
      .update(stringToSign)
      .digest('hex');

    const authorization = `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers: { ...headers, Authorization: authorization, 'Content-Length': String(body.length) },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { uploaded: false, error: `storage returned ${response.status}: ${detail.slice(0, 200)}` };
    }

    return { uploaded: true, key, etag: response.headers.get('etag') ?? undefined };
  } catch (err) {
    return { uploaded: false, error: err instanceof Error ? err.message : 'upload failed' };
  }
}
