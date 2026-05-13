import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { analyzeWithAi, hashComposition, PROMPT_VERSION } from "./ai.js";
import { createSubmission, listShampoos, listTopShampoos, saveAnalysis } from "./db.js";
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

const AnalyzeBodySchema = z.object({
  composition: z.string().trim().min(20).max(12000),
  recaptchaToken: z.string().trim().min(1).optional(),
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

app.post("/api/analyze", async (request, reply) => {
  const body = AnalyzeBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
  }

  const recaptcha = await verifyRecaptcha(body.data.recaptchaToken, "analyze");
  if (!recaptcha.ok) {
    return reply.code(403).send({ error: "recaptcha_failed", details: recaptcha });
  }

  const { result, provider, model } = await analyzeWithAi(body.data.composition, listTopShampoos(3));
  saveAnalysis({
    inputHash: hashComposition(body.data.composition),
    composition: body.data.composition,
    result,
    provider,
    model,
    promptVersion: PROMPT_VERSION,
  });

  return { result, provider, model, promptVersion: PROMPT_VERSION };
});

app.post("/api/submissions", async (request, reply) => {
  const body = SubmissionBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
  }

  const recaptcha = await verifyRecaptcha(body.data.recaptchaToken, "submit_shampoo");
  if (!recaptcha.ok) {
    return reply.code(403).send({ error: "recaptcha_failed", details: recaptcha });
  }

  const result = createSubmission(body.data);
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
