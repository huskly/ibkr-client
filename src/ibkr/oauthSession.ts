/**
 * OAuth 1.0a live-session-token handshake and signed requests for the IBKR Web API.
 *
 * Adapted from `ibkr-client` 1.0.4 (https://github.com/art1c0/ibkr-client),
 * Copyright (c) Artico, MIT License. Changes: uses `node:crypto` instead of
 * `node-forge`, global `fetch` instead of `undici`, and drops the WebSocket API.
 */
import { createHmac, privateDecrypt, randomBytes, randomInt, sign, constants } from "node:crypto";
import type { IbkrOauth1Config } from "./oauthConfig.js";

const HOST = "api.ibkr.com";
const API_URL = `https://${HOST}/v1/api/`;
const NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface IbkrOauthRequest {
  path: string;
  method?: string;
  data?: object;
  params?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
}

/** Percent-encode like Python's `urllib.parse.quote_plus`, as IBKR expects. */
function quotePlus(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export function oauthBaseString(
  url: string,
  method: string,
  parts: Record<string, string>,
  prepend = ""
): string {
  const partsString = Object.entries(parts)
    .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return prepend + [method, quotePlus(url), quotePlus(partsString)].join("&");
}

export function rsaSha256Signature(baseString: string, privateKeyPem: string): string {
  return quotePlus(
    sign("sha256", Buffer.from(baseString, "utf8"), privateKeyPem).toString("base64")
  );
}

export function hmacSha256Signature(baseString: string, liveSessionToken: string): string {
  const hmac = createHmac("sha256", Buffer.from(liveSessionToken, "base64"));
  return quotePlus(hmac.update(baseString, "utf8").digest("base64"));
}

/**
 * Decrypt the access token secret with the encryption key (RSA PKCS#1 v1.5).
 * Node only allows this padding with OpenSSL implicit rejection (Node 22+).
 */
export function decryptAccessTokenSecret(secret: string, encryptionKeyPem: string): string {
  return privateDecrypt(
    { key: encryptionKeyPem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(secret, "base64")
  ).toString("hex");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent /= 2n;
  }
  return result;
}

/** Big-endian bytes of `x`, with a leading zero byte when the top bit is set (Java BigInteger style). */
function signedBigEndianBytes(x: bigint): Buffer {
  let hex = x.toString(16);
  if (hex.length % 2 > 0) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  return x.toString(2).length % 8 === 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

export function computeLiveSessionToken(
  dhResponseHex: string,
  dhRandomHex: string,
  dhPrimeHex: string,
  prependHex: string
): string {
  const sharedSecret = modPow(
    BigInt("0x" + dhResponseHex),
    BigInt("0x" + dhRandomHex),
    BigInt("0x" + dhPrimeHex)
  );
  const hmac = createHmac("sha1", signedBigEndianBytes(sharedSecret));
  return hmac.update(Buffer.from(prependHex, "hex")).digest("base64");
}

export function isValidLiveSessionToken(
  liveSessionToken: string,
  consumerKey: string,
  signature: string
): boolean {
  const hmac = createHmac("sha1", Buffer.from(liveSessionToken, "base64"));
  return hmac.update(consumerKey, "utf8").digest("hex") === signature;
}

/** IBKR error bodies are usually `{"error": "..."}`; otherwise keep the raw body. */
function errorMessage(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error !== "") return error;
  } catch {
    // Not JSON.
  }
  return body;
}

function oauthNonce(): string {
  let nonce = "";
  for (let i = 0; i < 16; i++) nonce += NONCE_ALPHABET.charAt(randomInt(NONCE_ALPHABET.length));
  return nonce;
}

/** Low-level IBKR Web API session: OAuth 1.0a signing and untyped JSON requests. */
export class IbkrOauthSession {
  private liveSessionToken?: string;

  constructor(private readonly config: IbkrOauth1Config) {}

  /** Obtain a live session token, then open the brokerage session. */
  async init(compete = true, publish = true): Promise<unknown> {
    this.liveSessionToken = await this.requestLiveSessionToken();
    return this.request({
      path: "iserver/auth/ssodh/init",
      method: "POST",
      data: { publish, compete },
    });
  }

  async request(input: IbkrOauthRequest): Promise<unknown> {
    const { path, data, method = "GET" } = input;
    const baseUrl = API_URL + path;
    const url = new URL(baseUrl);
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value === null || value === undefined) continue;
      url.searchParams.append(key, String(value));
      params[key] = String(value);
    }
    const res = await fetch(url, {
      method,
      body: JSON.stringify(data),
      headers: {
        ...(input.headers ?? this.oauthHeaders(baseUrl, method, this.liveSessionToken, params)),
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Response status ${String(res.status)}: ${errorMessage(body)}`);
    }
    return res.json();
  }

  private async requestLiveSessionToken(): Promise<string> {
    const path = "oauth/live_session_token";
    const random = randomBytes(32).toString("hex");
    const dhChallenge = modPow(
      2n,
      BigInt("0x" + random),
      BigInt("0x" + this.config.dhPrime)
    ).toString(16);
    const prepend = decryptAccessTokenSecret(this.config.accessTokenSecret, this.config.encryption);
    const headers = this.oauthHeaders(
      API_URL + path,
      "POST",
      undefined,
      {},
      { diffie_hellman_challenge: dhChallenge },
      prepend
    );
    const response = (await this.request({ path, method: "POST", headers })) as {
      diffie_hellman_response: string;
      live_session_token_signature: string;
    };
    const token = computeLiveSessionToken(
      response.diffie_hellman_response,
      random,
      this.config.dhPrime,
      prepend
    );
    if (
      !isValidLiveSessionToken(
        token,
        this.config.consumerKey,
        response.live_session_token_signature
      )
    ) {
      throw new Error("Cannot validate live session token");
    }
    return token;
  }

  private oauthHeaders(
    url: string,
    method: string,
    liveSessionToken: string | undefined,
    params: Record<string, string>,
    extraOauthParams: Record<string, string> = {},
    prepend?: string
  ): Record<string, string> {
    const oauthParams: Record<string, string> = {
      oauth_signature_method: liveSessionToken ? "HMAC-SHA256" : "RSA-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: oauthNonce(),
      oauth_token: this.config.accessToken,
      ...extraOauthParams,
    };
    const baseString = oauthBaseString(url, method, { ...oauthParams, ...params }, prepend);
    oauthParams["realm"] = this.config.realm;
    oauthParams["oauth_signature"] = liveSessionToken
      ? hmacSha256Signature(baseString, liveSessionToken)
      : rsaSha256Signature(baseString, this.config.signature);
    const authorization = Object.entries(oauthParams)
      .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
      .map(([key, value]) => `${key}="${value}"`)
      .join(", ");
    return {
      Accept: "*/*",
      "Accept-Encoding": "gzip,deflate",
      Authorization: `OAuth ${authorization}`,
      Connection: "keep-alive",
      Host: HOST,
      "User-Agent": "ClientPortalGW/1",
    };
  }
}
