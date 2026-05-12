/**
 * Phase 4.2c — AWS Signature v4 signer.
 *
 * Home-rolled SigV4 (invariant 10) so the broker can call STS
 * GetCallerIdentity to verify a paired AWS access-key / secret-access-key
 * without taking on the ~6 MB `@aws-sdk/client-sts` dependency.
 *
 * Only the slice of the SigV4 spec we actually need is implemented:
 *   - POST to a single endpoint (sts.amazonaws.com).
 *   - Form-urlencoded body, no querystring.
 *   - Path always "/".
 *
 * Reference: AWS docs, "Authenticating Requests (AWS Signature Version 4)".
 *
 * SECURITY: the secret access key is consumed only inside the HMAC chain
 * (`deriveSigningKey`); it never appears in the canonical request, the
 * string-to-sign, the Authorization header, or the returned headers.
 * The signing key is a Buffer that goes out of scope after this function
 * returns. (See invariant 7 in decision_phase_4_2_c_aws_verify.md.)
 *
 * NOTE on Host header: AWS requires `host` in the canonical headers for
 * signing, but Node's fetch sets the actual `Host:` header from the URL
 * automatically. We include `host` in the signed canonical headers list
 * and rely on fetch to send a matching `Host:` header on the wire. We do
 * NOT include `Host` in the returned `headers` object — manually setting
 * it can collide with fetch's automatic handling.
 */

import { createHash, createHmac } from "node:crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

/**
 * Derive the SigV4 signing key.
 *
 *   kSecret  = "AWS4" + secretAccessKey
 *   kDate    = HMAC(kSecret,  yyyymmdd)
 *   kRegion  = HMAC(kDate,    region)
 *   kService = HMAC(kRegion,  service)
 *   kSigning = HMAC(kService, "aws4_request")
 *
 * The chain narrows the credential to a (date, region, service) scope —
 * leaking kSigning is far less dangerous than leaking the secret key,
 * but neither should ever leave this stack frame.
 */
function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kSecret = "AWS4" + secretAccessKey;
  const kDate = hmac(kSecret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * ISO 8601 basic format: "yyyymmddThhmmssZ". Drops the dashes, colons,
 * and millisecond fragment from `Date#toISOString()`.
 */
export function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SigV4Options {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
  readonly host: string;
  readonly body: string;
  readonly contentType: string;
  /**
   * Override "now" for deterministic tests. The implementation uses ms-zero
   * timestamps (toISOString strips millis after the regex above), so passing
   * a Date created from a fixed ISO string makes signatures reproducible.
   */
  readonly date?: Date;
}

export interface SigV4SignedRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Sign a POST request body for AWS SigV4. Returns the URL, method, headers,
 * and body ready to pass to `fetch`.
 *
 * Limitations (intentional, scoped to STS GetCallerIdentity):
 *   - Path is always "/", no querystring.
 *   - Body is signed in-place (no streaming hash).
 *   - Signed headers are exactly: content-type, host, x-amz-content-sha256, x-amz-date.
 */
export function signStsPostRequest(opts: SigV4Options): SigV4SignedRequest {
  const date = opts.date ?? new Date();
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8); // yyyymmdd

  const canonicalUri = "/";
  const canonicalQuery = "";
  const payloadHash = sha256Hex(opts.body);

  // Canonical headers: lowercase keys, trimmed values, sorted, newline-terminated each.
  const headersForSig: Record<string, string> = {
    "content-type": opts.contentType,
    host: opts.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedKeys = Object.keys(headersForSig).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${headersForSig[k]}\n`)
    .join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    opts.secretAccessKey,
    dateStamp,
    opts.region,
    opts.service,
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    url: `https://${opts.host}${canonicalUri}`,
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": opts.contentType,
      // Host intentionally NOT set here — fetch derives it from the URL.
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": amzDate,
    },
    body: opts.body,
  };
}
