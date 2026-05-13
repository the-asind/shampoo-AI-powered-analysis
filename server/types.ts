export type Audience = "normal" | "oily" | "sensitive";

export type Shampoo = {
  id: number;
  name: string;
  brandNote: string;
  score: number;
  price: number;
  fit: Audience[];
  base: string;
  verdict: string;
  signals: string[];
  caution: string;
  inci: string;
};

export type AnalysisTone = "good" | "watch" | "weak" | "empty";

export type IngredientAnalysis = {
  score: number;
  title: string;
  verdict: string;
  tone: AnalysisTone;
  confidence: "высокая" | "средняя" | "низкая";
  shampooType:
    | "универсальный"
    | "мягкий sulfate-free"
    | "сильное очищение"
    | "чувствительная кожа"
    | "разглаживающий"
    | "маркетингово перегруженный"
    | "подозрительный состав"
    | "не рекомендуется";
  pros: string;
  cons: string;
  leaderComparison: string;
  shouldSuggest: boolean;
};
