"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCtfCategory = normalizeCtfCategory;
exports.parseKstDateTime = parseKstDateTime;
exports.isAllSolved = isAllSolved;
exports.categoryChannelName = categoryChannelName;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** Discord 채널에 쓸 문제 분야. 모든 입력을 소문자 kebab-case로 정규화한다. */
function normalizeCtfCategory(input) {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9가-힣_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "");
    return (normalized || "misc").slice(0, 90);
}
/** `YYYY-MM-DD HH:mm`를 한국 시간으로 해석한다. */
function parseKstDateTime(input) {
    const match = input.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})$/);
    if (!match)
        return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    const utc = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
    const roundTrip = new Date(utc + KST_OFFSET_MS);
    if (roundTrip.getUTCFullYear() !== year ||
        roundTrip.getUTCMonth() !== month - 1 ||
        roundTrip.getUTCDate() !== day ||
        roundTrip.getUTCHours() !== hour ||
        roundTrip.getUTCMinutes() !== minute)
        return null;
    return utc;
}
function isAllSolved(problems) {
    return problems.length > 0 && problems.every((problem) => problem.solved);
}
function categoryChannelName(category, problems) {
    return `${isAllSolved(problems) ? "🟦" : "⬜"}｜${category}`;
}
