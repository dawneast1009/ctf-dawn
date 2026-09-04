import type { CtfProblem } from "../store";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Discord 채널에 쓸 문제 분야. 모든 입력을 소문자 kebab-case로 정규화한다. */
export function normalizeCtfCategory(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return (normalized || "misc").slice(0, 90);
}

/** `YYYY-MM-DD HH:mm`를 한국 시간으로 해석한다. */
export function parseKstDateTime(input: string): number | null {
  const match = input.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
  const roundTrip = new Date(utc + KST_OFFSET_MS);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) return null;
  return utc;
}

export function isAllSolved(problems: Pick<CtfProblem, "solved">[]): boolean {
  return problems.length > 0 && problems.every((problem) => problem.solved);
}

export function categoryChannelName(category: string, problems: Pick<CtfProblem, "solved">[]): string {
  return `${isAllSolved(problems) ? "🟦" : "⬜"}｜${category}`;
}

export function splitChallengeDescription(description: string, limit = 4096): string[] {
  if (!description) return [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < description.length) {
    let end = Math.min(description.length, offset + limit);
    if (end < description.length && /[\uD800-\uDBFF]/.test(description[end - 1]) && /[\uDC00-\uDFFF]/.test(description[end])) end--;
    chunks.push(description.slice(offset, end));
    offset = end;
  }
  return chunks;
}

interface RemoteContent {
  description?: string;
  files?: Array<{ id: string; name: string; url: string }>;
}

export function remoteContentChanges(previous: RemoteContent, next: RemoteContent): string[] {
  const changes: string[] = [];
  if (next.description !== undefined && previous.description !== next.description) changes.push("문제 설명");
  if (next.files === undefined) return changes;
  const unmatched = [...(previous.files ?? [])];
  for (const file of next.files) {
    const exact = unmatched.findIndex((old) => old.id === file.id);
    if (exact >= 0) {
      if (unmatched[exact].name !== file.name) changes.push(`파일 이름 변경: ${unmatched[exact].name} → ${file.name}`);
      unmatched.splice(exact, 1);
      continue;
    }
    const sameName = unmatched.findIndex((old) => old.name === file.name);
    if (sameName >= 0) {
      unmatched.splice(sameName, 1);
      changes.push(`파일 교체: ${file.name}`);
    } else {
      changes.push(`파일 추가: ${file.name}`);
    }
  }
  for (const file of unmatched) changes.push(`파일 삭제: ${file.name}`);
  return changes;
}

export function selectChallengeDetailBatch(ids: string[], cursor: number, limit: number): { ids: string[]; nextCursor: number } {
  if (!ids.length || limit <= 0) return { ids: [], nextCursor: 0 };
  const start = ((cursor % ids.length) + ids.length) % ids.length;
  const count = Math.min(ids.length, Math.floor(limit));
  const selected = Array.from({ length: count }, (_, index) => ids[(start + index) % ids.length]);
  return { ids: selected, nextCursor: (start + count) % ids.length };
}

export function remoteSyncAnnouncement(name: string, channelId: string, result: "created" | "updated", changes: string[]): string {
  const safeName = name.slice(0, 256);
  const suffix = ` · <#${channelId}>`;
  if (result === "created") return `🆕 새 문제 **${safeName}**${suffix}`;
  const prefix = `🔄 문제 업데이트 **${safeName}** · `;
  const selected: string[] = [];
  for (const change of changes) {
    const candidate = [...selected, change.slice(0, 512)].join(", ");
    if (`${prefix}${candidate}${suffix}`.length > 1900) break;
    selected.push(change.slice(0, 512));
  }
  const omitted = changes.length - selected.length;
  const summary = `${selected.join(", ")}${omitted ? `${selected.length ? ", " : ""}외 ${omitted}건` : ""}`;
  return `${prefix}${summary}${suffix}`;
}

export function appendRemoteAnnouncement(existing: string[] | undefined, message: string): string[] {
  const queue = existing ?? [];
  return queue.includes(message) ? queue : [...queue, message];
}
