import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.DATABASE_PATH?.trim() || join(process.cwd(), "data.json");
const BACKUP_PATH = `${DB_PATH}.bak`;
export const keyOf = (value: string) => value.trim().toLowerCase();

export interface CtfContest {
  guildId: string; key: string; name: string; roleId: string; categoryId: string;
  startsAt: number; endsAt: number; teamName?: string; lobbyChannelId?: string;
  lobbyMessageId?: string; solveStatusMessageId?: string; allSolved: boolean;
  warningEnabled: boolean; platform?: "ctfd" | "rctf" | "hspace" | "generic";
  sourceUrl?: string; publicApiReadable?: boolean; encryptedAccessToken?: string;
  authenticationType?: "token" | "session";
  monitorError?: string; monitorErrorAt?: number;
  createdAt: number; updatedAt: number;
}
export interface CtfProblem {
  id: string; guildId: string; ctfName: string; ctfKey: string; name: string;
  nameKey: string; genre: string; genreKey: string; channelId: string; threadId?: string;
  cardMessageId?: string; participants?: string[]; authorId: string;
  scores: Record<string, number>; solved: boolean; submittedFlag?: string;
  externalId?: string; createdAt: number;
}
interface Db { contests: Record<string, CtfContest>; problems: Record<string, CtfProblem>; channels: Record<string, string>; messages: Record<string, string>; }
const empty = (): Db => ({ contests: {}, problems: {}, channels: {}, messages: {} });
let loadedFromBackup = false;
function readDb(path: string): Db {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DB 최상위 형식이 올바르지 않습니다.");
  for (const key of ["contests", "problems", "channels", "messages"]) if (value[key] != null && (typeof value[key] !== "object" || Array.isArray(value[key]))) throw new Error(`DB ${key} 형식이 올바르지 않습니다.`);
  return { ...empty(), ...value };
}
function load(): Db {
  if (!existsSync(DB_PATH)) {
    if (!existsSync(BACKUP_PATH)) return empty();
    console.warn(`기본 DB가 없어 백업을 복구했습니다: ${BACKUP_PATH}`);
    loadedFromBackup = true;
    return readDb(BACKUP_PATH);
  }
  try { return readDb(DB_PATH); }
  catch (error) {
    if (existsSync(BACKUP_PATH)) {
      try { console.error(`DB 손상 감지, 백업을 사용합니다: ${error instanceof Error ? error.message : error}`); const backup = readDb(BACKUP_PATH); loadedFromBackup = true; return backup; }
      catch (backupError) { throw new Error(`DB와 백업을 모두 읽을 수 없습니다: ${backupError instanceof Error ? backupError.message : backupError}`); }
    }
    throw new Error(`DB를 읽을 수 없습니다: ${error instanceof Error ? error.message : error}`);
  }
}
let db = load();
function save() { mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 }); const tmp = `${DB_PATH}.tmp`; writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); if (existsSync(DB_PATH) && !loadedFromBackup) copyFileSync(DB_PATH, BACKUP_PATH); renameSync(tmp, DB_PATH); loadedFromBackup = false; }
const contestKey = (guildId: string, key: string) => `${guildId}:${key}`;
export const getContest = (guildId: string, key: string) => db.contests[contestKey(guildId, key)];
export const getContests = (guildId: string) => Object.values(db.contests).filter((v) => v.guildId === guildId);
export function putContest(value: CtfContest) { db.contests[contestKey(value.guildId, value.key)] = value; save(); }
export function patchContest(guildId: string, key: string, patch: Partial<CtfContest>) { const value = getContest(guildId, key); if (!value) return; Object.assign(value, patch, { updatedAt: Date.now() }); save(); return value; }
export function removeContest(guildId: string, key: string) {
  delete db.contests[contestKey(guildId, key)];
  for (const [id, problem] of Object.entries(db.problems)) if (problem.guildId === guildId && problem.ctfKey === key) delete db.problems[id];
  const channelPrefix = `${guildId}:${key}:`;
  for (const channelKey of Object.keys(db.channels)) if (channelKey.startsWith(channelPrefix)) delete db.channels[channelKey];
  for (const messageKey of Object.keys(db.messages)) if (messageKey.startsWith(channelPrefix)) delete db.messages[messageKey];
  save();
}
export const getProblems = (guildId: string, key?: string) => Object.values(db.problems).filter((v) => v.guildId === guildId && (!key || v.ctfKey === key));
export const getProblem = (id: string) => db.problems[id];
export const getProblemByThread = (id: string) => Object.values(db.problems).find((v) => v.threadId != null && v.threadId === id);
export const findProblem = (guildId: string, key: string, name: string) => getProblems(guildId, key).find((v) => v.nameKey === keyOf(name));
export const findProblemByExternalId = (guildId: string, key: string, externalId: string) => getProblems(guildId, key).find((v) => v.externalId === externalId);
export function putProblem(value: CtfProblem) { db.problems[value.id] = value; save(); }
export function patchProblem(id: string, patch: Partial<CtfProblem>) { const value = db.problems[id]; if (!value) return; Object.assign(value, patch); save(); return value; }
export function removeProblem(id: string) { delete db.problems[id]; save(); }
export const getChannel = (guildId: string, key: string) => db.channels[`${guildId}:${key}`];
export function putChannel(guildId: string, key: string, id: string) { db.channels[`${guildId}:${key}`] = id; save(); }
export const getMessage = (guildId: string, key: string) => db.messages[`${guildId}:${key}`];
export function putMessage(guildId: string, key: string, id: string) { db.messages[`${guildId}:${key}`] = id; save(); }
export function getMessages(guildId: string, prefix: string) {
  const fullPrefix = `${guildId}:${prefix}`;
  return Object.entries(db.messages).filter(([key]) => key.startsWith(fullPrefix)).map(([key, id]) => ({ key: key.slice(guildId.length + 1), id }));
}
export function removeMessage(guildId: string, key: string) { delete db.messages[`${guildId}:${key}`]; save(); }
