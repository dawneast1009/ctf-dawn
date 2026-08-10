import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.DATABASE_PATH?.trim() || join(process.cwd(), "data.json");
export const keyOf = (value: string) => value.trim().toLowerCase();

export interface CtfContest {
  guildId: string; key: string; name: string; roleId: string; categoryId: string;
  startsAt: number; endsAt: number; teamName?: string; lobbyChannelId?: string;
  lobbyMessageId?: string; solveStatusMessageId?: string; allSolved: boolean;
  warningEnabled: boolean; platform?: "ctfd" | "rctf" | "hspace" | "generic";
  sourceUrl?: string; publicApiReadable?: boolean; encryptedAccessToken?: string;
  createdAt: number; updatedAt: number;
}
export interface CtfProblem {
  id: string; guildId: string; ctfName: string; ctfKey: string; name: string;
  nameKey: string; genre: string; genreKey: string; channelId: string; threadId: string;
  authorId: string; scores: Record<string, number>; solved: boolean; externalId?: string; createdAt: number;
}
interface Db { contests: Record<string, CtfContest>; problems: Record<string, CtfProblem>; channels: Record<string, string>; }
const empty = (): Db => ({ contests: {}, problems: {}, channels: {} });
function load(): Db { try { return existsSync(DB_PATH) ? { ...empty(), ...JSON.parse(readFileSync(DB_PATH, "utf8")) } : empty(); } catch { return empty(); } }
let db = load();
function save() { mkdirSync(dirname(DB_PATH), { recursive: true }); const tmp = `${DB_PATH}.tmp`; writeFileSync(tmp, JSON.stringify(db, null, 2)); renameSync(tmp, DB_PATH); }
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
  save();
}
export const getProblems = (guildId: string, key?: string) => Object.values(db.problems).filter((v) => v.guildId === guildId && (!key || v.ctfKey === key));
export const getProblem = (id: string) => db.problems[id];
export const getProblemByThread = (id: string) => Object.values(db.problems).find((v) => v.threadId === id);
export const findProblem = (guildId: string, key: string, name: string) => getProblems(guildId, key).find((v) => v.nameKey === keyOf(name));
export function putProblem(value: CtfProblem) { db.problems[value.id] = value; save(); }
export function patchProblem(id: string, patch: Partial<CtfProblem>) { const value = db.problems[id]; if (!value) return; Object.assign(value, patch); save(); return value; }
export function removeProblem(id: string) { delete db.problems[id]; save(); }
export const getChannel = (guildId: string, key: string) => db.channels[`${guildId}:${key}`];
export function putChannel(guildId: string, key: string, id: string) { db.channels[`${guildId}:${key}`] = id; save(); }
