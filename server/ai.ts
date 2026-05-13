import crypto from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { heuristicAnalyzeIngredients } from "./scoring.js";
import type { IngredientAnalysis, Shampoo } from "./types.js";
import type { ShampooComparisonReference } from "./db.js";

export const PROMPT_VERSION = "shampoo-inci-evaluator-v2";

type AiLogger = {
  warn: (payload: Record<string, unknown>, message?: string) => void;
  info?: (payload: Record<string, unknown>, message?: string) => void;
};
type AiFetchOptions = NonNullable<Parameters<typeof undiciFetch>[1]>;

function normalizeAiText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAiText(item)).filter(Boolean).join(" ");
  }

  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => normalizeAiText(item)).filter(Boolean).join(" ");
      }
    } catch {
      const quotedItems = Array.from(text.matchAll(/'([^']+)'/g), (match) => match[1]?.trim()).filter(Boolean);
      if (quotedItems.length > 0) {
        return quotedItems.join(" ");
      }
    }
  }

  return text
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textField(maxLength: number) {
  return z.preprocess((value) => normalizeAiText(value), z.string().max(maxLength));
}

const AnalysisSchema = z.object({
  score: z.number().int().min(0).max(100),
  title: textField(140),
  verdict: textField(1600),
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
  pros: textField(2400),
  cons: textField(2400),
  leaderComparison: textField(1800),
  shouldSuggest: z.boolean(),
});

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "shampoo_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Оценка состава от 0 до 100, где 100 соответствует 10/10.",
        },
        title: {
          type: "string",
          minLength: 3,
          maxLength: 140,
          description: "Короткий человеческий заголовок результата для UI. Нельзя писать placeholder вроде value, title или заголовок.",
        },
        verdict: {
          type: "string",
          maxLength: 1600,
          description: "Краткий вердикт простым языком: хороший/средний/плохой кандидат и кому он подходит.",
        },
        tone: {
          type: "string",
          enum: ["good", "watch", "weak", "empty"],
          description: "Общий тон для интерфейса.",
        },
        confidence: {
          type: "string",
          enum: ["высокая", "средняя", "низкая"],
          description: "Уверенность оценки по качеству и полноте состава.",
        },
        shampooType: {
          type: "string",
          enum: [
            "универсальный",
            "мягкий sulfate-free",
            "сильное очищение",
            "чувствительная кожа",
            "разглаживающий",
            "маркетингово перегруженный",
            "подозрительный состав",
            "не рекомендуется",
          ],
          description: "Тип шампуня по составу.",
        },
        pros: {
          type: "string",
          maxLength: 2400,
          description: "Главные плюсы одним связным текстом, без markdown-списка, без JSON-массива и без квадратных скобок.",
        },
        cons: {
          type: "string",
          maxLength: 2400,
          description: "Главные минусы одним связным текстом, без markdown-списка, без JSON-массива и без квадратных скобок.",
        },
        leaderComparison: {
          type: "string",
          maxLength: 1800,
          description: "Сравнение с переданными референсами простым языком. Нельзя писать placeholder вроде value.",
        },
        shouldSuggest: {
          type: "boolean",
          description: "Стоит ли предложить пользователю отправить этот шампунь в общий рейтинг.",
        },
      },
      required: [
        "score",
        "title",
        "verdict",
        "tone",
        "confidence",
        "shampooType",
        "pros",
        "cons",
        "leaderComparison",
        "shouldSuggest",
      ],
    },
  },
} as const;

function formatComparisonReferences(references: ShampooComparisonReference[]) {
  if (references.length === 0) {
    return "Сейчас в базе нет опубликованных референсов для сравнения.";
  }

  return references
    .map((reference, index) => {
      const item = reference.item;
      const price = item.price > 0 ? `${item.price} ₽/л` : "цена не указана";
      const composition = item.inci || item.base || "состав не указан";
      return `${index + 1}. ${reference.label}: ${item.brandNote} ${item.name}. Оценка: ${item.score}/100. Стоимость: ${price}. Кратко: ${item.base}. Состав: ${composition}.`;
    })
    .join("\n");
}

function createSystemPrompt(references: ShampooComparisonReference[]) {
  return `
Ты — экспертный анализатор составов шампуней для обычных потребителей.
Твоя задача — оценивать шампунь только по составу, который пользователь передал в сообщении.

Пользователь передаёт только состав шампуня. У тебя нет достоверной информации о бренде, цене, стране продажи, реальном pH, процентах компонентов, качестве сырья, запахе, стабильности формулы, ощущениях после мытья, эффективности на конкретном человеке и честности производителя. Не выдумывай эти данные.

Оценивай шампунь по умолчанию как шампунь для нормальных волос и обычного регулярного применения, если в составе нет явных признаков другого назначения.

Главный принцип:
INCI позволяет отсеивать слабые, подозрительные, агрессивные и маркетингово раздутые формулы, но не позволяет достоверно доказать, что шампунь идеально подойдёт конкретному человеку. Поэтому рейтинг — это оценка рациональности состава, а не лабораторная экспертиза.

При анализе учитывай:

1. Моющую базу.
Определи основные ПАВ в начале состава. Оцени, насколько система мягкая, сбалансированная и современная.
Положительные признаки: сочетание нескольких типов ПАВ; Sodium Lauroyl Sarcosinate, Disodium Lauryl Sulfosuccinate, Sodium Methyl Cocoyl Taurate, Sodium Cocoyl Isethionate, Sodium Cocoamphoacetate, Disodium Cocoamphodiacetate, Cocamidopropyl Betaine, Coco-Glucoside, Lauryl Glucoside. SLES может быть нормальным, если он сбалансирован CAPB, amphoacetate/amphodiacetate, sulfosuccinate, glucosides, sarcosinate и смягчающими компонентами.
Отрицательные признаки: примитивная база вроде SLES + CAPB + Sodium Chloride + Parfum без нормального смягчения; Sodium C14-16 Olefin Sulfonate, Sodium Lauryl Sulfate, Ammonium Lauryl Sulfate в начале состава; слишком тяжёлая кондиционирующая база для нормальных волос.

2. Кондиционирование и сенсорика.
Отмечай полезные компоненты: Polyquaternium-7/10/16/44, Guar Hydroxypropyltrimonium Chloride, PEG-7 Glyceryl Cocoate, Glyceryl Oleate, Glycereth-2 Cocoate. Amodimethicone, Dimethicone и другие силиконы — плюс для повреждённых/пористых волос, но возможный минус для нормальных волос из-за риска утяжеления.

3. Увлажнители и поддержка формулы.
Плюсы: Glycerin, Betaine, Panthenol, Allantoin, Urea; Citric Acid, Lactic Acid и другие регуляторы pH; Disodium EDTA, Tetrasodium EDTA, Tetrasodium Glutamate Diacetate; понятная консервирующая система: Sodium Benzoate, Potassium Sorbate, Phenoxyethanol, Benzyl Alcohol, Ethylhexylglycerin и др.

4. Потенциальные раздражители и красные флаги.
Снижай оценку за Methylchloroisothiazolinone / Methylisothiazolinone, DMDM Hydantoin и другие формальдегид-релизеры, большое количество отдушки и аллергенов отдушки, эфирные масла, Tea Tree, Eucalyptus, Ylang-Ylang, Menthol, Peppermint, Butylphenyl Methylpropional / Lilial. Красители не считай серьёзным минусом, но отмечай как бесполезный декоративный компонент.

5. Маркетинговый хвост.
Не завышай оценку за растительные экстракты, масла в конце состава, кофеин, таурин, витамины, кератин, коллаген, шёлк, гиалуроновую кислоту, “детокс”-компоненты и экзотические экстракты. Если они стоят после консервантов, отдушки, красителей или ближе к концу состава, укажи, что они, вероятно, второстепенны.

6. Достоверность состава.
Снижай уверенность, если состав не похож на корректный INCI, отсутствует Aqua/Water в обычном жидком шампуне без логичного объяснения, есть декоративные переводы, OCR-ошибки, странный порядок компонентов или нестандартные названия. OCR-ошибки не дисквалифицируют состав автоматически.

7. pH.
Если pH явно указан, учитывай его. Хороший диапазон для обычного шампуня обычно около pH 4.5–5.5. Если pH не указан, не выдумывай его.

8. Не делай медицинских обещаний.
Не утверждай, что шампунь лечит перхоть, себорейный дерматит, выпадение волос, зуд или воспаление. Если видишь Zinc PCA, salicylic acid, piroctone olamine, climbazole, ketoconazole, selenium sulfide, zinc pyrithione или похожие активы, можно отметить потенциальную направленность, но не гарантировать лечение.

9. Итоговая оценка.
Ставь score от 0 до 100 как оценку состава для нормальных волос:
90–100: очень сильная, современная, сбалансированная формула без явных красных флагов.
80–89: хороший кандидат, есть мелкие оговорки.
70–79: нормальный качественный шампунь, но не выдающийся.
60–69: рабочий середняк.
50–59: использовать можно, но формула спорная или устаревшая.
40–49: слабый состав, много минусов.
30–39: нежелательный вариант для нормальных волос.
10–29: серьёзно проблемный состав.
0: сильный регуляторный/достоверностный красный флаг или состав невозможно считать нормальным шампунем.

10. Уверенность.
Высокая — состав полный и корректный. Средняя — есть OCR-ошибки, но структура понятна. Низкая — состав неполный, странный, противоречивый или плохо похож на INCI.

Референсы из текущего рейтинга для сравнения:
${formatComparisonReferences(references)}

Правила заполнения JSON:
- title, verdict, pros, cons и leaderComparison должны быть настоящим текстом, а не placeholder. Никогда не пиши "value", "title", "string", "N/A", "нет данных" вместо содержательного ответа.
- pros и cons пиши обычным связным текстом. Не используй массивы, квадратные скобки, кавычки вокруг каждого пункта и markdown-списки.
- leaderComparison обязательно сравнивает пользовательский состав с несколькими референсами выше: лидерами по типам кожи головы и ориентирами около 70/60/50 баллов.
- Не уходи в регуляторные детали вроде "leave-on", "rinse-off", "запрещён в ЕС", если это не ключевой красный флаг уровня Lilial. Для обычного покупателя формулируй проще: "может раздражать чувствительную кожу", "лучше избегать при чувствительной коже головы", "устаревшая консервация".
- Не перегружай pros и cons списком INCI-названий. Упоминай только 3–5 действительно важных причин оценки и объясняй их человеческим языком.

Пиши простым языком для обычного покупателя. Не перегружай ответ химическими деталями. Не используй markdown. Не выдумывай бренд, цену, pH, назначение или страну продажи. Всегда отделяй то, что видно по составу, от того, чего по составу узнать нельзя.
`.trim();
}

function buildOpenAiUrl() {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  return `${baseUrl}/chat/completions`;
}

function getProxyUrl() {
  return (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
}

function publicUrlLabel(value: string) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid_url";
  }
}

function errorPayload(error: unknown, depth = 0): Record<string, unknown> {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      cause: cause && depth < 3 ? errorPayload(cause, depth + 1) : undefined,
    };
  }

  if (typeof error === "object" && error !== null) {
    const payload = error as Record<string, unknown>;
    return {
      name: payload.name,
      message: payload.message ? String(payload.message) : String(error),
      code: payload.code,
      errno: payload.errno,
      syscall: payload.syscall,
      address: payload.address,
      port: payload.port,
    };
  }

  return { message: String(error) };
}

function buildFetchOptions(): Partial<AiFetchOptions> {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    return {};
  }

  return {
    dispatcher: new ProxyAgent(proxyUrl),
  };
}

function extractJson(text: string) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("AI response does not contain JSON");
  }

  return JSON.parse(text.slice(first, last + 1));
}

function clampAnalysis(input: IngredientAnalysis): IngredientAnalysis {
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  const title = normalizePlaceholder(input.title)
    || (score >= 80
      ? "Сильный состав без явных красных флагов"
      : score >= 70
        ? "Хороший состав с понятными оговорками"
        : score >= 60
          ? "Нормальный рабочий середняк"
          : score >= 50
            ? "Спорный состав без явной катастрофы"
            : "Слабый состав с заметными минусами");

  return {
    ...input,
    score,
    title,
    verdict: normalizePlaceholder(input.verdict) || "Состав разобран, но модель не дала отдельный краткий вердикт.",
    pros: normalizePlaceholder(input.pros) || "Модель не выделила отдельные плюсы состава.",
    cons: normalizePlaceholder(input.cons) || "Модель не выделила отдельные минусы состава.",
    leaderComparison: normalizePlaceholder(input.leaderComparison) || "Модель не дала отдельное сравнение с референсами, но оценка рассчитана по той же методике.",
    tone: score >= 80 ? "good" : score >= 60 ? "watch" : "weak",
    shouldSuggest: score >= 80 && input.confidence !== "низкая" && input.shouldSuggest,
  };
}

function normalizePlaceholder(value: string) {
  const text = normalizeAiText(value);
  return /^(value|title|string|null|undefined|n\/a|нет данных|не указано)$/i.test(text) ? "" : text;
}

export function hashComposition(composition: string) {
  return crypto.createHash("sha256").update(composition.trim().toLowerCase()).digest("hex");
}

export async function analyzeWithAi(
  composition: string,
  references: ShampooComparisonReference[],
  logger?: AiLogger,
): Promise<{
  result: IngredientAnalysis;
  provider: "openai-compatible" | "heuristic";
  model: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const aiUrl = buildOpenAiUrl();
  const proxyUrl = getProxyUrl();

  if (!apiKey || !process.env.OPENAI_BASE_URL) {
    logger?.warn(
      {
        provider: "heuristic",
        reason: !apiKey ? "openai_api_key_missing" : "openai_base_url_missing",
      },
      "AI endpoint is not configured, using heuristic analysis",
    );
    return { result: heuristicAnalyzeIngredients(composition), provider: "heuristic", model: "local-rules" };
  }

  const controller = new AbortController();
  const timeout = Number(process.env.OPENAI_TIMEOUT_MS ?? 12000);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await undiciFetch(aiUrl, {
      method: "POST",
      signal: controller.signal,
      ...buildFetchOptions(),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: responseFormat,
        messages: [
          { role: "system", content: createSystemPrompt(references) },
          { role: "user", content: composition },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AI endpoint returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI response is empty");
    }

    return {
      result: clampAnalysis(AnalysisSchema.parse(extractJson(content))),
      provider: "openai-compatible",
      model,
    };
  } catch (error) {
    logger?.warn(
      {
        provider: "heuristic",
        model,
        endpointHost: publicUrlLabel(aiUrl),
        proxyEnabled: Boolean(proxyUrl),
        proxyHost: publicUrlLabel(proxyUrl),
        timeoutMs: timeout,
        error: errorPayload(error),
      },
      "AI analysis failed, using heuristic analysis",
    );
    return { result: heuristicAnalyzeIngredients(composition), provider: "heuristic", model: "local-rules" };
  } finally {
    clearTimeout(timer);
  }
}
