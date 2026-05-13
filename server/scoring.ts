import type { IngredientAnalysis } from "./types.js";

type IngredientRule = {
  tokens: string[];
  title: string;
  note: string;
  delta: number;
  kind: "good" | "neutral" | "risk";
};

const rules: IngredientRule[] = [
  {
    tokens: ["sodium cocoyl glutamate", "sodium methyl cocoyl taurate", "sodium cocoyl isethionate", "кокоил глутамат", "метил кокоил таурат", "кокоил изетионат"],
    title: "мягкие анионные ПАВы",
    note: "хороший сигнал современной мягкой системы очищения",
    delta: 12,
    kind: "good",
  },
  {
    tokens: ["disodium laureth sulfosuccinate", "sodium lauroyl sarcosinate", "sodium lauroamphoacetate", "disodium cocoamphodiacetate", "сульфосукцинат", "лауроил саркозинат", "лауроамфоацетат", "кокоамфодиацетат"],
    title: "балансирующие ко-ПАВы",
    note: "часто делают систему мягче и технологичнее",
    delta: 9,
    kind: "good",
  },
  {
    tokens: ["coco-glucoside", "decyl glucoside", "lauryl glucoside", "caprylyl/capryl glucoside", "коко-глюкозид", "децил глюкозид", "лаурил глюкозид"],
    title: "глюкозиды",
    note: "плюс для sulfate-free и mild-формул",
    delta: 8,
    kind: "good",
  },
  {
    tokens: ["cocamidopropyl betaine", "кокамидопропил бетаин", "кокамидопропилбетаин"],
    title: "CAPB",
    note: "смягчает анионную базу и помогает пене, но качество сырья не видно по INCI",
    delta: 6,
    kind: "good",
  },
  {
    tokens: ["polyquaternium-10", "polyquaternium-7", "polyquaternium-44", "guar hydroxypropyltrimonium chloride", "поликватерниум", "гидроксипропилтримониум хлорид"],
    title: "кондиционирующие полимеры",
    note: "реальный сигнал расчесывания и снижения трения",
    delta: 7,
    kind: "good",
  },
  {
    tokens: ["amodimethicone", "bis-aminopropyl dimethicone", "dimethiconol", "амодиметикон", "диметиконол"],
    title: "силиконовое кондиционирование",
    note: "полезно для поврежденных, окрашенных и пористых волос",
    delta: 5,
    kind: "good",
  },
  {
    tokens: ["disodium edta", "tetrasodium edta", "sodium phytate", "динатриевая эдта", "фитат натрия"],
    title: "хелатор",
    note: "помогает стабильности и работе формулы в жесткой воде",
    delta: 5,
    kind: "good",
  },
  {
    tokens: ["phenoxyethanol", "sodium benzoate", "potassium sorbate", "benzyl alcohol", "феноксиэтанол", "бензоат натрия", "сорбат калия", "бензиловый спирт"],
    title: "реалистичная консервация",
    note: "для водного шампуня защита от микробов является плюсом, а не минусом",
    delta: 4,
    kind: "good",
  },
  {
    tokens: ["sodium laureth sulfate", "лауретсульфат натрия", "натрия лауретсульфат"],
    title: "SLES",
    note: "рабочий промежуточный вариант: итог зависит от ко-ПАВ и кондиционирования",
    delta: 1,
    kind: "neutral",
  },
  {
    tokens: ["citric acid", "lactic acid", "sodium hydroxide", "лимонная кислота", "молочная кислота", "гидроксид натрия"],
    title: "регулятор pH",
    note: "показывает настройку pH, но не раскрывает финальное значение",
    delta: 0,
    kind: "neutral",
  },
  {
    tokens: ["sodium lauryl sulfate", "ammonium lauryl sulfate", "лаурилсульфат натрия", "натрия лаурилсульфат", "лаурилсульфат аммония"],
    title: "SLS/ALS высоко в системе",
    note: "часто сильнее очищают и чаще сушат или раздражают",
    delta: -14,
    kind: "risk",
  },
  {
    tokens: ["methylisothiazolinone", "methylchloroisothiazolinone", "dmdm hydantoin", "imidazolidinyl urea", "diazolidinyl urea", "метилизотиазолинон", "метилхлороизотиазолинон"],
    title: "спорные сенсибилизаторы",
    note: "не лучший сигнал для универсального шампуня и чувствительной кожи",
    delta: -12,
    kind: "risk",
  },
  {
    tokens: ["menthol", "peppermint oil", "eucalyptus oil", "tea tree oil", "ментол", "масло мяты", "масло эвкалипта", "масло чайного дерева"],
    title: "ментол или эфирные масла",
    note: "могут нравиться сенсорно, но повышают риск реакции",
    delta: -7,
    kind: "risk",
  },
  {
    tokens: ["parfum", "fragrance", "limonene", "linalool", "citral", "geraniol", "coumarin", "отдушка", "ароматизатор", "лимонен", "линалоол", "цитраль", "гераниол", "кумарин"],
    title: "отдушка и аллергены",
    note: "обычный, но важный риск-фактор для чувствительной кожи головы",
    delta: -5,
    kind: "risk",
  },
  {
    tokens: ["ci 19140", "ci 42090", "ci 17200", "ci 15985"],
    title: "красители",
    note: "почти не помогают качеству шампуня, чаще просто декоративный хвост",
    delta: -3,
    kind: "risk",
  },
];

function normalize(text: string) {
  return text.toLowerCase().replace(/[ё]/g, "е").replace(/\s+/g, " ").trim();
}

function hasAny(source: string, tokens: string[]) {
  return tokens.some((token) => source.includes(token));
}

function uniqueNotes(items: IngredientRule[]) {
  return items
    .filter((rule, index, arr) => arr.findIndex((item) => item.title === rule.title) === index)
    .map((rule) => rule.note);
}

export function heuristicAnalyzeIngredients(input: string): IngredientAnalysis {
  const source = normalize(input);

  if (source.length < 20) {
    return {
      score: 0,
      title: "Жду состав",
      verdict: "Жду состав",
      tone: "empty",
      confidence: "низкая",
      shampooType: "подозрительный состав",
      pros: "",
      cons: "Состава пока недостаточно для оценки.",
      leaderComparison: "",
      shouldSuggest: false,
    };
  }

  const matched = rules.filter((rule) => hasAny(source, rule.tokens));
  const foundGoodRules = matched.filter((rule) => rule.kind === "good");
  const foundRiskRules = matched.filter((rule) => rule.kind === "risk");
  const foundNeutralRules = matched.filter((rule) => rule.kind === "neutral");
  const foundGood = uniqueNotes(foundGoodRules);
  const foundRisk = uniqueNotes(foundRiskRules);
  const foundNeutral = uniqueNotes(foundNeutralRules);
  const rawScore = 54 + matched.reduce((sum, rule) => sum + rule.delta, 0);
  const score = Math.max(18, Math.min(94, rawScore));
  const matchedTitles = matched.map((rule) => rule.title);
  const hasSurfactant = matchedTitles.some((title) => ["мягкие анионные ПАВы", "балансирующие ко-ПАВы", "глюкозиды", "CAPB", "SLES", "SLS/ALS высоко в системе"].includes(title));
  const hasPreservative = matchedTitles.includes("реалистичная консервация");
  const hasConditioning = matchedTitles.some((title) => ["кондиционирующие полимеры", "силиконовое кондиционирование"].includes(title));
  const missing = [
    !hasSurfactant ? "понятная система ПАВ" : "",
    !hasPreservative ? "видимая консервация" : "",
    !hasConditioning ? "кондиционирующая логика" : "",
  ].filter(Boolean);

  if (score >= 76 && foundRisk.length <= 1) {
    return {
      score,
      title: "Похоже на хороший вариант",
      verdict: "Похоже на сильный состав",
      tone: "good",
      confidence: "средняя",
      shampooType: "универсальный",
      pros: foundGood.join(" "),
      cons: foundRisk.length > 0 ? foundRisk.join(" ") : "Явных серьезных минусов по словарю не видно.",
      leaderComparison: "По локальным правилам состав выглядит достаточно сильным, чтобы сравнивать его с текущими лидерами.",
      shouldSuggest: true,
    };
  }

  if (score >= 58) {
    return {
      score,
      title: "Нужна ручная проверка",
      verdict: "Нужна ручная проверка",
      tone: "watch",
      confidence: "средняя",
      shampooType: foundRisk.length > 1 ? "маркетингово перегруженный" : "универсальный",
      pros: foundGood.length > 0 ? foundGood.join(" ") : "Есть рабочие компоненты, но сильных преимуществ по локальным правилам мало.",
      cons: [...foundRisk, ...foundNeutral, ...missing.map((item) => `Не видно: ${item}.`)].join(" "),
      leaderComparison: "Пока это скорее кандидат для сравнения, чем очевидный лидер.",
      shouldSuggest: foundGood.length >= 3 && foundRisk.length <= 2,
    };
  }

  return {
    score,
    title: "Слабый или рискованный вариант",
    verdict: "Слабый или рискованный сигнал",
    tone: "weak",
    confidence: "средняя",
    shampooType: "не рекомендуется",
    pros: foundGood.length > 0 ? foundGood.join(" ") : "Сильных плюсов по локальным правилам не видно.",
    cons: foundRisk.length > 0 ? foundRisk.join(" ") : "Состав выглядит неполным или малоинформативным.",
    leaderComparison: "До текущих лидеров рейтинга по понятности и балансу состава не дотягивает.",
    shouldSuggest: false,
  };
}
