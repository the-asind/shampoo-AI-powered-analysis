import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { analyzeWithAi, hashComposition, PROMPT_VERSION } from "./ai.js";
import { checkRateLimit, createSubmission, getAdminSummary, listAnalyses, listComparisonShampoos, listShampoos, listSubmissions, recordVisit, saveAnalysis } from "./db.js";
import { verifyRecaptcha } from "./recaptcha.js";

dotenv.config();

const app = Fastify({
  logger: process.env.NODE_ENV !== "test",
  bodyLimit: 64 * 1024,
});

await app.register(cors, {
  origin: process.env.NODE_ENV === "production" ? false : true,
});

const AudienceSchema = z.enum(["normal", "oily", "sensitive"]);

function getClientIp(request: { ip: string; headers: Record<string, unknown> }) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || request.ip;
  }

  return request.ip;
}

function sendRateLimit(reply: { header: (name: string, value: string) => unknown; code: (statusCode: number) => { send: (payload: unknown) => unknown } }, limit: ReturnType<typeof checkRateLimit>) {
  if (limit.allowed) {
    return null;
  }

  reply.header("Retry-After", String(limit.retryAfterSeconds));
  return reply.code(429).send({
    error: "rate_limited",
    reason: limit.reason,
    retryAfterSeconds: limit.retryAfterSeconds,
  });
}

function isAdminRequest(request: { headers: Record<string, unknown> }) {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    return false;
  }

  const authorization = request.headers.authorization;
  const headerToken = request.headers["x-admin-token"];
  const provided = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : typeof headerToken === "string"
      ? headerToken.trim()
      : "";

  return provided === token;
}

function requireAdmin(request: { headers: Record<string, unknown> }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  if (!process.env.ADMIN_TOKEN?.trim()) {
    return reply.code(503).send({ error: "admin_not_configured" });
  }

  if (!isAdminRequest(request)) {
    return reply.code(401).send({ error: "admin_unauthorized" });
  }

  return null;
}

const AnalyzeBodySchema = z.object({
  composition: z.string().trim().min(20).max(12000),
  recaptchaToken: z.string().trim().min(1).optional(),
});

const VisitBodySchema = z.object({
  path: z.string().trim().min(1).max(240).default("/"),
});

const AdminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SubmissionBodySchema = z.object({
  name: z.string().trim().min(2).max(160),
  price: z.string().trim().max(80).default(""),
  sourceUrl: z.string().trim().url().max(500),
  composition: z.string().trim().min(20).max(12000),
  recaptchaToken: z.string().trim().min(1).optional(),
  analysis: z
    .object({
      score: z.number().int().min(0).max(100),
      title: z.string(),
      verdict: z.string(),
      tone: z.enum(["good", "watch", "weak", "empty"]),
      confidence: z.enum(["высокая", "средняя", "низкая"]),
      shampooType: z.enum([
        "универсальный",
        "мягкий sulfate-free",
        "сильное очищение",
        "чувствительная кожа",
        "разглаживающий",
        "маркетингово перегруженный",
        "подозрительный состав",
        "не рекомендуется",
      ]),
      pros: z.string(),
      cons: z.string(),
      leaderComparison: z.string(),
      shouldSuggest: z.boolean(),
    })
    .refine((analysis) => analysis.shouldSuggest, "analysis should be eligible for suggestion"),
});

app.get("/api/health", async () => ({
  ok: true,
  promptVersion: PROMPT_VERSION,
}));

app.get("/api/shampoos", async (request, reply) => {
  const query = z.object({ audience: AudienceSchema.optional() }).safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: "invalid_query" });
  }

  return { items: listShampoos(query.data.audience) };
});

app.post("/api/visits", async (request, reply) => {
  const body = VisitBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body" });
  }

  recordVisit({
    clientIp: getClientIp(request),
    path: body.data.path,
    referrer: typeof request.headers.referer === "string" ? request.headers.referer : "",
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "",
  });

  return reply.code(204).send();
});

app.get("/api/admin/summary", async (request, reply) => {
  const unauthorized = requireAdmin(request, reply);
  if (unauthorized) {
    return unauthorized;
  }

  return getAdminSummary();
});

app.get("/api/admin/analyses", async (request, reply) => {
  const unauthorized = requireAdmin(request, reply);
  if (unauthorized) {
    return unauthorized;
  }

  const query = AdminListQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: "invalid_query" });
  }

  return { items: listAnalyses(query.data.limit, query.data.offset) };
});

app.get("/api/admin/submissions", async (request, reply) => {
  const unauthorized = requireAdmin(request, reply);
  if (unauthorized) {
    return unauthorized;
  }

  const query = AdminListQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: "invalid_query" });
  }

  return { items: listSubmissions(query.data.limit, query.data.offset) };
});

app.post("/api/analyze", async (request, reply) => {
  const startedAt = Date.now();
  const body = AnalyzeBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
  }

  const clientIp = getClientIp(request);
  const recaptchaStartedAt = Date.now();
  const recaptcha = await verifyRecaptcha(body.data.recaptchaToken, "analyze");
  const recaptchaMs = Date.now() - recaptchaStartedAt;
  if (!recaptcha.ok) {
    request.log.warn({ action: "analyze", clientIp, recaptchaMs, totalMs: Date.now() - startedAt, recaptcha }, "recaptcha_failed");
    return reply.code(403).send({ error: "recaptcha_failed", details: recaptcha });
  }

  const rateLimitStartedAt = Date.now();
  const rateLimit = checkRateLimit({ clientIp, action: "analyze" });
  const rateLimitMs = Date.now() - rateLimitStartedAt;
  const rateLimited = sendRateLimit(reply, rateLimit);
  if (rateLimited) {
    request.log.warn({ action: "analyze", clientIp, recaptchaMs, rateLimitMs, totalMs: Date.now() - startedAt, rateLimit }, "rate_limited");
    return rateLimited;
  }

  const referencesStartedAt = Date.now();
  const references = listComparisonShampoos();
  const referencesMs = Date.now() - referencesStartedAt;
  const aiStartedAt = Date.now();
  const { result, provider, model } = await analyzeWithAi(body.data.composition, references, request.log);
  const aiMs = Date.now() - aiStartedAt;
  const saveStartedAt = Date.now();
  saveAnalysis({
    inputHash: hashComposition(body.data.composition),
    composition: body.data.composition,
    result,
    provider,
    model,
    promptVersion: PROMPT_VERSION,
  });
  const saveMs = Date.now() - saveStartedAt;

  request.log.info({
    action: "analyze",
    clientIp,
    provider,
    model,
    score: result.score,
    recaptchaMs,
    rateLimitMs,
    referencesMs,
    aiMs,
    saveMs,
    totalMs: Date.now() - startedAt,
  }, "analysis_completed");
  return { result, provider, model, promptVersion: PROMPT_VERSION };
});

app.post("/api/submissions", async (request, reply) => {
  const body = SubmissionBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
  }

  const clientIp = getClientIp(request);
  const recaptcha = await verifyRecaptcha(body.data.recaptchaToken, "submit_shampoo");
  if (!recaptcha.ok) {
    request.log.warn({ action: "submit_shampoo", clientIp, recaptcha }, "recaptcha_failed");
    return reply.code(403).send({ error: "recaptcha_failed", details: recaptcha });
  }

  const rateLimit = checkRateLimit({ clientIp, action: "submit_shampoo" });
  const rateLimited = sendRateLimit(reply, rateLimit);
  if (rateLimited) {
    request.log.warn({ action: "submit_shampoo", clientIp, rateLimit }, "rate_limited");
    return rateLimited;
  }

  const result = createSubmission(body.data);
  request.log.info({ action: "submit_shampoo", clientIp, submissionId: result.id }, "submission_created");
  return reply.code(201).send(result);
});

if (process.env.NODE_ENV === "production") {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicRoot = path.resolve(__dirname, "../dist");

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  app.get("/*", async (request, reply) => {
    const requestPath = new URL(request.url, "http://localhost").pathname;
    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const candidate = path.resolve(publicRoot, relativePath);
    const isInsidePublicRoot = candidate === publicRoot || candidate.startsWith(`${publicRoot}${path.sep}`);
    const target = isInsidePublicRoot && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(publicRoot, "index.html");

    reply.type(mimeTypes[path.extname(target)] ?? "application/octet-stream");
    return reply.send(fs.createReadStream(target));
  });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
