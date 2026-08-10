"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateEventToKorean = translateEventToKorean;
exports.translateEventsToKorean = translateEventsToKorean;
const cache = new Map();
const FIELDS = [
    "eligibility",
    "registration",
    "teamLimit",
    "location",
    "summary",
];
function needsKoreanTranslation(value) {
    const latin = value.match(/[A-Za-z]/g)?.length ?? 0;
    const korean = value.match(/[가-힣]/g)?.length ?? 0;
    return latin >= 8 && latin > korean * 2;
}
async function translateText(value) {
    const normalized = value.replace(/\s+/g, " ").trim().slice(0, 4_500);
    if (!needsKoreanTranslation(normalized))
        return value;
    const saved = cache.get(normalized);
    if (saved)
        return saved;
    try {
        const url = new URL("https://translate.googleapis.com/translate_a/single");
        url.search = new URLSearchParams({ client: "gtx", sl: "auto", tl: "ko", dt: "t", q: normalized }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok)
            return value;
        const payload = await response.json();
        if (!Array.isArray(payload) || !Array.isArray(payload[0]))
            return value;
        const translated = payload[0]
            .map((part) => Array.isArray(part) ? String(part[0] ?? "") : "")
            .join("")
            .trim();
        if (!translated)
            return value;
        cache.set(normalized, translated);
        return translated;
    }
    catch {
        return value;
    }
}
async function translateEventToKorean(event) {
    const translated = { ...event };
    for (const field of FIELDS) {
        const value = translated[field];
        if (typeof value === "string" && value)
            translated[field] = await translateText(value);
    }
    return translated;
}
async function translateEventsToKorean(events, concurrency = 2) {
    const output = new Array(events.length);
    let index = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, events.length || 1)) }, async () => {
        for (;;) {
            const current = index++;
            if (current >= events.length)
                return;
            output[current] = await translateEventToKorean(events[current]);
        }
    });
    await Promise.all(workers);
    return output;
}
