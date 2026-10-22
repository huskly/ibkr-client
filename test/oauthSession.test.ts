import assert from "node:assert/strict";
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  constants,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IbkrOauthSession,
  computeLiveSessionToken,
  decryptAccessTokenSecret,
  hmacSha256Signature,
  isValidLiveSessionToken,
  oauthBaseString,
  rsaSha256Signature,
} from "../src/ibkr/oauthSession.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

// Vectors were produced by the upstream `ibkr-client` 1.0.4 (node-forge) implementation.
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/oauth/vectors.json", import.meta.url), "utf8")
) as {
  testOnlyPrivateKey: string;
  config: Omit<IbkrOauth1Config, "signature" | "encryption">;
  prepend: string;
  url: string;
  params: Record<string, string>;
  rsaBase: string;
  rsaSignature: string;
  dhRandom: string;
  dhResponse: string;
  liveSessionToken: string;
  lstSignature: string;
  getUrl: string;
  hmacParams: Record<string, string>;
  hmacBase: string;
  hmacSignature: string;
};
const pem = vectors.testOnlyPrivateKey;
const config: IbkrOauth1Config = { ...vectors.config, signature: pem, encryption: pem };

test("OAuth primitives match the upstream ibkr-client output", () => {
  assert.equal(decryptAccessTokenSecret(config.accessTokenSecret, pem), vectors.prepend);
  assert.equal(
    oauthBaseString(vectors.url, "POST", vectors.params, vectors.prepend),
    vectors.rsaBase
  );
  assert.equal(rsaSha256Signature(vectors.rsaBase, pem), vectors.rsaSignature);
  assert.equal(
    computeLiveSessionToken(vectors.dhResponse, vectors.dhRandom, config.dhPrime, vectors.prepend),
    vectors.liveSessionToken
  );
  assert.ok(
    isValidLiveSessionToken(vectors.liveSessionToken, config.consumerKey, vectors.lstSignature)
  );
  assert.ok(!isValidLiveSessionToken(vectors.liveSessionToken, "OTHER", vectors.lstSignature));
  assert.equal(oauthBaseString(vectors.getUrl, "GET", vectors.hmacParams), vectors.hmacBase);
  assert.equal(
    hmacSha256Signature(vectors.hmacBase, vectors.liveSessionToken),
    vectors.hmacSignature
  );
});

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (let e = exponent, b = base % modulus; e > 0n; e /= 2n, b = (b * b) % modulus) {
    if (e % 2n === 1n) result = (result * b) % modulus;
  }
  return result;
}

function parseAuthorization(header: string): Record<string, string> {
  assert.match(header, /^OAuth /);
  return Object.fromEntries(
    header
      .slice("OAuth ".length)
      .split(", ")
      .map((part) => /^(\w+)="(.*)"$/.exec(part)?.slice(1, 3) as [string, string])
  );
}

test("IbkrOauthSession performs the live session token handshake and signs requests", async (t) => {
  const prime = BigInt("0x" + config.dhPrime);
  const serverSecret = 0x1234567890abcdefn;
  const publicKey = createPublicKey(createPrivateKey(pem));
  const accessTokenSecret = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from("another-secret")
  ).toString("base64");
  const prepend = Buffer.from("another-secret").toString("hex");
  let serverToken = "";
  const calls: { url: string; method: string; body: unknown }[] = [];

  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const oauth = parseAuthorization(headers["Authorization"] ?? "");
    calls.push({ url: url.toString(), method: init.method ?? "GET", body: init.body });
    if (url.pathname.endsWith("/oauth/live_session_token")) {
      assert.equal(oauth["oauth_signature_method"], "RSA-SHA256");
      assert.equal(oauth["realm"], config.realm);
      const { oauth_signature: signature, realm: _realm, ...signed } = oauth;
      const base = oauthBaseString(url.toString(), "POST", signed, prepend);
      assert.equal(signature, rsaSha256Signature(base, pem));
      const sharedSecret = modPow(
        BigInt("0x" + (signed["diffie_hellman_challenge"] ?? "")),
        serverSecret,
        prime
      );
      const response = modPow(2n, serverSecret, prime);
      serverToken = computeLiveSessionToken(
        sharedSecret.toString(16),
        "1",
        config.dhPrime,
        prepend
      );
      return Response.json({
        diffie_hellman_response: response.toString(16),
        live_session_token_signature: createHmac("sha1", Buffer.from(serverToken, "base64"))
          .update(config.consumerKey)
          .digest("hex"),
        live_session_token_expiration: 0,
      });
    }
    assert.equal(oauth["oauth_signature_method"], "HMAC-SHA256");
    const { oauth_signature: signature, realm: _realm, ...signed } = oauth;
    const params = Object.fromEntries(url.searchParams);
    const base = oauthBaseString(url.origin + url.pathname, init.method ?? "GET", {
      ...signed,
      ...params,
    });
    assert.equal(signature, hmacSha256Signature(base, serverToken));
    if (url.pathname.endsWith("/missing")) {
      return Response.json({ error: "no such thing" }, { status: 404 });
    }
    return Response.json({ ok: true });
  });

  const session = new IbkrOauthSession({ ...config, accessTokenSecret });
  assert.deepEqual(await session.init(false, true), { ok: true });
  assert.deepEqual(calls[1], {
    url: "https://api.ibkr.com/v1/api/iserver/auth/ssodh/init",
    method: "POST",
    body: JSON.stringify({ publish: true, compete: false }),
  });
  assert.deepEqual(
    await session.request({
      path: "md/snapshot",
      params: { conids: "1,2", fields: "31 84", skip: null },
    }),
    { ok: true }
  );
  assert.equal(calls[2]?.url, "https://api.ibkr.com/v1/api/md/snapshot?conids=1%2C2&fields=31+84");
  await assert.rejects(session.request({ path: "missing" }), {
    message: "Response status 404: no such thing",
  });
});
