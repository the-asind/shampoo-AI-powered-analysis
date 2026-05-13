import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, CheckCircle2, ChevronDown, CircleHelp, Copy, Lock, RefreshCw, Search, Trash2 } from "lucide-react";
import { mockShampoos } from "./server/mock-data";

declare global {
  interface Window {
    grecaptcha?: {
      ready: (callback: () => void) => void;
      execute: (siteKey: string, options: { action: string }) => Promise<string>;
    };
  }
}

type Audience = "normal" | "oily" | "sensitive";

type Shampoo = {
  id: number;
  name: string;
  brandNote: string;
  score: number;
  price: number;
  fit: string[];
  base: string;
  verdict: string;
  signals: string[];
  caution: string;
  inci?: string;
};

type Analysis = {
  score: number;
  title: string;
  verdict: string;
  tone: "good" | "watch" | "weak" | "empty";
  confidence: "высокая" | "средняя" | "низкая";
  shampooType: string;
  pros: string;
  cons: string;
  leaderComparison: string;
  shouldSuggest: boolean;
};

type AdminSummary = {
  totals: {
    visits: number;
    uniqueVisitors: number;
    analyses: number;
    submissions: number;
    pendingSubmissions: number;
    visitsToday: number;
    analysesToday: number;
  };
  daily: Array<{ day: string; visits: number; analyses: number; submissions: number }>;
  providerBreakdown: Array<{ provider: string; count: number }>;
  scoreBuckets: Array<{ bucket: number; count: number }>;
};

type AdminAnalysis = {
  id: number;
  composition: string;
  result: Analysis | null;
  rawResponse: unknown;
  provider: string;
  model: string;
  promptVersion: string;
  createdAt: string;
};

type AdminSubmission = {
  id: number;
  name: string;
  sourceUrl: string;
  composition: string;
  analysis: Analysis | null;
  status: string;
  createdAt: string;
};

const fallbackShampoos: Shampoo[] = mockShampoos;
const fallbackInciById = new Map(fallbackShampoos.map((item) => [item.id, item.inci ?? ""]));

const tabs: { id: Audience; label: string; helper: string }[] = [
  { id: "normal", label: "Обычная", helper: "кожа головы не зудит, не жирнится слишком быстро" },
  { id: "oily", label: "Жирная", helper: "кожа головы быстро теряет свежесть у корней" },
  { id: "sensitive", label: "Чувствительная", helper: "кожа головы реагирует зудом, сухостью или раздражением" },
];

const emptyAnalysis: Analysis = {
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

const examples: Array<{ composition: string; analysis: Analysis }> = [
  {
    composition: "Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Sodium Chloride, Polyquaternium-10, Phenoxyethanol, Citric Acid, Parfum",
    analysis: {
      score: 61,
      title: "Нормальный базовый шампунь без явного мусора",
      verdict: "Рабочий простой шампунь для нормальных волос, но не лидер. Подойдёт как недорогая базовая формула, если кожа головы нормально переносит SLES и отдушку.",
      tone: "watch",
      confidence: "высокая",
      shampooType: "универсальный",
      pros: "Состав короткий и понятный: SLES дополнен Cocamidopropyl Betaine, есть Polyquaternium-10 для скольжения, нормальный консервант Phenoxyethanol и регулятор pH Citric Acid. Нет MCI/MI, Cocamide DEA, DMDM Hydantoin, красителей и перегруженного маркетингового хвоста.",
      cons: "ПАВ-база простая: фактически SLES, CAPB и соль. Нет дополнительных мягких ПАВ вроде sulfosuccinate, sarcosinate, amphoacetate или glucoside-блока. Sodium Chloride стоит высоко, pH не указан, есть отдушка.",
      leaderComparison: "Заметно слабее лидеров вроде Yves Rocher, Metodologia, EASY и старого удачного FABRIK: там либо мягче ПАВ-база, либо лучше баланс, либо есть pH 5.5/отсутствие отдушки. Это скорее крепкий середняк.",
      shouldSuggest: false,
    },
  },
  {
    composition: "Aqua, Decyl Glucoside, Sodium Cocoyl Glutamate, Sodium Lauroamphoacetate, Glycerin, Guar Hydroxypropyltrimonium Chloride, Sodium Benzoate, Potassium Sorbate, Citric Acid",
    analysis: {
      score: 86,
      title: "Очень сильный мягкий sulfate-free состав",
      verdict: "Отличный кандидат для нормальных и чувствительных волос: мягкая бессульфатная база, без отдушки и без очевидных красных флагов.",
      tone: "good",
      confidence: "высокая",
      shampooType: "мягкий sulfate-free",
      pros: "Формула выглядит очень чисто: Decyl Glucoside, Sodium Cocoyl Glutamate и Sodium Lauroamphoacetate дают мягкую бессульфатную ПАВ-систему, Glycerin добавляет увлажняющий блок, Guar Hydroxypropyltrimonium Chloride улучшает скольжение, а Sodium Benzoate и Potassium Sorbate выглядят логично вместе с Citric Acid. Нет отдушки, эфирных масел, MCI/MI, Cocamide DEA, силиконов и декоративных экстрактов.",
      cons: "pH не указан, а для такой системы и консервантов он важен. Decyl Glucoside в некоторых формулах может ощущаться не идеально мягко, если pH или процент подобраны плохо. По INCI также нельзя понять реальную пену, промывание и стабильность формулы.",
      leaderComparison: "По чистоте состава это сильнее старого FABRIK и Metodologia, примерно на уровне или даже чуть выше Yves Rocher для чувствительной кожи, потому что нет отдушки. Если реальный pH около 4.5–5.5 и формула стабильная, такой состав мог бы быть лидером рейтинга.",
      shouldSuggest: true,
    },
  },
];

const authorUrl = import.meta.env.VITE_AUTHOR_URL || "#";
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY || "";

const analysisWaitMessages = [
  "Проверяю состав и собираю первичную картину.",
  "Разбираю моющую базу: насколько она мягкая и сбалансированная.",
  "Смотрю, есть ли компоненты для скольжения и более приятного ощущения волос.",
  "Проверяю потенциальные раздражители и спорные консерванты.",
  "Отделяю полезные части формулы от маркетингового хвоста.",
  "Сравниваю состав с лидерами рейтинга для разных типов кожи головы.",
  "Проверяю, не завышает ли формула ожидания за счёт красивых обещаний.",
  "Оцениваю, насколько состав похож на честный повседневный вариант.",
  "Сверяю сильные стороны состава с его заметными оговорками.",
  "Смотрю, для какой кожи головы такой шампунь выглядит наиболее уместным.",
  "Формирую короткий вывод без лишних химических подробностей.",
  "Проверяю оценку на адекватность относительно шампуней около 70, 60 и 50 баллов.",
  "Уточняю сравнение с текущими референсами, чтобы вывод был не абстрактным.",
  "Сокращаю разбор до человеческого языка: что хорошо, что стоит учесть.",
  "Проверяю, нет ли в ответе слишком резких обещаний или медицинских утверждений.",
  "Собираю итоговую оценку и уровень уверенности.",
  "Финально выравниваю плюсы, минусы и сравнение с рейтингом.",
  "Ответ почти готов: проверяю, чтобы он был понятным обычному покупателю.",
  "Запрос занял дольше обычного, но анализ всё ещё выполняется.",
  "Жду финальный ответ провайдера и держу результат в одном запросе.",
  "Если основной ответ не успеет, система попробует получить аккуратный результат другим путём.",
];

function formatPrice(price: number) {
  return price > 0 ? `${price} ₽/л` : "нет данных";
}

function getFullName(item: Shampoo) {
  return `${item.brandNote} ${item.name}`.trim();
}

function getInci(item: Shampoo) {
  return item.inci || fallbackInciById.get(item.id) || "";
}

function hydrateShampoos(items: Shampoo[]) {
  return items.map((item) => ({
    ...item,
    inci: getInci(item),
  }));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function shortText(value: string, max = 220) {
  return value.length > max ? `${value.slice(0, max).trim()}...` : value;
}

function formatRawJson(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "Сырой ответ не сохранён для этой записи.";
  }

  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function getAnalysisProgress(elapsedSeconds: number) {
  const seconds = Math.max(0, Math.min(200, elapsedSeconds));
  if (seconds <= 60) {
    return Math.round(8 + (seconds / 60) * 62);
  }

  const slowPart = 1 - Math.exp(-(seconds - 60) / 55);
  return Math.min(98, Math.round(70 + slowPart * 28));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const error = new Error(`Request failed: ${response.status}`);
    Object.assign(error, { status: response.status, payload });
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

type HttpErrorPayload = {
  error?: string;
  retryAfterSeconds?: number;
  reason?: string;
  details?: {
    reason?: string;
    score?: number | null;
    threshold?: number;
    action?: string | null;
    expectedAction?: string;
    errors?: string[];
  };
};

function isHttpError(error: unknown): error is Error & { status: number; payload?: HttpErrorPayload } {
  return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}

function formatRateLimitNotice(error: unknown) {
  if (!isHttpError(error) || error.status !== 429) {
    return "";
  }

  const retryAfterSeconds = error.payload?.retryAfterSeconds;
  if (error.payload?.reason === "daily_quota_exceeded") {
    return "Достигнут лимит: 10 запросов в сутки для этого IP.";
  }

  if (typeof retryAfterSeconds === "number") {
    return `Слишком часто. Повтори через ${retryAfterSeconds} сек.`;
  }

  return "Слишком часто. Для этого действия доступен один запрос в минуту.";
}

function formatRecaptchaNotice(error: unknown) {
  if (!isHttpError(error) || error.status !== 403 || error.payload?.error !== "recaptcha_failed") {
    return "";
  }

  const details = error.payload.details;
  if (details?.reason === "recaptcha_low_score") {
    const score = typeof details.score === "number" ? ` score ${details.score}` : "";
    const threshold = typeof details.threshold === "number" ? ` при пороге ${details.threshold}` : "";
    return `Проверка reCAPTCHA не пройдена${score}${threshold}. Обнови страницу и попробуй ещё раз.`;
  }

  if (details?.reason === "recaptcha_action_mismatch") {
    return "Проверка reCAPTCHA вернула действие не для этой формы. Обнови страницу и попробуй ещё раз.";
  }

  if (details?.reason === "recaptcha_request_error" || details?.reason === "recaptcha_verify_failed") {
    return "Не удалось проверить reCAPTCHA. Попробуй ещё раз позже.";
  }

  return "Проверка reCAPTCHA не пройдена. Обнови страницу и попробуй ещё раз.";
}

function loadRecaptchaScript(siteKey: string) {
  if (!siteKey || document.querySelector(`script[data-recaptcha-site-key="${siteKey}"]`)) {
    return;
  }

  const script = document.createElement("script");
  script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
  script.async = true;
  script.defer = true;
  script.dataset.recaptchaSiteKey = siteKey;
  document.head.appendChild(script);
}

async function getRecaptchaToken(action: "analyze" | "submit_shampoo") {
  if (!recaptchaSiteKey) {
    return "";
  }

  loadRecaptchaScript(recaptchaSiteKey);

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const wait = () => {
      if (window.grecaptcha) {
        window.grecaptcha.ready(resolve);
        return;
      }

      if (Date.now() - startedAt > 6000) {
        reject(new Error("reCAPTCHA script timeout"));
        return;
      }

      window.setTimeout(wait, 100);
    };

    wait();
  });

  return window.grecaptcha?.execute(recaptchaSiteKey, { action }) ?? "";
}

function localAnalyze(composition: string): Analysis {
  const text = composition.toLowerCase();
  if (text.trim().length < 20) {
    return emptyAnalysis;
  }

  const good: string[] = [];
  const risk: string[] = [];
  let score = 58;

  if (/(decyl glucoside|coco-glucoside|sodium cocoyl glutamate|taurate|isethionate|sulfosuccinate|lauroamphoacetate)/.test(text)) {
    good.push("Моющая база выглядит мягкой и не слишком грубой для регулярного использования.");
    score += 16;
  }

  if (/(cocamidopropyl betaine|polyquaternium|guar hydroxypropyltrimonium|amodimethicone|dimethiconol)/.test(text)) {
    good.push("Есть компоненты, которые могут улучшать скольжение и расчесывание волос.");
    score += 10;
  }

  if (/(phenoxyethanol|sodium benzoate|potassium sorbate|disodium edta|sodium phytate)/.test(text)) {
    good.push("Видны компоненты для стабильности и защиты продукта.");
    score += 7;
  }

  if (/(sodium lauryl sulfate|ammonium lauryl sulfate|methylisothiazolinone|methylchloroisothiazolinone|menthol|parfum|fragrance)/.test(text)) {
    risk.push("Есть компоненты, которые могут раздражать чувствительную кожу головы или повышать риск плохой переносимости.");
    score -= 14;
  }

  score = Math.max(20, Math.min(94, score));

  if (score >= 76 && risk.length <= 1) {
    return {
      score,
      title: "Похоже на хороший вариант",
      verdict: "Похоже на хороший вариант",
      tone: "good",
      confidence: "средняя",
      shampooType: "универсальный",
      pros: good.join(" ") || "Состав выглядит достаточно сбалансированным.",
      cons: risk.join(" ") || "Явных серьезных минусов по быстрой программной проверке не видно, но pH, запах и личную переносимость по составу узнать нельзя.",
      leaderComparison: "По быстрой программной проверке состав выглядит достаточно сильным, чтобы сравнивать его с текущими лидерами.",
      shouldSuggest: true,
    };
  }

  return {
    score,
    title: "Нужна осторожность",
    verdict: "Нужна осторожность",
    tone: score >= 58 ? "watch" : "weak",
    confidence: "средняя",
    shampooType: "универсальный",
    pros: good.join(" ") || "Сильных плюсов по быстрой программной проверке не видно.",
    cons: risk.join(" ") || "Состав не выглядит однозначным, лучше сравнить его с лидерами рейтинга.",
    leaderComparison: "Пока это скорее кандидат для ручного сравнения, чем очевидный лидер.",
    shouldSuggest: false,
  };
}

function ScoreRing({ score }: { score: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const tone = score >= 85 ? "text-emerald-600" : score >= 70 ? "text-teal-600" : score >= 50 ? "text-amber-500" : "text-zinc-500";

  return (
    <div className="flex items-center gap-3">
      <svg width="46" height="46" viewBox="0 0 46 46" className="shrink-0" aria-hidden="true">
        <circle cx="23" cy="23" r={radius} fill="none" stroke="currentColor" strokeWidth="5" className="text-zinc-200" />
        <circle
          cx="23"
          cy="23"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={tone}
          transform="rotate(-90 23 23)"
        />
      </svg>
      <div className="w-8 text-right text-lg font-semibold tabular-nums text-zinc-950">{score}</div>
    </div>
  );
}

function Pill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`h-9 rounded-full px-4 text-sm transition ${
        active ? "bg-zinc-950 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function AdminBars({ rows, valueKey }: { rows: Array<Record<string, string | number>>; valueKey: string }) {
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey] ?? 0)));
  const width = 560;
  const height = 150;
  const gap = 7;
  const barWidth = Math.max(8, (width - gap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full overflow-visible">
      {rows.map((row, index) => {
        const value = Number(row[valueKey] ?? 0);
        const barHeight = Math.max(2, (value / max) * 118);
        const x = index * (barWidth + gap);
        const y = 124 - barHeight;
        return (
          <g key={`${row.day ?? row.bucket ?? index}`}>
            <rect x={x} y={y} width={barWidth} height={barHeight} rx="3" fill="#18181b" opacity={0.9} />
            <text x={x + barWidth / 2} y="145" textAnchor="middle" fontSize="9" fill="#71717a">
              {String(row.day ?? row.bucket).slice(-5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function AdminDashboard() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") ?? "");
  const [draftToken, setDraftToken] = useState(token);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [analyses, setAnalyses] = useState<AdminAnalysis[]>([]);
  const [submissions, setSubmissions] = useState<AdminSubmission[]>([]);
  const [expandedAnalysisId, setExpandedAnalysisId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadAdminData(activeToken = token) {
    if (!activeToken.trim()) {
      setNotice("Нужен ADMIN_TOKEN.");
      return;
    }

    setLoading(true);
    setNotice("");
    try {
      const headers = { authorization: `Bearer ${activeToken.trim()}` };
      const [summaryData, analysesData, submissionsData] = await Promise.all([
        fetchJson<AdminSummary>("/api/admin/summary", { headers }),
        fetchJson<{ items: AdminAnalysis[] }>("/api/admin/analyses?limit=80", { headers }),
        fetchJson<{ items: AdminSubmission[] }>("/api/admin/submissions?limit=80", { headers }),
      ]);
      setSummary(summaryData);
      setAnalyses(analysesData.items);
      setSubmissions(submissionsData.items);
      localStorage.setItem("adminToken", activeToken.trim());
      setToken(activeToken.trim());
    } catch {
      setNotice("Админка не загрузилась. Проверь ADMIN_TOKEN и доступность API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      void loadAdminData(token);
    }
  }, []);

  async function deleteAdminItem(kind: "analyses" | "submissions", id: number) {
    if (!token.trim()) {
      setNotice("Нужен ADMIN_TOKEN.");
      return;
    }

    try {
      await fetchJson(`/api/admin/${kind}/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      if (kind === "analyses") {
        setAnalyses((items) => items.filter((item) => item.id !== id));
        setExpandedAnalysisId((current) => (current === id ? null : current));
      } else {
        setSubmissions((items) => items.filter((item) => item.id !== id));
      }
      void loadAdminData(token);
    } catch {
      setNotice("Не удалось удалить запись. Проверь токен и доступность API.");
    }
  }

  const scoreRows = summary?.scoreBuckets.map((row) => ({ bucket: `${row.bucket}-${row.bucket + 9}`, count: row.count })) ?? [];

  return (
    <main className="min-h-screen bg-[#fafafa] text-zinc-950">
      <section className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
        <div className="flex flex-col gap-5 border-b border-zinc-200 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-4 inline-flex h-8 items-center gap-2 rounded-full bg-zinc-950 px-4 text-sm font-medium text-white">
              <Lock className="h-4 w-4" />
              admin
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-zinc-950">Админка shampoo.asind.dev</h1>
            <p className="mt-2 text-sm text-zinc-500">Посещения, AI-разборы и предложения из SQLite.</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <input
              value={draftToken}
              onChange={(event) => setDraftToken(event.target.value)}
              type="password"
              className="h-10 min-w-[260px] rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:ring-4 focus:ring-zinc-100"
              placeholder="ADMIN_TOKEN"
            />
            <button onClick={() => void loadAdminData(draftToken)} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-zinc-950 px-4 text-sm font-medium text-white">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Обновить
            </button>
          </div>
        </div>

        {notice && <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {[
            ["визиты", summary?.totals.visits],
            ["уники", summary?.totals.uniqueVisitors],
            ["визиты сегодня", summary?.totals.visitsToday],
            ["анализы", summary?.totals.analyses],
            ["анализы сегодня", summary?.totals.analysesToday],
            ["предложения", summary?.totals.pendingSubmissions],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">{label}</div>
              <div className="mt-2 text-3xl font-semibold tabular-nums">{value ?? "—"}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <BarChart3 className="h-4 w-4" />
              Визиты по дням
            </div>
            <AdminBars rows={summary?.daily ?? []} valueKey="visits" />
          </section>
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="mb-4 text-sm font-semibold">Оценки анализов</div>
            <AdminBars rows={scoreRows} valueKey="count" />
          </section>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-semibold">Последние анализы</h2>
            <div className="mt-4 space-y-3">
              {analyses.map((item) => (
                <article key={item.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button onClick={() => setExpandedAnalysisId(expandedAnalysisId === item.id ? null : item.id)} className="text-left text-sm font-medium hover:underline">
                      {item.result?.title ?? "Без результата"}
                    </button>
                    <div className="flex items-center gap-3">
                      <div className="text-sm font-semibold tabular-nums">{item.result?.score ?? "—"}</div>
                      <button
                        onClick={() => void deleteAdminItem("analyses", item.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-400 ring-1 ring-zinc-200 hover:text-red-600"
                        title="Удалить анализ"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">{formatDateTime(item.createdAt)} · {item.provider} · {item.model}</div>
                  <p className="mt-3 text-sm leading-6 text-zinc-600">{shortText(item.composition)}</p>
                  {item.result?.verdict && <p className="mt-2 text-sm leading-6 text-zinc-800">{shortText(item.result.verdict, 260)}</p>}
                  {expandedAnalysisId === item.id && (
                    <div className="mt-3 rounded-md border border-zinc-200 bg-white p-3">
                      <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">сырой ответ модели</div>
                      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-zinc-600">
                        {formatRawJson(item.rawResponse)}
                      </pre>
                    </div>
                  )}
                </article>
              ))}
              {analyses.length === 0 && <p className="text-sm text-zinc-500">Пока пусто.</p>}
            </div>
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-semibold">Предложения</h2>
            <div className="mt-4 space-y-3">
              {submissions.map((item) => (
                <article key={item.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-zinc-950 hover:underline">{item.name}</a>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs text-zinc-500 ring-1 ring-zinc-200">{item.status}</span>
                      <button
                        onClick={() => void deleteAdminItem("submissions", item.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-400 ring-1 ring-zinc-200 hover:text-red-600"
                        title="Удалить предложение"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">{formatDateTime(item.createdAt)} · score {item.analysis?.score ?? "—"}</div>
                  <p className="mt-3 text-sm leading-6 text-zinc-600">{shortText(item.composition)}</p>
                  {item.analysis?.verdict && <p className="mt-2 text-sm leading-6 text-zinc-800">{shortText(item.analysis.verdict, 260)}</p>}
                </article>
              ))}
              {submissions.length === 0 && <p className="text-sm text-zinc-500">Пока пусто.</p>}
            </div>
          </section>
        </div>

        <section className="mt-5 rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-lg font-semibold">Провайдеры</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {(summary?.providerBreakdown ?? []).map((item) => (
              <span key={item.provider} className="rounded-full bg-zinc-100 px-3 py-1.5 text-sm text-zinc-700">
                {item.provider}: {item.count}
              </span>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

export default function ShampooLanding() {
  return window.location.pathname.startsWith("/admin") ? <AdminDashboard /> : <PublicLanding />;
}

function PublicLanding() {
  const [activeTab, setActiveTab] = useState<Audience>("normal");
  const [ratingItems, setRatingItems] = useState<Shampoo[]>(fallbackShampoos);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [composition, setComposition] = useState("");
  const [serverAnalysis, setServerAnalysis] = useState<Analysis | null>(null);
  const [analysisProvider, setAnalysisProvider] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [apiNotice, setApiNotice] = useState("");
  const [productName, setProductName] = useState("");
  const [productLink, setProductLink] = useState("");
  const [proposalSent, setProposalSent] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [ratingNoteOpen, setRatingNoteOpen] = useState(false);
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);

  useEffect(() => {
    let ignore = false;

    fetchJson<{ items: Shampoo[] }>("/api/shampoos")
      .then((data) => {
        if (!ignore) {
          setRatingItems(hydrateShampoos(data.items));
          setExpandedId(data.items[0]?.id ?? null);
        }
      })
      .catch(() => {
        if (!ignore) {
          setApiNotice("API рейтинга не ответил. Пока показаны встроенные данные.");
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    loadRecaptchaScript(recaptchaSiteKey);
  }, []);

  useEffect(() => {
    if (!isAnalyzing) {
      setAnalysisElapsedSeconds(0);
      return undefined;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setAnalysisElapsedSeconds(Math.min(200, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isAnalyzing]);

  useEffect(() => {
    const key = "shampooVisitTracked";
    if (sessionStorage.getItem(key)) {
      return;
    }

    sessionStorage.setItem(key, "1");
    fetchJson("/api/visits", {
      method: "POST",
      body: JSON.stringify({ path: window.location.pathname || "/" }),
    }).catch(() => undefined);
  }, []);

  const filtered = useMemo(
    () => ratingItems.filter((item) => item.fit.includes(activeTab)).sort((a, b) => b.score - a.score),
    [activeTab, ratingItems],
  );
  const currentTab = tabs.find((tab) => tab.id === activeTab);
  const analysis = serverAnalysis;
  const waitMessage = analysisWaitMessages[Math.min(analysisWaitMessages.length - 1, Math.floor(analysisElapsedSeconds / 10))];
  const analysisProgress = getAnalysisProgress(analysisElapsedSeconds);
  const isProgrammaticAnalysis = analysisProvider === "heuristic" || analysisProvider === "program";

  async function requestAiAnalysis() {
    setApiNotice("");
    setServerAnalysis(null);
    setAnalysisProvider("");
    setProposalSent(false);
    setIsAnalyzing(true);

    try {
      const recaptchaToken = await getRecaptchaToken("analyze");
      const data = await fetchJson<{ result: Analysis; provider: string }>("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ composition, recaptchaToken }),
      });
      setServerAnalysis(data.result);
      setAnalysisProvider(data.provider);
      if (data.provider === "heuristic") {
        setApiNotice("Внимание: ИИ сейчас не ответил. Показана запасная программная оценка, она менее надёжна, чем полноценный разбор модели.");
      }
    } catch (error) {
      const rateLimitNotice = formatRateLimitNotice(error);
      const recaptchaNotice = formatRecaptchaNotice(error);
      if (rateLimitNotice) {
        setApiNotice(rateLimitNotice);
      } else if (recaptchaNotice) {
        setApiNotice(recaptchaNotice);
      } else {
        setServerAnalysis(localAnalyze(composition));
        setAnalysisProvider("program");
        setApiNotice("Внимание: ИИ сейчас не ответил. Показана запасная программная оценка, она менее надёжна, чем полноценный разбор модели.");
      }
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function submitProposal() {
    if (!productName.trim()) {
      return;
    }

    if (!analysis) {
      setApiNotice("Сначала нужно получить разбор состава.");
      return;
    }

    try {
      const recaptchaToken = await getRecaptchaToken("submit_shampoo");
      await fetchJson("/api/submissions", {
        method: "POST",
        body: JSON.stringify({
          name: productName,
          sourceUrl: productLink,
          composition,
          analysis,
          recaptchaToken,
        }),
      });
      setProposalSent(true);
      setApiNotice("");
    } catch (error) {
      setProposalSent(false);
      setApiNotice(
        formatRateLimitNotice(error)
          || formatRecaptchaNotice(error)
          || "Заявка не отправлена. Проверь ссылку, капча-проверку и доступность API.",
      );
    }
  }

  function setExample(value: string, analysis: Analysis | null = null) {
    setComposition(value);
    setServerAnalysis(analysis);
    setAnalysisProvider("");
    setProposalSent(false);
  }

  async function copyName(id: number, name: string) {
    await navigator.clipboard.writeText(name);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1400);
  }

  return (
    <main className="min-h-screen bg-[#fafafa] text-zinc-950">
      <section className="mx-auto max-w-[1120px] px-5 pb-10 pt-10 sm:px-8 lg:pt-14">
        <div>
            <div className="mb-10 inline-flex h-8 items-center rounded-full bg-zinc-950 px-4 text-sm font-medium text-white">
              shampoo.asind.dev
            </div>
            <h1 className="max-w-[680px] font-serif text-[58px] leading-[0.92] tracking-tight text-black sm:text-[84px] lg:text-[104px]">
              Выбрать шампунь один раз
            </h1>
            <p className="mt-7 max-w-[520px] text-xl leading-8 text-zinc-800">
              Независимый рейтинг по составу и цене. Без рекламы, сложных терминов и обещаний на бутылке.
            </p>
        </div>
      </section>

      <section className="mx-auto max-w-[1120px] px-5 py-8 sm:px-8">
        <div className="mb-5 flex flex-col gap-4 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="relative flex items-center gap-2">
              <h2 className="text-xl font-semibold text-zinc-950">Рейтинг</h2>
              <button
                type="button"
                onClick={() => setRatingNoteOpen((isOpen) => !isOpen)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-950"
                aria-expanded={ratingNoteOpen}
                aria-label="Пояснение к рейтингу"
              >
                <CircleHelp className="h-4 w-4" />
              </button>
              {ratingNoteOpen && (
                <div className="absolute left-0 top-9 z-10 w-[min(88vw,520px)] rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-6 text-zinc-600 shadow-sm">
                  <p>
                    Рейтинг основан на открыто доступных составах INCI из карточек товаров, фото упаковок и других открытых источников на момент проверки. Мы не проводим лабораторные испытания и не гарантируем, что состав конкретной партии совпадает с указанным в карточке товара. Оценка отражает только субъективный анализ состава по нашей методике и не является медицинской рекомендацией, рекламой, гарантией качества или утверждением о безопасности/опасности товара. Перед покупкой сверяйте состав на упаковке.
                  </p>
                  <p className="mt-3">
                    Важно: часть данных взята из карточек товаров на маркетплейсах. Карточки могут содержать устаревший, неполный или ошибочный состав.
                  </p>
                </div>
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500">{currentTab?.helper}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <Pill key={tab.id} active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
                {tab.label}
              </Pill>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div className="hidden grid-cols-[56px_1fr_150px_120px_40px] gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-medium uppercase tracking-[0.12em] text-zinc-400 sm:grid">
            <div>#</div>
            <div>Бренд / шампунь</div>
            <div>Оценка</div>
            <div>Цена</div>
            <div />
          </div>

          {filtered.map((item, index) => {
            const isOpen = expandedId === item.id;
            const fullName = getFullName(item);

            return (
              <article key={item.id} className="border-b border-zinc-200 last:border-b-0">
                <button
                  onClick={() => setExpandedId(isOpen ? null : item.id)}
                  className="hidden w-full grid-cols-[56px_1fr_150px_120px_40px] items-center gap-3 px-4 py-4 text-left transition hover:bg-zinc-50 sm:grid"
                >
                  <div className="text-sm tabular-nums text-zinc-400">{String(index + 1).padStart(2, "0")}</div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-600">{item.brandNote}</div>
                    <div className="mt-0.5 truncate text-base font-medium text-zinc-950">{item.name}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.signals.slice(0, 2).map((signal) => (
                        <span key={signal} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">
                          {signal}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ScoreRing score={item.score} />
                  <div className="text-sm font-medium text-zinc-950">{formatPrice(item.price)}</div>
                  <ChevronDown className={`h-5 w-5 text-zinc-400 transition ${isOpen ? "rotate-180" : ""}`} />
                </button>

                <button onClick={() => setExpandedId(isOpen ? null : item.id)} className="w-full px-4 py-4 text-left sm:hidden">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs tabular-nums text-zinc-400">{String(index + 1).padStart(2, "0")}</div>
                      <div className="mt-2 text-sm font-medium leading-5 text-zinc-600">{item.brandNote}</div>
                      <div className="mt-0.5 text-base font-medium leading-6 text-zinc-950">{item.name}</div>
                    </div>
                    <ChevronDown className={`mt-1 h-5 w-5 shrink-0 text-zinc-400 transition ${isOpen ? "rotate-180" : ""}`} />
                  </div>
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <ScoreRing score={item.score} />
                    <div className="text-right">
                      <div className="text-xs uppercase tracking-[0.12em] text-zinc-400">цена</div>
                      <div className="mt-1 text-sm font-semibold text-zinc-950">{formatPrice(item.price)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.signals.slice(0, 2).map((signal) => (
                      <span key={signal} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">
                        {signal}
                      </span>
                    ))}
                  </div>
                </button>

                {isOpen && (
                  <div className="bg-zinc-50 px-4 pb-5 pt-1 sm:grid sm:grid-cols-[56px_1fr]">
                    <div />
                    <div className="max-w-[760px] space-y-4 text-sm leading-7">
                      <div className="flex flex-col gap-2 border-b border-zinc-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">название</div>
                          <div className="mt-1 font-medium text-zinc-950">{fullName}</div>
                        </div>
                        <button
                          onClick={() => copyName(item.id, fullName)}
                          className="inline-flex h-9 w-fit items-center gap-2 rounded-full bg-white px-3 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:text-zinc-950"
                        >
                          <Copy className="h-4 w-4" />
                          {copiedId === item.id ? "Скопировано" : "Копировать"}
                        </button>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-emerald-700">плюсы</div>
                        <p className="text-zinc-700">{item.verdict}</p>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">что учесть</div>
                        <p className="text-zinc-500">{item.caution}</p>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">состав</div>
                        <p className="whitespace-pre-wrap break-words text-xs leading-6 text-zinc-500">{getInci(item)}</p>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-[1120px] px-5 py-8 sm:px-8">
        <div className="grid gap-8 border-t border-zinc-200 pt-8 lg:grid-cols-[330px_1fr]">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-zinc-500">
              <Search className="h-4 w-4" />
              Проверка состава
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-zinc-950">Проверить свой шампунь</h2>
            <p className="mt-3 text-base leading-7 text-zinc-600">Если состав выглядит сильным, сайт предложит отправить его в общий список.</p>
          </div>

          <div>
            <textarea
              value={composition}
              onChange={(event) => setExample(event.target.value)}
              className="min-h-[150px] w-full resize-none rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-6 outline-none focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
              placeholder="Вставь состав с этикетки..."
            />
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-2">
                {examples.map((example, index) => (
                  <button key={example.composition} onClick={() => setExample(example.composition, example.analysis)} className="rounded-full bg-zinc-100 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-200">
                    пример {index + 1}
                  </button>
                ))}
              </div>
              <button
                onClick={requestAiAnalysis}
                disabled={composition.trim().length < 20 || isAnalyzing}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-zinc-950 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                {isAnalyzing ? "Проверяю" : "Проверить"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-zinc-400">защита от спама reCAPTCHA</p>

            {(analysis || isAnalyzing) && composition.trim().length >= 20 && (
              <div className="mt-5 rounded-lg border border-zinc-200 bg-white p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-500">Разбор состава</div>
                    {isProgrammaticAnalysis && (
                      <div className="mb-3 mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-950">
                        ИИ-разбор сейчас недоступен. Ниже показана запасная программная оценка: она помогает не оставить форму пустой, но ей нельзя доверять так же, как полноценному ответу модели.
                      </div>
                    )}
                    <h3 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">{analysis?.title ?? "Проверяю состав"}</h3>
                    {analysis?.verdict ? (
                      <p className="mt-2 max-w-[680px] text-sm leading-6 text-zinc-600">{analysis.verdict}</p>
                    ) : (
                      <div className="mt-2 max-w-[680px] space-y-2">
                        <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                          <div
                            className="h-full rounded-full bg-zinc-950 transition-[width] duration-1000 ease-out"
                            style={{ width: `${analysisProgress}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-zinc-400">
                          <span>идёт проверка</span>
                          <span>{analysisProgress}%</span>
                        </div>
                        <p className="text-sm leading-6 text-zinc-600">{waitMessage}</p>
                        <p className="text-xs leading-5 text-zinc-400">
                          Проверка может затянуться до трёх минут: состав сравнивается с рейтингом и несколькими референсами.
                        </p>
                      </div>
                    )}
                  </div>
                  {analysis && analysis.tone !== "empty" && <ScoreRing score={analysis.score} />}
                </div>

                {analysis && analysis.tone !== "empty" && (
                  <div className="mt-5 space-y-5 border-t border-zinc-200 pt-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-md bg-zinc-50 p-4">
                        <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">уверенность</div>
                        <div className="mt-1 text-sm font-medium text-zinc-950">{analysis.confidence}</div>
                      </div>
                      <div className="rounded-md bg-zinc-50 p-4">
                        <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">тип</div>
                        <div className="mt-1 text-sm font-medium text-zinc-950">{analysis.shampooType}</div>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-emerald-700">главные плюсы</div>
                      <p className="text-sm leading-7 text-zinc-700">{analysis.pros}</p>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">главные минусы</div>
                      <p className="text-sm leading-7 text-zinc-600">{analysis.cons}</p>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">сравнение с лидерами</div>
                      <p className="text-sm leading-7 text-zinc-600">{analysis.leaderComparison}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {analysis?.shouldSuggest && (
              <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                  <div>
                    <h3 className="font-semibold text-emerald-950">Похоже, это можно добавить в рейтинг</h3>
                    <p className="mt-1 text-sm leading-6 text-emerald-900/80">Заполни минимум данных.</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <input value={productName} onChange={(event) => setProductName(event.target.value)} className="h-10 rounded-md border border-emerald-200 bg-white px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100" placeholder="Бренд и название" />
                  <input value={productLink} onChange={(event) => setProductLink(event.target.value)} className="h-10 rounded-md border border-emerald-200 bg-white px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100" placeholder="Ссылка" />
                </div>
                <button
                  onClick={submitProposal}
                  disabled={!productName.trim() || !productLink.trim()}
                  className="mt-3 h-10 rounded-full bg-emerald-900 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-emerald-200"
                >
                  Отправить
                </button>
                {proposalSent && <p className="mt-3 text-sm text-emerald-900">Заявка принята.</p>}
              </div>
            )}

            {apiNotice && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium leading-6 text-amber-900">
                {apiNotice}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1120px] px-5 pb-14 pt-8 sm:px-8">
        <details className="border-t border-zinc-200 pt-5">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600">О методике и ограничениях рейтинга</summary>
          <div className="mt-4 max-w-[820px] space-y-4 text-sm leading-7 text-zinc-600">
            <p>
            Рейтинг носит информационный и субъективно-аналитический характер. Мы оцениваем шампуни по доступным данным: составу INCI, заявленному pH, цене за литр и информации, опубликованной в карточках товаров, на упаковках или в открытых источниках на момент проверки.
            </p>
            <p>
            Мы не проводим лабораторные испытания, не проверяем фактические концентрации ингредиентов, качество сырья, стабильность партии, микробиологическую безопасность, подлинность товара, соответствие состава каждой конкретной бутылки и индивидуальную переносимость продукта.
            </p>
            <p>
            Оценка не является медицинской, дерматологической, трихологической или косметологической рекомендацией. Рейтинг не гарантирует, что шампунь подойдёт конкретному человеку, решит проблему перхоти, выпадения волос, зуда, раздражения или других состояний кожи головы. При выраженных симптомах следует обратиться к врачу.
            </p>
            <p>
            Составы шампуней могут меняться производителем без сохранения прежней карточки товара. Перед покупкой всегда сверяйте состав на конкретной упаковке. Если состав на упаковке отличается от состава в рейтинге, оценка может быть неприменима.
            </p>
            <p>
            Мы не утверждаем, что товары с низкой оценкой являются опасными, незаконными или некачественными в юридическом смысле. Низкая оценка означает только то, что состав выглядит менее удачным по нашей методике: например, из-за спорной ПАВ-базы, потенциальных раздражителей, слабой доказуемости маркетинговых обещаний, устаревших компонентов или некорректного указания состава.
            </p>
            <p>
            Названия брендов и товаров используются только для идентификации анализируемых продуктов. Все товарные знаки принадлежат их правообладателям.
            </p>
            <p>
            Если вы являетесь представителем бренда, продавцом или покупателем и считаете, что состав, цена, описание или оценка указаны некорректно, напишите нам и приложите фото актуальной упаковки или ссылку на источник. Мы проверим информацию и при необходимости обновим карточку.

            </p>
          </div>
        </details>

        <div className="mt-8 flex justify-end text-sm text-zinc-400">
          <a href={authorUrl} target={authorUrl === "#" ? undefined : "_blank"} rel="noreferrer" className="hover:text-zinc-700">
            сделано asind от всей души
          </a>
        </div>
      </section>
    </main>
  );
}
