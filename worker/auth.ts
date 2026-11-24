// Sign-in with SWITCH edu-ID (plans/PLAN_ACCOUNTS.md, sections 2, 5 and 6): OpenID Connect, authorization code flow
// with PKCE, confidential client (client_secret_basic). The ID token is checked here with Web Crypto (RS256 or ES256,
// nothing else). After that everything is frooms' own: a random session token in an HttpOnly cookie, its SHA-256 in
// the accounts database.
//
// Sign-in works only on frooms.ch (database ACCOUNTS) and on the fixed preview host PREVIEW_AUTH_HOST (ACCOUNTS_DEV).
// Every other host (ordinary previews, localhost) has it off. There is no dev login, not even behind a flag.

import { batchWithBump, bumpFor } from "./stats";

export interface AuthEnv {
  ROOMS?: KVNamespace;
  ACCOUNTS?: D1Database;
  ACCOUNTS_DEV?: D1Database;
  EDUID_ISSUER?: string;
  EDUID_CLIENT_ID?: string;
  EDUID_CLIENT_SECRET?: string;
  SESSION_KEY?: string;
  PREVIEW_AUTH_HOST?: string;
  RATE_LIMITER?: RateLimit;
}

export interface AuthConfig {
  db: D1Database;
  kv?: KVNamespace;
  origin: string; // "https://frooms.ch" or "https://<PREVIEW_AUTH_HOST>"
  issuer: string;
  clientId: string;
  secret: string;
  key: string; // SESSION_KEY: signs the login cookie
}

export const PRODUCTION_HOST = "frooms.ch";
export const LOGIN_COOKIE = "__Host-frooms_login";
export const SESSION_COOKIE = "__Host-frooms_session";
// SWITCH releases the attributes registered in the Resource Registry (affiliation, names, email) only under its own
// scope; "profile email" give no affiliation (found at the first real sign-in, 2026-11-17; help.switch.ch/eduid/service/oidc/scopes/).
export const SCOPE = "openid https://eduid.ch/scope/userinfo.read";
const LOGIN_TTL_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;
export const SESSION_TTL_MS = 30 * DAY_MS; // decision 16
const JWKS_REFETCH_MS = 5 * 60_000; // an unknown `kid` refetches the keys at most this often
const CACHE_TTL_S = 24 * 3600; // discovery document and keys in KV
const IAT_SKEW_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Decision 1: who may sign in. */
const ALLOWED_ROLES = new Set(["student", "staff", "faculty", "employee"]);
const UNI_DOMAINS: Record<string, "eth" | "uzh"> = { "ethz.ch": "eth", "uzh.ch": "uzh" };

/** The sign-in's error codes, sent back to the page as `#signin-error=<code>` (plan 8.3). */
export type SignInError = "cancelled" | "expired" | "not_member" | "failed" | "unavailable";

/** A refused request to an account endpoint: 401 signed out, 403 profile_needed or a failed Origin check. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

class SignInFailed extends Error {
  constructor(
    readonly code: SignInError,
    detail: string,
  ) {
    super(detail);
  }
}

// --- Encoding ---------------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const randomToken = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** application/x-www-form-urlencoded, as RFC 6749 section 2.3.1 wants for the Basic credentials. */
const formEncode = (s: string) => new URLSearchParams([["", s]]).toString().slice(1);

// --- Configuration ----------------------------------------------------------------------------------------------------

/**
 * The accounts setup for this request's host, or null when sign-in is off here: only frooms.ch (ACCOUNTS) and the
 * fixed preview host (ACCOUNTS_DEV), over HTTPS, with every secret and variable present.
 */
export function authConfig(request: Request, env: AuthEnv): AuthConfig | null {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return null;
  let db: D1Database | undefined;
  if (url.hostname === PRODUCTION_HOST) db = env.ACCOUNTS;
  else if (env.PREVIEW_AUTH_HOST && url.hostname === env.PREVIEW_AUTH_HOST) db = env.ACCOUNTS_DEV;
  if (!db || !env.EDUID_ISSUER || !env.EDUID_CLIENT_ID || !env.EDUID_CLIENT_SECRET) return null;
  if (!env.SESSION_KEY || env.SESSION_KEY.length < 32) return null;
  return {
    db,
    kv: env.ROOMS,
    origin: url.origin,
    issuer: env.EDUID_ISSUER,
    clientId: env.EDUID_CLIENT_ID,
    secret: env.EDUID_CLIENT_SECRET,
    key: env.SESSION_KEY,
  };
}

// --- Cookies ----------------------------------------------------------------------------------------------------------

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const setCookie = (name: string, value: string, maxAgeS: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
const clearCookie = (name: string) => setCookie(name, "", 0);
export const sessionCookie = (token: string) => setCookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);

interface LoginState {
  s: string; // state
  n: string; // nonce
  v: string; // PKCE code_verifier
  r: string; // where to go afterwards
  e: number; // expiry, ms
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signLogin(state: LoginState, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(state)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** The login cookie's content when its signature is right and it hasn't expired, else null. */
export async function readLogin(value: string | null, secret: string, now = Date.now()): Promise<LoginState | null> {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(payload));
    if (!ok) return null;
    const state = JSON.parse(dec.decode(fromB64url(payload))) as LoginState;
    if (typeof state.e !== "number" || state.e <= now) return null;
    if (![state.s, state.n, state.v, state.r].every((x) => typeof x === "string")) return null;
    return { ...state, r: safeReturn(state.r) };
  } catch {
    return null;
  }
}

/** A path on this host to go back to after signing in: starts with one "/", else "/". Never another host. */
export function safeReturn(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://frooms.invalid");
    if (url.origin !== "https://frooms.invalid") return "/";
    return url.pathname + url.search; // the fragment is ours (#welcome, #signin-error)
  } catch {
    return "/";
  }
}

// --- SWITCH's discovery document and keys -----------------------------------------------------------------------------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
}

interface KeySet {
  keys: Jwk[];
  at: number; // when it was fetched, ms
}

const cacheKey = async (kind: string, issuer: string) => `eduid_${kind}_${(await sha256Hex(issuer)).slice(0, 16)}`;

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const isHttps = (v: unknown): v is string => typeof v === "string" && v.startsWith("https://");

export async function discovery(cfg: AuthConfig): Promise<Discovery> {
  const key = await cacheKey("config", cfg.issuer);
  const cached = (await cfg.kv?.get(key, "json")) as Discovery | null;
  if (cached) return cached;
  const doc = (await getJson(`${cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)) as Partial<Discovery>;
  if (doc.issuer !== cfg.issuer) throw new Error(`Discovery names issuer ${doc.issuer}, expected ${cfg.issuer}`);
  if (!isHttps(doc.authorization_endpoint) || !isHttps(doc.token_endpoint) || !isHttps(doc.jwks_uri)) {
    throw new Error("Discovery document lacks an HTTPS endpoint");
  }
  if (doc.userinfo_endpoint !== undefined && !isHttps(doc.userinfo_endpoint)) delete doc.userinfo_endpoint;
  const out: Discovery = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint,
    jwks_uri: doc.jwks_uri,
  };
  await cfg.kv?.put(key, JSON.stringify(out), { expirationTtl: CACHE_TTL_S });
  return out;
}

async function fetchKeys(cfg: AuthConfig, oidc: Discovery, now: number): Promise<KeySet> {
  const body = (await getJson(oidc.jwks_uri)) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("JWKS without keys");
  const set: KeySet = { keys: body.keys as Jwk[], at: now };
  await cfg.kv?.put(await cacheKey("jwks", cfg.issuer), JSON.stringify(set), { expirationTtl: CACHE_TTL_S });
  return set;
}

type Alg = "RS256" | "ES256";

const fits = (k: Jwk, alg: Alg, kid: string | undefined) =>
  (kid === undefined || k.kid === kid) &&
  (k.use === undefined || k.use === "sig") &&
  (k.alg === undefined || k.alg === alg) &&
  (alg === "RS256" ? k.kty === "RSA" && !!k.n && !!k.e : k.kty === "EC" && k.crv === "P-256" && !!k.x && !!k.y);

/**
 * SWITCH's keys that can have signed this token. A `kid` that isn't in the cached set refetches the set, at most once
 * per JWKS_REFETCH_MS (so a key rotation works, and a stream of made-up `kid`s can't make us hammer SWITCH).
 */
async function keysFor(cfg: AuthConfig, oidc: Discovery, alg: Alg, kid: string | undefined, now: number): Promise<Jwk[]> {
  const key = await cacheKey("jwks", cfg.issuer);
  let set = ((await cfg.kv?.get(key, "json")) as KeySet | null) ?? (await fetchKeys(cfg, oidc, now));
  let keys = set.keys.filter((k) => fits(k, alg, kid));
  if (!keys.length && now - set.at >= JWKS_REFETCH_MS) {
    set = await fetchKeys(cfg, oidc, now);
    keys = set.keys.filter((k) => fits(k, alg, kid));
  }
  return keys;
}

async function importJwk(k: Jwk, alg: Alg): Promise<CryptoKey> {
  if (alg === "RS256") {
    if (fromB64url(k.n!).length < 256) throw new Error("RSA key shorter than 2048 bits");
    return crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

// --- The ID token -----------------------------------------------------------------------------------------------------

export type Claims = Record<string, unknown> & { sub: string };

/**
 * Checks an ID token (plan 6.2, step 3) and returns its claims: RS256 or ES256 only (never `none` or HS*), signed by
 * one of SWITCH's keys, `iss` exactly the issuer, `aud` naming us (and `azp` us when present), not expired, `iat` not
 * in the future, and the nonce we sent.
 */
export async function verifyIdToken(token: string, cfg: AuthConfig, oidc: Discovery, nonce: string, now = Date.now()): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ID token isn't a JWS");
  const header = JSON.parse(dec.decode(fromB64url(parts[0]))) as { alg?: unknown; kid?: unknown; crit?: unknown };
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw new Error(`ID token alg ${String(alg)} refused`);
  if (header.crit !== undefined) throw new Error("ID token has critical header parameters");
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  const keys = await keysFor(cfg, oidc, alg, kid, now);
  if (!keys.length) throw new Error(`No key of SWITCH's for kid ${kid}`);
  const signature = fromB64url(parts[2]);
  if (alg === "ES256" && signature.length !== 64) throw new Error("ES256 signature of the wrong length");
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  let valid = false;
  for (const k of keys) {
    if (await crypto.subtle.verify(params, await importJwk(k, alg), signature, data)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new Error("ID token signature doesn't verify");

  const c = JSON.parse(dec.decode(fromB64url(parts[1]))) as Record<string, unknown>;
  if (c.iss !== cfg.issuer) throw new Error(`ID token iss ${String(c.iss)}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.clientId)) throw new Error("ID token aud doesn't name frooms");
  if (c.azp !== undefined && c.azp !== cfg.clientId) throw new Error("ID token azp isn't frooms");
  if (typeof c.exp !== "number" || c.exp * 1000 <= now) throw new Error("ID token expired");
  if (typeof c.iat !== "number" || c.iat * 1000 > now + IAT_SKEW_MS) throw new Error("ID token issued in the future");
  if (c.nonce !== nonce) throw new Error("ID token nonce doesn't match");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("ID token without sub");
  return c as Claims;
}

// --- Who the person is ------------------------------------------------------------------------------------------------

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** `eduPersonScopedAffiliation` arrives as a list or as one string (possibly several values in it). */
export function affiliations(v: unknown): string[] {
  const values = Array.isArray(v) ? v : [v];
  return values.flatMap((x) => (typeof x === "string" ? x.split(/[\s,;]+/) : [])).filter(Boolean).map((x) => x.toLowerCase());
}

/** Decision 1: "eth" when an allowed affiliation is at ethz.ch, else "uzh" for one at uzh.ch, else null (refused). */
export function uniOf(affs: string[]): "eth" | "uzh" | null {
  const unis = new Set<string>();
  for (const a of affs) {
    const at = a.lastIndexOf("@");
    if (at > 0 && ALLOWED_ROLES.has(a.slice(0, at)) && UNI_DOMAINS[a.slice(at + 1)]) unis.add(UNI_DOMAINS[a.slice(at + 1)]);
  }
  return unis.has("eth") ? "eth" : unis.has("uzh") ? "uzh" : null;
}

/** "Raffaele Wyss" → "raffaele wyss": lower case, accents folded, spaces collapsed. For name search. */
export const nameKey = (first: string, last: string) =>
  `${first} ${last}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

const NEEDED = ["given_name", "family_name", "eduPersonScopedAffiliation"];

// --- Talking to SWITCH ------------------------------------------------------------------------------------------------

async function exchangeCode(cfg: AuthConfig, oidc: Discovery, code: string, verifier: string) {
  const res = await fetch(oidc.token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${formEncode(cfg.clientId)}:${formEncode(cfg.secret)}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${cfg.origin}/auth/callback`,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Token endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { id_token?: unknown; access_token?: unknown };
  if (typeof body.id_token !== "string") throw new Error("Token response without id_token");
  return { idToken: body.id_token, accessToken: typeof body.access_token === "string" ? body.access_token : undefined };
}

/** Claims the ID token lacks, from userinfo (plan 5.1, point 1). Its `sub` must be the token's. */
async function userinfo(oidc: Discovery, accessToken: string | undefined, sub: string): Promise<Record<string, unknown>> {
  if (!oidc.userinfo_endpoint || !accessToken) return {};
  const info = (await getJson(oidc.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  })) as Record<string, unknown>;
  if (info.sub !== sub) throw new Error("Userinfo names another sub");
  return info;
}

// --- Routes -----------------------------------------------------------------------------------------------------------

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/** GET /auth/login?return=<path>: off to SWITCH, with state, nonce and PKCE in a signed 10-minute cookie. */
export async function login(url: URL, cfg: AuthConfig, now = Date.now()): Promise<Response> {
  const ret = safeReturn(url.searchParams.get("return"));
  let oidc: Discovery;
  try {
    oidc = await discovery(cfg);
  } catch (e) {
    console.error(`Sign-in: SWITCH's discovery failed: ${e instanceof Error ? e.message : e}`);
    return redirect(`${ret}#signin-error=unavailable`);
  }
  const state: LoginState = { s: randomToken(16), n: randomToken(16), v: randomToken(32), r: ret, e: now + LOGIN_TTL_MS };
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(state.v)));
  const target = new URL(oidc.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: `${cfg.origin}/auth/callback`,
    scope: SCOPE,
    state: state.s,
    nonce: state.n,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) target.searchParams.set(k, v);
  return redirect(target.toString(), [setCookie(LOGIN_COOKIE, await signLogin(state, cfg.key), LOGIN_TTL_MS / 1000)]);
}

/** GET /auth/callback?code=…&state=…: checks everything, then writes the user and starts a session (plan 6.2). */
export async function callback(request: Request, url: URL, cfg: AuthConfig, now = Date.now()): Promise<Response> {
  const state = await readLogin(readCookie(request, LOGIN_COOKIE), cfg.key, now);
  const ret = state?.r ?? "/";
  const done = [clearCookie(LOGIN_COOKIE)];
  // On the accounts preview only, the fragment also carries why (and, on success, plan 5.1's claims summary): the
  // fragment never leaves the browser, and preview requests don't reach `wrangler tail`.
  const preview = cfg.origin !== `https://${PRODUCTION_HOST}`;
  const extra = (key: string, value: string | undefined) => (preview && value ? `&${key}=${encodeURIComponent(value)}` : "");
  const fail = (code: SignInError, detail?: string) => redirect(`${ret}#signin-error=${code}${extra("detail", detail)}`, done);

  if (url.searchParams.has("error")) {
    return fail("cancelled", `${url.searchParams.get("error")}: ${url.searchParams.get("error_description") ?? ""}`);
  }
  if (!state || url.searchParams.get("state") !== state.s) return fail("expired");
  const code = url.searchParams.get("code");
  if (!code) return fail("failed");

  try {
    const oidc = await discovery(cfg);
    const { idToken, accessToken } = await exchangeCode(cfg, oidc, code, state.v);
    let claims: Record<string, unknown> = await verifyIdToken(idToken, cfg, oidc, state.n, now);
    const sub = claims.sub as string;
    const inToken = Object.keys(claims);
    const missing = NEEDED.filter((k) => claims[k] === undefined);
    if (missing.length) claims = { ...(await userinfo(oidc, accessToken, sub)), ...claims };
    // Plan 5.1's open points, on the accounts preview only (never frooms.ch): which claims the ID token carries, whether
    // userinfo was needed, the affiliations, and the email's domain (never the address).
    let summary: string | undefined;
    if (preview) {
      const domain = (v: unknown) => (typeof v === "string" ? v.slice(v.lastIndexOf("@") + 1).toLowerCase() : null);
      const linkedMail = claims.swissEduIDLinkedAffiliationMail;
      summary = JSON.stringify({
        in_id_token: inToken,
        from_userinfo: missing,
        affiliation: affiliations(claims.eduPersonScopedAffiliation),
        linked_affiliation: claims.swissEduIDLinkedAffiliation ?? null,
        email_domain: domain(claims.email),
        linked_mail_domains: Array.isArray(linkedMail) ? linkedMail.map(domain) : domain(linkedMail),
      });
      console.log(`Sign-in claims (preview): ${summary}`);
    }

    const uni = uniOf(affiliations(claims.eduPersonScopedAffiliation));
    if (!uni) throw new SignInFailed("not_member", `no ETH or UZH member affiliation ${summary ?? ""}`);
    const first = text(claims.given_name);
    const last = text(claims.family_name);
    if (!first || !last) throw new Error("No given_name or family_name");
    const email = text(claims.email)?.toLowerCase();

    const token = randomToken(32);
    // Usage counters (stats.ts): every sign-in, and the one that makes the account (looked up first: the upsert below
    // reports one change either way).
    const known = await cfg.db.prepare("SELECT 1 FROM users WHERE id = ?").bind(sub).first();
    await batchWithBump(cfg.db, [
      cfg.db
        .prepare(
          `INSERT INTO users (id, username, first_name, last_name, name_key, bg, fg, email_hash, uni, created_at, last_seen_at)
           VALUES (?1, NULL, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?7)
           ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
             name_key = excluded.name_key, email_hash = excluded.email_hash, uni = excluded.uni,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(sub, first, last, nameKey(first, last), email ? await sha256Hex(email) : null, uni, now),
      cfg.db
        .prepare("INSERT INTO sessions (token_hash, user_id, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha256Hex(token), sub, now, now, now + SESSION_TTL_MS),
    ], bumpFor(cfg.db, now, { sign_in: 1, account_created: known ? 0 : 1 }));
    const user = await cfg.db.prepare("SELECT username FROM users WHERE id = ?").bind(sub).first<{ username: string | null }>();
    const fragment = (user?.username ? "" : "welcome") + extra("claims", summary);
    return redirect(fragment ? `${ret}#${fragment.replace(/^&/, "")}` : ret, [...done, sessionCookie(token)]);
  } catch (e) {
    if (e instanceof SignInFailed) {
      console.log(`Sign-in refused: ${e.message}`);
      return fail(e.code, e.message);
    }
    console.error(`Sign-in failed: ${e instanceof Error ? e.message : e}`);
    return fail("failed", e instanceof Error ? e.message : String(e));
  }
}

/** Requests that change something must come from our own page (plan 6.3): the second lock after SameSite=Lax. */
export function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

/** POST /auth/logout: ends this session (not the edu-ID one, decision 14). */
export async function logout(request: Request, cfg: AuthConfig): Promise<Response> {
  if (!sameOrigin(request)) throw new AuthError(403, "bad_origin");
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await cfg.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookie(SESSION_COOKIE), "Cache-Control": "no-store" } });
}

// --- Sessions ---------------------------------------------------------------------------------------------------------

export interface User {
  id: string;
  username: string | null;
  first_name: string;
  last_name: string;
  bg: string | null;
  fg: string | null;
  bg2: string | null;
  fg2: string | null;
  metal: string | null;
  uni: string;
}

export interface Signed {
  user: User;
  /** A renewed session cookie to send with the answer (set at most once a day). */
  setCookie?: string;
}

/**
 * The signed-in person (plan 6.3), or AuthError 401 when the session cookie is missing, unknown or expired, and 403
 * `profile_needed` while the first sign-in's profile step isn't done (unless `allowNoProfile`). A session older than a
 * day since its last renewal is renewed: in D1, in the cookie, and in the user's `last_seen_at`.
 */
export async function requireUser(request: Request, cfg: AuthConfig, opts: { allowNoProfile?: boolean; now?: number } = {}): Promise<Signed> {
  const now = opts.now ?? Date.now();
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError(401, "signed_out");
  const hash = await sha256Hex(token);
  const row = await cfg.db
    .prepare(
      `SELECT u.id, u.username, u.first_name, u.last_name, u.bg, u.fg, u.bg2, u.fg2, u.metal, u.uni, s.renewed_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(hash)
    .first<User & { renewed_at: number; expires_at: number }>();
  if (!row || row.expires_at <= now) throw new AuthError(401, "signed_out");
  const { renewed_at, expires_at: _, ...user } = row;
  if (!user.username && !opts.allowNoProfile) throw new AuthError(403, "profile_needed");
  let renewed: string | undefined;
  if (now - renewed_at >= DAY_MS) {
    await cfg.db.batch([
      cfg.db.prepare("UPDATE sessions SET renewed_at = ?, expires_at = ? WHERE token_hash = ?").bind(now, now + SESSION_TTL_MS, hash),
      cfg.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, user.id),
    ]);
    renewed = sessionCookie(token);
  }
  return { user, setCookie: renewed };
}

/**
 * The signed-in person if there is one, for endpoints that also work signed out (POST /api/report, POST /api/feedback:
 * Street cred). Null when sign-in is off on this host, when no valid session comes with the request, before the
 * profile step, and when the accounts database fails (logged): never an error. Renews the session like requireUser;
 * pass `setCookie` on with the answer.
 */
export async function optionalUser(request: Request, env: AuthEnv, now = Date.now()): Promise<(Signed & { db: D1Database }) | null> {
  const cfg = authConfig(request, env);
  if (!cfg || !readCookie(request, SESSION_COOKIE)) return null;
  try {
    return { ...(await requireUser(request, cfg, { now })), db: cfg.db };
  } catch (e) {
    if (!(e instanceof AuthError)) console.error(`Optional sign-in failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// --- The router -------------------------------------------------------------------------------------------------------

export const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });

/** /auth/*. Hosts without sign-in answer 404 (`sign_in_off`), so the page can say where sign-in works. */
export async function handleAuth(request: Request, url: URL, env: AuthEnv): Promise<Response> {
  const cfg = authConfig(request, env);
  if (!cfg) return answer({ detail: "sign_in_off" }, 404);
  const path = url.pathname;
  try {
    if (path === "/auth/login" || path === "/auth/callback") {
      if (request.method !== "GET") return answer({ detail: "Method not allowed" }, 405);
      if (env.RATE_LIMITER) {
        const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
        if (!success) return answer({ detail: "Too many requests, try again in a minute" }, 429, { "Retry-After": "60" });
      }
      return path === "/auth/login" ? await login(url, cfg) : await callback(request, url, cfg);
    }
    if (path === "/auth/logout") {
      if (request.method !== "POST") return answer({ detail: "Method not allowed" }, 405);
      return await logout(request, cfg);
    }
    return answer({ detail: "Not found" }, 404);
  } catch (e) {
    if (e instanceof AuthError) return answer({ detail: e.code }, e.status);
    console.error(`Account request ${path} failed: ${e instanceof Error ? e.stack : e}`);
    return answer({ detail: "Something went wrong. Please try again." }, 500);
  }
}
