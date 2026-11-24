// Sign-in with SWITCH edu-ID (worker/auth.ts, plans/PLAN_ACCOUNTS.md section 6.4), against a fake SWITCH: keys made
// here, the discovery document, JWKS, token endpoint and userinfo stubbed through `fetch`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../worker/index";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  affiliations,
  authConfig,
  b64url,
  callback,
  nameKey,
  readLogin,
  requireUser,
  safeReturn,
  sha256Hex,
  uniOf,
} from "../worker/auth";
import { FakeD1, FakeKV } from "./helpers";

const ISSUER = "https://login.eduid.ch/";
const CLIENT = "frooms_ch_frooms";
const SECRET = "s3cret:+/ä";
const KEY = "k".repeat(43);
const PREVIEW = "accounts-preview-fruum.fruum.workers.dev";
const IDP = "https://login.eduid.ch/idp/profile/oidc";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${IDP}/authorize`,
  token_endpoint: `${IDP}/token`,
  userinfo_endpoint: `${IDP}/userinfo`,
  jwks_uri: `${IDP}/keyset`,
};
const enc = new TextEncoder();
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

type Alg = "RS256" | "ES256";
interface Signer {
  kid: string;
  alg: Alg;
  key: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

async function signer(kid: string, alg: Alg): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, alg, key: pair.privateKey, jwk: { ...pub, kid, use: "sig", alg, key_ops: undefined, ext: undefined } };
}

async function jwt(header: Record<string, unknown>, payload: Record<string, unknown>, s: Signer): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const params = s.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  return `${h}.${p}.${b64url(await crypto.subtle.sign(params, s.key, enc.encode(`${h}.${p}`)))}`;
}

let rsa: Signer;
let ec: Signer;
let stranger: Signer; // a key SWITCH's JWKS doesn't list (at first)

/** The fake SWITCH: what it serves, and every request it got. */
let served: { keys: JsonWebKey[]; userinfo: Record<string, unknown>; tokenStatus: number };
let calls: { url: string; init?: RequestInit }[];
let makeToken: (nonce: string) => Promise<string>;
let lastNonce = "";

const now = () => Math.floor(Date.now() / 1000);
const claims = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: "sub-raffaele",
  exp: now() + 3600,
  iat: now(),
  nonce,
  given_name: "Raffaele",
  family_name: "Wyss",
  email: "R.Example@ETHZ.ch",
  eduPersonScopedAffiliation: ["member@ethz.ch", "student@ethz.ch"],
  ...extra,
});
const token = (extra: Record<string, unknown> = {}, s: () => Signer = () => rsa) => (nonce: string) =>
  jwt({ alg: s().alg, kid: s().kid, typ: "JWT" }, claims(nonce, extra), s());

let db: FakeD1;
let dev: FakeD1;
let kv: FakeKV;

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: new FakeD1().asD1(),
    ROOMS: kv.asKV(),
    ACCOUNTS: db.asD1(),
    ACCOUNTS_DEV: dev.asD1(),
    EDUID_ISSUER: ISSUER,
    EDUID_CLIENT_ID: CLIENT,
    EDUID_CLIENT_SECRET: SECRET,
    SESSION_KEY: KEY,
    PREVIEW_AUTH_HOST: PREVIEW,
    ...overrides,
  };
}

const call = (url: string, init: RequestInit = {}, e = env()) => worker.fetch(new Request(url, init), e, ctx);

function cookieOf(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(";")[0];
  return null;
}

/** A full round: /auth/login, then SWITCH sends the person back to /auth/callback with a code. */
async function signIn(opts: { host?: string; ret?: string; make?: (nonce: string) => Promise<string>; e?: Env } = {}) {
  const host = opts.host ?? "frooms.ch";
  const e = opts.e ?? env();
  const login = await call(`https://${host}/auth/login?return=${encodeURIComponent(opts.ret ?? "/?tab=study")}`, {}, e);
  const to = new URL(login.headers.get("Location")!);
  const loginCookie = cookieOf(login, LOGIN_COOKIE)!;
  const state = (await readLogin(loginCookie, KEY))!;
  lastNonce = state.n;
  makeToken = opts.make ?? token();
  const back = await call(
    `https://${host}/auth/callback?code=c0de&state=${to.searchParams.get("state")}`,
    { headers: { Cookie: `${LOGIN_COOKIE}=${loginCookie}` } },
    e,
  );
  return { login, to, state, loginCookie, back, location: back.headers.get("Location") ?? "", session: cookieOf(back, SESSION_COOKIE) };
}

const me = (session: string | null, host = "frooms.ch", e = env()) =>
  call(`https://${host}/api/me`, { headers: session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {} }, e);
const users = (d = db) => d.rows("SELECT * FROM users");
const tokenCalls = () => calls.filter((c) => c.url === DISCOVERY.token_endpoint);
const keyCalls = () => calls.filter((c) => c.url === DISCOVERY.jwks_uri);

beforeEach(async () => {
  rsa ??= await signer("rsa-1", "RS256");
  ec ??= await signer("ec-1", "ES256");
  stranger ??= await signer("rsa-2", "RS256");
  db = new FakeD1("migrations-accounts");
  dev = new FakeD1("migrations-accounts");
  kv = new FakeKV();
  calls = [];
  served = { keys: [rsa.jwk, ec.jwk], userinfo: {}, tokenStatus: 200 };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url === "https://login.eduid.ch/.well-known/openid-configuration") return Response.json(DISCOVERY);
    if (url === DISCOVERY.jwks_uri) return Response.json({ keys: served.keys });
    if (url === DISCOVERY.token_endpoint) {
      if (served.tokenStatus !== 200) return new Response("invalid_grant", { status: served.tokenStatus });
      return Response.json({ id_token: await makeToken(lastNonce), access_token: "access-1", token_type: "Bearer" });
    }
    if (url === DISCOVERY.userinfo_endpoint) return Response.json(served.userinfo);
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a full sign-in", () => {
  it("sends the person to SWITCH with PKCE, state and nonce in a signed 10-minute cookie", async () => {
    const { login, to, state } = await signIn();
    expect(login.status).toBe(302);
    expect(to.origin + to.pathname).toBe(DISCOVERY.authorization_endpoint);
    const p = Object.fromEntries(to.searchParams);
    expect(p).toMatchObject({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "https://frooms.ch/auth/callback",
      scope: "openid https://eduid.ch/scope/userinfo.read",
      state: state.s,
      nonce: state.n,
      code_challenge_method: "S256",
    });
    expect(p.code_challenge).toBe(b64url(await crypto.subtle.digest("SHA-256", enc.encode(state.v))));
    expect(state.v.length).toBeGreaterThanOrEqual(43);
    const set = login.headers.getSetCookie().find((c) => c.startsWith(LOGIN_COOKIE))!;
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) expect(set).toContain(attr);
    expect(state.r).toBe("/?tab=study");
  });

  it("creates the user and a session, and sends a new person to the profile step", async () => {
    const { back, location, session } = await signIn();
    expect(back.status).toBe(302);
    expect(location).toBe("/?tab=study#welcome");
    expect(back.headers.getSetCookie().find((c) => c.startsWith(LOGIN_COOKIE))).toContain("Max-Age=0");
    const set = back.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!;
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`]) expect(set).toContain(attr);

    const [u] = users();
    expect(u).toMatchObject({ id: "sub-raffaele", username: null, first_name: "Raffaele", last_name: "Wyss", name_key: "raffaele wyss", uni: "eth", bg: null });
    expect(u.email_hash).toBe(await sha256Hex("r.example@ethz.ch"));
    const [s] = db.rows("SELECT * FROM sessions");
    expect(s.token_hash).toBe(await sha256Hex(session!));
    expect(s.expires_at - s.created_at).toBe(SESSION_TTL_MS);

    const res = await me(session);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ first_name: "Raffaele", username: null, uni: "eth", profile_needed: true });
  });

  it("a second sign-in refreshes the names and keeps username and colours", async () => {
    await signIn();
    db.db.prepare("UPDATE users SET username = 'raffi', bg = '#1f3a5f', fg = '#ffffff'").run();
    const { location } = await signIn({ make: token({ given_name: "Raffaële", family_name: "von Wyss", email: undefined }) });
    expect(location).toBe("/?tab=study");
    const [u] = users();
    expect(u).toMatchObject({ username: "raffi", bg: "#1f3a5f", fg: "#ffffff", first_name: "Raffaële", last_name: "von Wyss", name_key: "raffaele von wyss", email_hash: null });
    expect(db.rows("SELECT * FROM sessions")).toHaveLength(2); // two devices, two sessions
  });

  it("counts every sign-in and, once, the account it creates (usage counters); a refused one counts nothing", async () => {
    await signIn();
    await signIn();
    expect((await signIn({ make: token({ sub: "sub-alum", eduPersonScopedAffiliation: "alum@uzh.ch" }) })).location).toContain("signin-error=not_member");
    const days = Object.values(db.stats());
    expect(days).toHaveLength(1);
    expect(days[0]).toEqual({ sign_in: 2, account_created: 1 });
    expect(dev.stats()).toEqual({});
  });

  it("signs in while the counters' table is missing", async () => {
    db.db.exec("DROP TABLE stats_days");
    const { location, session } = await signIn();
    expect(location).toBe("/?tab=study#welcome");
    expect(users()).toHaveLength(1);
    expect((await me(session)).status).toBe(200);
  });

  it("asks SWITCH's token endpoint with HTTP Basic (URL-encoded id and secret), the same redirect_uri and the verifier", async () => {
    const { state } = await signIn();
    const [t] = tokenCalls();
    const headers = new Headers(t.init!.headers);
    expect(t.init!.method).toBe("POST");
    expect(headers.get("Authorization")).toBe(`Basic ${btoa(`${CLIENT}:s3cret%3A%2B%2F%C3%A4`)}`);
    const body = new URLSearchParams(String(t.init!.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: "https://frooms.ch/auth/callback",
      code_verifier: state.v,
    });
  });

  it("accepts ES256 tokens", async () => {
    const { location } = await signIn({ make: token({}, () => ec) });
    expect(location).toBe("/?tab=study#welcome");
  });

  it("reads claims missing from the ID token from userinfo", async () => {
    served.userinfo = { sub: "sub-raffaele", eduPersonScopedAffiliation: "staff@uzh.ch" };
    const { location } = await signIn({ make: token({ eduPersonScopedAffiliation: undefined }) });
    expect(location).toBe("/?tab=study#welcome");
    expect(users()[0].uni).toBe("uzh");
    const info = calls.find((c) => c.url === DISCOVERY.userinfo_endpoint)!;
    expect(new Headers(info.init!.headers).get("Authorization")).toBe("Bearer access-1");
  });

  it("doesn't ask userinfo when the ID token has everything", async () => {
    await signIn();
    expect(calls.some((c) => c.url === DISCOVERY.userinfo_endpoint)).toBe(false);
  });

  it("caches the discovery document and keys in KV", async () => {
    await signIn();
    await signIn();
    expect(calls.filter((c) => c.url.endsWith("openid-configuration"))).toHaveLength(1);
    expect(keyCalls()).toHaveLength(1);
  });
});

describe("refused sign-ins", () => {
  const refused = async (make: (nonce: string) => Promise<string>, code = "failed") => {
    const { location, session } = await signIn({ make });
    expect(location).toBe(`/?tab=study#signin-error=${code}`);
    expect(session).toBeNull();
    expect(users()).toHaveLength(0);
    expect(db.rows("SELECT * FROM sessions")).toHaveLength(0);
  };

  it("a wrong nonce", () => refused(() => token()("another-nonce")));
  it("a wrong audience", () => refused(token({ aud: "someone_else" })));
  it("an azp that isn't frooms", () => refused(token({ aud: [CLIENT, "other"], azp: "other" })));
  it("a wrong issuer", () => refused(token({ iss: "https://login.test.eduid.ch/" })));
  it("the issuer without its trailing slash", () => refused(token({ iss: "https://login.eduid.ch" })));
  it("an expired token", () => refused(token({ exp: now() - 10 })));
  it("a token issued in the future", () => refused(token({ iat: now() + 600 })));
  it("a token without sub", () => refused(token({ sub: undefined })));

  it("a bad signature", () =>
    refused(async (nonce) => {
      const [h, , sig] = (await token()(nonce)).split(".");
      return `${h}.${b64url(enc.encode(JSON.stringify(claims(nonce, { sub: "someone-else" }))))}.${sig}`;
    }));

  it("alg none", () =>
    refused(async (nonce) => `${b64url(enc.encode('{"alg":"none"}'))}.${b64url(enc.encode(JSON.stringify(claims(nonce))))}.`));

  it("alg HS256, even signed with the client secret", () =>
    refused(async (nonce) => {
      const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", kid: "rsa-1" })));
      const p = b64url(enc.encode(JSON.stringify(claims(nonce))));
      const k = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return `${h}.${p}.${b64url(await crypto.subtle.sign("HMAC", k, enc.encode(`${h}.${p}`)))}`;
    }));

  it("an RS256 header on a token signed with the EC key", () =>
    refused((nonce) => jwt({ alg: "RS256", kid: "ec-1" }, claims(nonce), ec)));

  it("an affiliation decision 1 doesn't allow", async () => {
    await refused(token({ eduPersonScopedAffiliation: ["affiliate@ethz.ch", "member@ethz.ch"] }), "not_member");
    await refused(token({ eduPersonScopedAffiliation: "student@zhaw.ch" }), "not_member");
    await refused(token({ eduPersonScopedAffiliation: "alum@uzh.ch" }), "not_member");
    await refused(token({ eduPersonScopedAffiliation: "student@fake-ethz.ch" }), "not_member");
  });

  it("an edu-ID without any affiliation, also after userinfo", async () => {
    served.userinfo = { sub: "sub-raffaele", email: "r@example.com" };
    await refused(token({ eduPersonScopedAffiliation: undefined }), "not_member");
  });

  it("userinfo for another person", async () => {
    served.userinfo = { sub: "someone-else", eduPersonScopedAffiliation: "student@ethz.ch" };
    await refused(token({ eduPersonScopedAffiliation: undefined }));
  });

  it("a token endpoint that refuses the code", async () => {
    served.tokenStatus = 400;
    await refused(token());
  });

  it("an unknown kid: the keys are refetched only when the cached ones are older than 5 minutes", async () => {
    await refused(token({}, () => stranger)); // keys fetched just now: not again
    expect(keyCalls()).toHaveLength(1);

    const jwksKey = `eduid_jwks_${(await sha256Hex(ISSUER)).slice(0, 16)}`;
    kv.store.set(jwksKey, JSON.stringify({ keys: [rsa.jwk], at: Date.now() - 6 * 60_000 }));
    await refused(token({}, () => stranger)); // refetched once, still unknown
    expect(keyCalls()).toHaveLength(2);

    kv.store.set(jwksKey, JSON.stringify({ keys: [rsa.jwk], at: Date.now() - 6 * 60_000 }));
    served.keys = [rsa.jwk, stranger.jwk]; // SWITCH rotated its keys
    const { location } = await signIn({ make: token({}, () => stranger) });
    expect(location).toBe("/?tab=study#welcome");
    expect(keyCalls()).toHaveLength(3);
  });

  it("error= from SWITCH (the person cancelled): no token request, no account change", async () => {
    const login = await call("https://frooms.ch/auth/login?return=/eat");
    const state = new URL(login.headers.get("Location")!).searchParams.get("state");
    const back = await call(`https://frooms.ch/auth/callback?error=access_denied&state=${state}`, {
      headers: { Cookie: `${LOGIN_COOKIE}=${cookieOf(login, LOGIN_COOKIE)}` },
    });
    expect(back.headers.get("Location")).toBe("/eat#signin-error=cancelled");
    expect(tokenCalls()).toHaveLength(0);
    expect(users()).toHaveLength(0);
  });

  it("a wrong state, a missing or forged login cookie", async () => {
    const login = await call("https://frooms.ch/auth/login?return=/eat");
    const cookie = cookieOf(login, LOGIN_COOKIE)!;
    const state = new URL(login.headers.get("Location")!).searchParams.get("state");
    const tries = [
      { state: "wrong", cookie },
      { state, cookie: null },
      { state, cookie: `${cookie.split(".")[0]}.${b64url(new Uint8Array(32))}` },
    ];
    for (const t of tries) {
      const back = await call(`https://frooms.ch/auth/callback?code=c0de&state=${t.state}`, {
        headers: t.cookie ? { Cookie: `${LOGIN_COOKIE}=${t.cookie}` } : {},
      });
      expect(back.headers.get("Location")).toMatch(/#signin-error=expired$/);
    }
    expect(tokenCalls()).toHaveLength(0);
  });

  it("an expired login cookie (after 10 minutes)", async () => {
    const login = await call("https://frooms.ch/auth/login");
    const cookie = cookieOf(login, LOGIN_COOKIE)!;
    const state = new URL(login.headers.get("Location")!).searchParams.get("state");
    const url = new URL(`https://frooms.ch/auth/callback?code=c0de&state=${state}`);
    const req = new Request(url, { headers: { Cookie: `${LOGIN_COOKIE}=${cookie}` } });
    const back = await callback(req, url, authConfig(req, env())!, Date.now() + 10 * 60_000 + 1);
    expect(back.headers.get("Location")).toBe("/#signin-error=expired");
    expect(tokenCalls()).toHaveLength(0);
  });
});

describe("where to go back to", () => {
  it("only paths on this host", () => {
    expect(safeReturn("/?tab=eat&q=x")).toBe("/?tab=eat&q=x");
    expect(safeReturn("/room/HG#frag")).toBe("/room/HG");
    for (const bad of [null, "", "https://evil.example/", "//evil.example/", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "/\nx", "evil"]) {
      expect(safeReturn(bad)).toBe("/");
    }
  });

  it("a return to another host never leaves frooms.ch", async () => {
    const { state, location } = await signIn({ ret: "//evil.example/x" });
    expect(state.r).toBe("/");
    expect(location).toBe("/#welcome");
  });
});

describe("sessions", () => {
  it("an unknown or malformed session token gets 401", async () => {
    expect((await me(null)).status).toBe(401);
    expect((await me(b64url(new Uint8Array(32)))).status).toBe(401);
    expect((await me("not-a-token")).status).toBe(401);
  });

  it("an expired session gets 401", async () => {
    const { session } = await signIn();
    db.db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
    expect((await me(session)).status).toBe(401);
  });

  it("is renewed at most once a day, in D1, the cookie and last_seen_at", async () => {
    const { session } = await signIn();
    const cfg = authConfig(new Request("https://frooms.ch/"), env())!;
    const req = new Request("https://frooms.ch/api/me", { headers: { Cookie: `${SESSION_COOKIE}=${session}` } });
    const t0 = db.rows("SELECT renewed_at FROM sessions")[0].renewed_at as number;

    const early = await requireUser(req, cfg, { allowNoProfile: true, now: t0 + 23 * 3_600_000 });
    expect(early.setCookie).toBeUndefined();
    expect(db.rows("SELECT renewed_at FROM sessions")[0].renewed_at).toBe(t0);

    const later = t0 + 25 * 3_600_000;
    const renewed = await requireUser(req, cfg, { allowNoProfile: true, now: later });
    expect(renewed.setCookie).toContain(`${SESSION_COOKIE}=${session}`);
    expect(db.rows("SELECT renewed_at, expires_at FROM sessions")[0]).toEqual({ renewed_at: later, expires_at: later + SESSION_TTL_MS });
    expect(users()[0].last_seen_at).toBe(later);

    const again = await requireUser(req, cfg, { allowNoProfile: true, now: later + 3_600_000 });
    expect(again.setCookie).toBeUndefined();
    expect(db.batches).toBe(2); // the sign-in and one renewal
  });

  it("answers profile_needed until the profile step is done", async () => {
    const { session } = await signIn();
    const cfg = authConfig(new Request("https://frooms.ch/"), env())!;
    const req = new Request("https://frooms.ch/api/friends", { headers: { Cookie: `${SESSION_COOKIE}=${session}` } });
    await expect(requireUser(req, cfg)).rejects.toMatchObject({ status: 403, code: "profile_needed" });
    db.db.prepare("UPDATE users SET username = 'raffi'").run();
    expect((await requireUser(req, cfg)).user.username).toBe("raffi");
  });

  it("logout ends the session", async () => {
    const { session } = await signIn();
    const out = await call("https://frooms.ch/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${session}`, Origin: "https://frooms.ch" },
    });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toMatch(/^__Host-frooms_session=; .*Max-Age=0/);
    expect(db.rows("SELECT * FROM sessions")).toHaveLength(0);
    expect((await me(session)).status).toBe(401);
  });

  it("a POST without Origin or from another origin gets 403", async () => {
    const { session } = await signIn();
    for (const origin of [undefined, "https://evil.example", "http://frooms.ch", "null"]) {
      const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
      if (origin) headers.Origin = origin;
      expect((await call("https://frooms.ch/auth/logout", { method: "POST", headers })).status).toBe(403);
    }
    expect(db.rows("SELECT * FROM sessions")).toHaveLength(1);
  });

  it("wrong methods get 405", async () => {
    expect((await call("https://frooms.ch/auth/logout")).status).toBe(405);
    expect((await call("https://frooms.ch/auth/login", { method: "POST", headers: { Origin: "https://frooms.ch" } })).status).toBe(405);
  });
});

describe("hosts", () => {
  it("the fixed preview host signs in against ACCOUNTS_DEV with its own redirect_uri", async () => {
    const { to, location, session } = await signIn({ host: PREVIEW });
    expect(to.searchParams.get("redirect_uri")).toBe(`https://${PREVIEW}/auth/callback`);
    expect(new URLSearchParams(String(tokenCalls()[0].init!.body)).get("redirect_uri")).toBe(`https://${PREVIEW}/auth/callback`);
    // The preview's fragment carries plan 5.1's summary: claim names, affiliations, the email's domain, never the address.
    expect(location).toMatch(/^\/\?tab=study#welcome&claims=/);
    const summary = JSON.parse(decodeURIComponent(location.split("&claims=")[1]));
    expect(summary).toMatchObject({ from_userinfo: [], affiliation: ["member@ethz.ch", "student@ethz.ch"], email_domain: "ethz.ch" });
    expect(location.toLowerCase()).not.toContain("raffaele.wyss");
    expect(users(dev)).toHaveLength(1);
    expect(users(db)).toHaveLength(0);
    expect((await me(session, PREVIEW)).status).toBe(200);
    expect((await me(session, "frooms.ch")).status).toBe(401); // a preview session is no production session
  });

  it("every other host has sign-in off", async () => {
    for (const host of ["https://abc123-fruum.fruum.workers.dev", "http://localhost:8787", "http://frooms.ch", "https://www.frooms.ch"]) {
      const res = await call(`${host}/auth/login`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: "sign_in_off" });
      expect((await call(`${host}/api/me`)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("sign-in is off when a secret is missing", async () => {
    expect((await call("https://frooms.ch/auth/login", {}, env({ EDUID_CLIENT_SECRET: undefined }))).status).toBe(404);
    expect((await call("https://frooms.ch/auth/login", {}, env({ SESSION_KEY: "short" }))).status).toBe(404);
  });

  it("SWITCH unreachable: back to the page with a message", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const res = await call("https://frooms.ch/auth/login?return=/eat");
    expect(res.headers.get("Location")).toBe("/eat#signin-error=unavailable");
    expect(cookieOf(res, LOGIN_COOKIE)).toBeNull();
  });
});

describe("claims", () => {
  it("affiliations as a list or a string", () => {
    expect(affiliations(["Student@ETHZ.ch", "member@ethz.ch"])).toEqual(["student@ethz.ch", "member@ethz.ch"]);
    expect(affiliations("staff@uzh.ch member@uzh.ch")).toEqual(["staff@uzh.ch", "member@uzh.ch"]);
    expect(affiliations(undefined)).toEqual([]);
    expect(affiliations([1, null])).toEqual([]);
  });

  it("decision 1: who gets in, and which university", () => {
    expect(uniOf(["student@ethz.ch"])).toBe("eth");
    expect(uniOf(["employee@uzh.ch"])).toBe("uzh");
    expect(uniOf(["faculty@uzh.ch", "staff@ethz.ch"])).toBe("eth");
    expect(uniOf(["member@ethz.ch", "affiliate@ethz.ch", "alum@uzh.ch"])).toBeNull();
    expect(uniOf(["student@sub.ethz.ch", "student@ethz.ch.evil", "student@"])).toBeNull();
  });

  it("name keys fold accents and case", () => {
    expect(nameKey("Zoë", "  Müller-Lüdenscheidt ")).toBe("zoe muller-ludenscheidt");
    expect(nameKey("RAFFAELE", "von Arx")).toBe("raffaele von arx");
  });
});
