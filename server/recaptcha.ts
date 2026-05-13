type RecaptchaResponse = {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

const verifyUrl = "https://www.google.com/recaptcha/api/siteverify";

export async function verifyRecaptcha(token: string | undefined, expectedAction: string) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  const threshold = Number(process.env.RECAPTCHA_MIN_SCORE ?? 0.5);

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "recaptcha_not_configured" };
    }

    return { ok: true, score: 1, skipped: true };
  }

  if (!token) {
    return { ok: false, reason: "recaptcha_token_missing" };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });

  const response = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    return { ok: false, reason: "recaptcha_verify_failed" };
  }

  const result = (await response.json()) as RecaptchaResponse;
  if (!result.success) {
    return { ok: false, reason: "recaptcha_unsuccessful", errors: result["error-codes"] ?? [] };
  }

  if (result.action !== expectedAction) {
    return { ok: false, reason: "recaptcha_action_mismatch", action: result.action };
  }

  if (typeof result.score !== "number" || result.score < threshold) {
    return { ok: false, reason: "recaptcha_low_score", score: result.score ?? null };
  }

  return { ok: true, score: result.score };
}
