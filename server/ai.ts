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
type AiProvider = "openai" | "anthropic";
type AiProviderRole = "primary" | "fallback";
type AiProviderConfig = {
  provider: AiProvider;
  role: AiProviderRole;
  apiKey: string;
  baseUrl: string;
  model: string;
};

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
  score: z.number().int().min(0).max(100),
});

const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
    score: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Итоговая оценка состава от 0 до 100. Заполняй строго последней, только после title, verdict, tone, confidence, shampooType, pros, cons и leaderComparison.",
    },
  },
  required: [
    "title",
    "verdict",
    "tone",
    "confidence",
    "shampooType",
    "pros",
    "cons",
    "leaderComparison",
    "score",
  ],
} as const;

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "shampoo_analysis",
    strict: true,
    schema: analysisJsonSchema,
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

Оценивай справедливо и сравнительно. Не награждай формулу за количество красивых слов в составе и не штрафуй минималистичную формулу только за то, что в ней нет пантенола, ниацинамида, масел, экстрактов, кератина, витаминов или гиалуроновой кислоты. В шампуне эти компоненты часто второстепенны, особенно если стоят ближе к концу состава. Чистая короткая формула без отдушки и красных флагов может заслуживать более высокий балл, чем более «богатая» формула с раздражителями, маркетинговым хвостом или сомнительной базой.

Ключевая выжимка исследования, которую нужно применять всегда:
- Главный вес имеют первые 5–8 компонентов состава. В INCI ингредиенты выше 1% обычно идут по убыванию концентрации, а ингредиенты ниже 1% могут располагаться свободнее. Поэтому компоненты после консервантов, отдушки, красителей или аллергенов отдушки обычно не должны сильно повышать оценку.
- Оценивай не отдельные «хорошие» или «плохие» ингредиенты, а архитектуру формулы: моющая база, смягчение ПАВ, кондиционирование, pH/кислотность, консервация, раздражители, достоверность состава.
- При конфликте факторов используй такой приоритет: моющая база и баланс ПАВ > сильные красные флаги и раздражители > достоверность/полнота INCI > функциональное кондиционирование > pH и поддержка формулы > второстепенные активы и экстракты.
- SLES не является автоматическим минусом. Хорошая SLES-формула с CAPB, sulfosuccinate, amphoacetate/amphodiacetate, glucosides, sarcosinate, polyquaternium/cationic guar и нормальным pH может быть сильным универсальным шампунем. Но SLES + соль + отдушка + слабое смягчение — бюджетная и слабая архитектура.
- «Без сульфатов» не равно автоматически мягче и лучше. Если вместо сульфатов высоко стоит Sodium C14-16 Olefin Sulfonate, Sodium Coco-Sulfate или другая сильная моющая база, формула может быть жёстче, чем хорошо сбалансированный SLES-шампунь.
- Мягкая sulfate-free формула на sarcosinate, sulfosuccinate, taurate, isethionate, glutamate, amphoacetate, betaine и glucosides может получать высокий score, даже если состав короткий и без «уходового» хвоста.
- Отсутствие отдушки, эфирных масел, красителей и растительных экстрактов — не минус. Для чувствительной кожи это часто преимущество. Для обычного пользователя это может быть только субъективным минусом по аромату, но не минусом качества состава.
- Экстракты, витамины, кофеин, таурин, кератин, коллаген, шёлк, гиалуроновая кислота и масла в шампуне обычно имеют ограниченный вес в оценке, особенно если стоят ближе к концу. Они не должны компенсировать слабую ПАВ-базу, раздражители или подозрительный INCI.
- pH около 4.5–5.5 — полезный плюс, если он заявлен. Но отсутствие pH не должно сильно снижать оценку хорошей формулы. pH особенно важен при Sodium Benzoate/Potassium Sorbate, потому что такая консервация логичнее в кислой среде.
- Cocamide DEA — устаревший и нежелательный маркер, особенно если стоит высоко, но не автоматический ноль. Cocamide MEA/MIPA обычно менее серьёзный минус, но тоже не преимущество.
- MCI/MI, DMDM Hydantoin, Lilial, сильная отдушка, эфирные масла, ментол и избыток аллергенов отдушки снижают оценку не потому, что продукт обязательно «опасен», а потому что повышают риск раздражения/устарелости/регуляторного или репутационного красного флага.
- Высокий score означает хорошую рациональность состава, а не гарантию индивидуальной переносимости. Мягкий шампунь может плохо промывать очень жирную кожу головы, а сильный очищающий шампунь может быть уместен для oily, но хуже для normal/sensitive.
- Маркетинговые заявления проверяй отдельно от состава. «От перхоти», «против выпадения», «для роста», «детокс», «профессиональный», «2в1», «гипоаллергенный» и «без сульфатов» не принимаются на веру. Если в INCI нет видимых оснований, пиши: «по указанному INCI заявление выглядит слабо подтверждённым», а не обвиняй производителя.
- Составы из карточек маркетплейсов и OCR могут быть устаревшими или ошибочными. Если видишь странный порядок, отсутствующую воду, опечатки, декоративные переводы или разные версии состава, снижай уверенность и уточняй, что оценка применима только к указанной версии INCI.
- Не приравнивай мягкую ПАВ-базу к слабой моющей способности. По INCI можно предположить более деликатное очищение, но нельзя уверенно утверждать, что шампунь плохо промывает: неизвестны концентрации ПАВ, pH, солюбилизация, вязкость, жёсткость воды и реальные тесты применения. Формулируй осторожно: «может быть мягче и хуже подходить для масляных масок, плотного стайлинга или очень жирной кожи головы», а не «низкая моющая мощность».
- Citric Acid, Lactic Acid и другие кислоты не позволяют вычислить pH. Они только показывают, что формула, вероятно, подкислена или отрегулирована. Не пиши «pH около 5.0–5.5», если pH явно не указан. Пиши: «pH не указан; наличие Citric Acid косвенно намекает на регулировку кислотности».
- Не называй шампунь подходящим для детей, аллергиков, беременных, людей с дерматитом или заболеваниями кожи, если это прямо не заявлено и не подтверждено отдельными данными. По INCI можно сказать только: «формула выглядит более щадящей для чувствительной кожи», «без отдушки», «меньше очевидных раздражителей».
- Всегда разделяй score для нормальных волос и функциональную роль продукта. Формула может быть отличной для sensitive, но не идеальной для oily; хорошей для oily, но спорной для sensitive; полезной как периодическое сильное очищение, но не как ежедневный шампунь. Не снижай score чрезмерно только за то, что продукт не закрывает все сценарии сразу. Укажи ограничение в type, fit и caution.
- Если высоко стоят жирные спирты, катионные кондиционеры, силиконы, масла, Steartrimonium Chloride или Cetrimonium Chloride, не считай это автоматически плюсом. Для повреждённых, сухих или пористых волос это может улучшать гладкость, но для нормальных волос повышает риск утяжеления, налёта и ощущения недомытости.
- При нормализации INCI исправляй очевидные OCR-ошибки только если ингредиент легко распознаётся. Если название сомнительно, не превращай его в уверенный ингредиент: сохрани осторожную формулировку, выбери наиболее вероятную версию только при высокой уверенности или снизь confidence.

При анализе учитывай:

1. Моющую базу.
Определи основные ПАВ в начале состава. Оцени, насколько система мягкая, сбалансированная и современная.
Положительные признаки: сочетание нескольких типов ПАВ; Sodium Lauroyl Sarcosinate, Disodium Lauryl Sulfosuccinate, Sodium Methyl Cocoyl Taurate, Sodium Cocoyl Isethionate, Sodium Cocoyl Glutamate, Sodium Lauroamphoacetate, Sodium Cocoamphoacetate, Disodium Cocoamphodiacetate, Cocamidopropyl Betaine, Coco-Glucoside, Decyl Glucoside, Lauryl Glucoside. SLES может быть нормальным, если он сбалансирован CAPB, amphoacetate/amphodiacetate, sulfosuccinate, glucosides, sarcosinate и смягчающими компонентами.
Отрицательные признаки: примитивная база вроде SLES + CAPB + Sodium Chloride + Parfum без нормального смягчения; Sodium C14-16 Olefin Sulfonate, Sodium Lauryl Sulfate, Ammonium Lauryl Sulfate в начале состава; слишком тяжёлая кондиционирующая база для нормальных волос.

2. Кондиционирование и сенсорика.
Отмечай функциональные компоненты, которые реально могут улучшать скольжение и расчёсывание: Polyquaternium-7/10/16/44, Guar Hydroxypropyltrimonium Chloride, PEG-7 Glyceryl Cocoate, Glyceryl Oleate, Glycereth-2 Cocoate. Amodimethicone, Dimethicone и другие силиконы — плюс для повреждённых/пористых волос, но возможный минус для нормальных волос из-за риска утяжеления.
Не считай отсутствие насыщенного кондиционирующего блока серьёзным минусом автоматически. Для нормальных волос и чувствительной кожи лёгкая формула может быть предпочтительнее. Если кондиционирования мало, формулируй это как ограничение по сенсорике или сухим/повреждённым волосам, а не как дефект состава.

3. Увлажнители и поддержка формулы.
Плюсы: Glycerin, Betaine, Panthenol, Allantoin, Urea; Citric Acid, Lactic Acid и другие регуляторы pH; Disodium EDTA, Tetrasodium EDTA, Tetrasodium Glutamate Diacetate; понятная консервирующая система: Sodium Benzoate, Potassium Sorbate, Phenoxyethanol, Benzyl Alcohol, Ethylhexylglycerin и др.
Не называй консервацию «надёжной» без оговорки, если её эффективность зависит от pH, а pH не указан. Лучше писать: «консервация выглядит логичной при кислой pH-среде» или «pH не указан, поэтому оценка консервации ограничена».

4. Потенциальные раздражители и красные флаги.
Снижай оценку за Methylchloroisothiazolinone / Methylisothiazolinone, DMDM Hydantoin и другие формальдегид-релизеры, большое количество отдушки и аллергенов отдушки, эфирные масла, Tea Tree, Eucalyptus, Ylang-Ylang, Menthol, Peppermint, Butylphenyl Methylpropional / Lilial. Красители не считай серьёзным минусом, но отмечай как бесполезный декоративный компонент.
Отсутствие отдушки не является минусом для качества состава. Это плюс для чувствительной кожи и нейтральная/субъективная особенность для обычного пользователя.

5. Маркетинговый хвост.
Не завышай оценку за растительные экстракты, масла в конце состава, кофеин, таурин, витамины, кератин, коллаген, шёлк, гиалуроновую кислоту, «детокс»-компоненты и экзотические экстракты. Если они стоят после консервантов, отдушки, красителей или ближе к концу состава, укажи, что они, вероятно, второстепенны.
Не штрафуй формулу за отсутствие таких компонентов. Отсутствие маркетингового хвоста часто повышает прозрачность состава.

6. Достоверность состава.
Снижай уверенность, если состав не похож на корректный INCI, отсутствует Aqua/Water в обычном жидком шампуне без логичного объяснения, есть декоративные переводы, OCR-ошибки, странный порядок компонентов или нестандартные названия. OCR-ошибки не дисквалифицируют состав автоматически.

7. pH.
Если pH явно указан, учитывай его. Хороший диапазон для обычного шампуня обычно около pH 4.5–5.5. Если pH не указан, не выдумывай его и не наказывай формулу слишком сильно только за отсутствие pH, если остальные признаки хорошие. Но pH может быть важен для оценки кислотозависимой консервации и общей предсказуемости.

8. Не делай медицинских обещаний.
Не утверждай, что шампунь лечит перхоть, себорейный дерматит, выпадение волос, зуд или воспаление. Если видишь Zinc PCA, salicylic acid, piroctone olamine, climbazole, ketoconazole, selenium sulfide, zinc pyrithione или похожие активы, можно отметить потенциальную направленность, но не гарантировать лечение. Если активов для заявленного эффекта не видно, формулируй мягко: «по указанному INCI заявление выглядит слабо подтверждённым».

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

10. Сравнительная калибровка оценки.
Референсы ниже — это шкала текущего рейтинга. Оценивай новый состав относительно них, а не в вакууме.
Если новый состав явно чище, мягче и безопаснее по раздражителям, чем референс с похожей задачей, он должен получить такой же или более высокий score.
Разница 1–3 балла означает почти один уровень, а не доказанное превосходство. Существенной считай разницу примерно от 5 баллов.
Ты дальше увидишь оценки уже текущих лидеров и аутсайдеров. Определи, где среди них достоен быть твой текущий рассматриваемый состав по оценке.
Не поднимай оценку за экстракты, витамины, масла, «детокс», кофеин, кератин или большое количество ингредиентов - всё, что не делает шампунь лучше, должно просто игнорироваться.

11. Уверенность.
Высокая — состав полный и корректный. Средняя — есть OCR-ошибки, но структура понятна. Низкая — состав неполный, странный, противоречивый или плохо похож на INCI.

Референсы из текущего рейтинга для сравнения:
${formatComparisonReferences(references)}

Правила заполнения JSON:
- title, verdict, pros, cons и leaderComparison должны быть настоящим текстом, а не placeholder. Никогда не пиши "value", "title", "string", "N/A", "нет данных" вместо содержательного ответа.
- pros и cons пиши обычным связным текстом. Не используй массивы, квадратные скобки, кавычки вокруг каждого пункта и markdown-списки.
- leaderComparison обязательно сравнивает пользовательский состав с несколькими референсами выше: лидерами по типам кожи головы и ориентирами около 70/60/50 баллов.
- В leaderComparison явно объясняй, почему score поставлен выше, ниже или рядом с конкретными фаворитами. Не ограничивайся словами «проигрывает в сенсорике» — уточняй, насколько это важно для рейтинга состава.
- Решение о предложении отправить шампунь в общий рейтинг принимает сайт по итоговому score. Не добавляй в JSON отдельное поле для этого решения.
- Не называй отсутствие пантенола, ниацинамида, масел, экстрактов, отдушки или витаминов главным минусом, если формула и без них технологически чистая и логичная. Это можно указать только как ограничение для сухих/повреждённых волос или для пользователя, которому важен аромат/косметическая сенсорика.
- Не уходи в регуляторные детали вроде "leave-on", "rinse-off", "запрещён в ЕС", если это не ключевой красный флаг уровня Lilial. Для обычного покупателя формулируй проще: "может раздражать чувствительную кожу", "лучше избегать при чувствительной коже головы", "устаревшая консервация".
- Не перегружай pros и cons списком INCI-названий. Упоминай только 3–5 действительно важных причин оценки и объясняй их человеческим языком.

Пиши простым языком для обычного покупателя. Не перегружай ответ химическими деталями. Не используй markdown. Не выдумывай бренд, цену, pH, назначение или страну продажи. Всегда отделяй то, что видно по составу, от того, чего по составу узнать нельзя.
`.trim();
}

function buildAnthropicUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/messages`;
}

function normalizedProvider(value: string | undefined, fallback: AiProvider): AiProvider {
  const normalized = value?.trim().toLowerCase();
  return normalized === "anthropic" || normalized === "openai" ? normalized : fallback;
}

function getProviderConfig(provider: AiProvider, role: AiProviderRole): AiProviderConfig | null {
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
    const baseUrl = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";
    return apiKey ? { provider, role, apiKey, baseUrl, model } : null;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  return apiKey && baseUrl ? { provider, role, apiKey, baseUrl, model } : null;
}

function getProviderChain(logger?: AiLogger) {
  const primaryProvider = normalizedProvider(process.env.AI_PROVIDER, "openai");
  const fallbackName = process.env.AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  const fallbackProvider = fallbackName && fallbackName !== "none"
    ? normalizedProvider(fallbackName, primaryProvider === "openai" ? "anthropic" : "openai")
    : null;
  const configs = [
    getProviderConfig(primaryProvider, "primary"),
    fallbackProvider ? getProviderConfig(fallbackProvider, "fallback") : null,
  ].filter((config): config is AiProviderConfig => Boolean(config));

  if (configs.length === 0) {
    logger?.warn(
      {
        provider: "heuristic",
        primaryProvider,
        fallbackProvider: fallbackProvider ?? "none",
        reason: "ai_providers_not_configured",
      },
      "AI providers are not configured, using heuristic analysis",
    );
  }

  return configs;
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

function clampAnalysis(input: Omit<IngredientAnalysis, "shouldSuggest">): IngredientAnalysis {
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
    shouldSuggest: score >= 74,
  };
}

function fallbackAnalysis(composition: string): IngredientAnalysis {
  return {
    ...heuristicAnalyzeIngredients(composition),
    shouldSuggest: false,
  };
}

function normalizePlaceholder(value: string) {
  const text = normalizeAiText(value);
  return /^(value|title|string|null|undefined|n\/a|нет данных|не указано)$/i.test(text) ? "" : text;
}

export function hashComposition(composition: string) {
  return crypto.createHash("sha256").update(composition.trim()).digest("hex");
}

async function fetchTextSnippet(response: { text: () => Promise<string> }) {
  const body = await response.text().catch(() => "");
  return body ? `: ${body.slice(0, 800)}` : "";
}

async function callOpenAiProvider(params: {
  config: AiProviderConfig;
  composition: string;
  systemPrompt: string;
  signal: AbortSignal;
}) {
  const aiUrl = `${params.config.baseUrl}/chat/completions`;
  const response = await undiciFetch(aiUrl, {
    method: "POST",
    signal: params.signal,
    ...buildFetchOptions(),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.config.apiKey}`,
    },
    body: JSON.stringify({
      model: params.config.model,
      temperature: 0.1,
      response_format: responseFormat,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.composition },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible endpoint returned ${response.status}${await fetchTextSnippet(response)}`);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI-compatible response is empty");
  }

  return {
    analysis: extractJson(content),
    rawResponse: payload,
  };
}

async function callAnthropicProvider(params: {
  config: AiProviderConfig;
  composition: string;
  systemPrompt: string;
  signal: AbortSignal;
}) {
  const aiUrl = buildAnthropicUrl(params.config.baseUrl);
  const response = await undiciFetch(aiUrl, {
    method: "POST",
    signal: params.signal,
    ...buildFetchOptions(),
    headers: {
      "content-type": "application/json",
      "x-api-key": params.config.apiKey,
      "anthropic-version": process.env.ANTHROPIC_VERSION?.trim() || "2023-06-01",
    },
    body: JSON.stringify({
      model: params.config.model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 1800),
      temperature: 0.1,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.composition }],
      tools: [
        {
          name: "return_shampoo_analysis",
          description: "Return the shampoo analysis as structured JSON.",
          input_schema: analysisJsonSchema,
        },
      ],
      tool_choice: { type: "tool", name: "return_shampoo_analysis" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic endpoint returned ${response.status}${await fetchTextSnippet(response)}`);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }> };
  const toolUse = payload.content?.find((item) => item.type === "tool_use" && item.name === "return_shampoo_analysis");
  if (toolUse?.input) {
    return {
      analysis: toolUse.input,
      rawResponse: payload,
    };
  }

  const text = payload.content?.find((item) => item.type === "text" && item.text)?.text;
  if (text) {
    return {
      analysis: extractJson(text),
      rawResponse: payload,
    };
  }

  throw new Error("Anthropic response does not contain tool_use input");
}

async function callAiProvider(params: {
  config: AiProviderConfig;
  composition: string;
  systemPrompt: string;
  signal: AbortSignal;
}) {
  return params.config.provider === "anthropic"
    ? callAnthropicProvider(params)
    : callOpenAiProvider(params);
}

function providerEndpoint(config: AiProviderConfig) {
  return config.provider === "anthropic"
    ? buildAnthropicUrl(config.baseUrl)
    : `${config.baseUrl}/chat/completions`;
}

export async function analyzeWithAi(
  composition: string,
  references: ShampooComparisonReference[],
  logger?: AiLogger,
): Promise<{
  result: IngredientAnalysis;
  provider: string;
  model: string;
  rawResponse: unknown;
}> {
  const proxyUrl = getProxyUrl();
  const providers = getProviderChain(logger);
  const systemPrompt = createSystemPrompt(references);
  const timeout = Number(process.env.AI_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS ?? 12000);

  if (providers.length === 0) {
    return { result: fallbackAnalysis(composition), provider: "heuristic", model: "local-rules", rawResponse: null };
  }

  for (const config of providers) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const rawResult = await callAiProvider({
        config,
        composition,
        systemPrompt,
        signal: controller.signal,
      });
      const parsed = clampAnalysis(AnalysisSchema.parse(rawResult.analysis));
      logger?.info?.(
        {
          provider: config.provider,
          providerRole: config.role,
          model: config.model,
          endpointHost: publicUrlLabel(providerEndpoint(config)),
          proxyEnabled: Boolean(proxyUrl),
          proxyHost: publicUrlLabel(proxyUrl),
          durationMs: Date.now() - startedAt,
          score: parsed.score,
        },
        "AI analysis succeeded",
      );

      clearTimeout(timer);
      return {
        result: parsed,
        provider: config.provider,
        model: config.model,
        rawResponse: rawResult.rawResponse,
      };
    } catch (error) {
      logger?.warn(
        {
          provider: config.provider,
          providerRole: config.role,
          model: config.model,
          endpointHost: publicUrlLabel(providerEndpoint(config)),
          proxyEnabled: Boolean(proxyUrl),
          proxyHost: publicUrlLabel(proxyUrl),
          timeoutMs: timeout,
          durationMs: Date.now() - startedAt,
          error: errorPayload(error),
        },
        "AI provider failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  logger?.warn({ provider: "heuristic" }, "All AI providers failed, using heuristic analysis");
  return { result: fallbackAnalysis(composition), provider: "heuristic", model: "local-rules", rawResponse: null };
}
