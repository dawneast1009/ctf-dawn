"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.keyOf = keyOf;
exports.addProblem = addProblem;
exports.getProblem = getProblem;
exports.removeProblem = removeProblem;
exports.getGuildProblems = getGuildProblems;
exports.markSolved = markSolved;
exports.addCtfProblem = addCtfProblem;
exports.getCtfProblem = getCtfProblem;
exports.removeCtfProblem = removeCtfProblem;
exports.updateCtfProblem = updateCtfProblem;
exports.getGuildCtfProblems = getGuildCtfProblems;
exports.getCtfProblemByPost = getCtfProblemByPost;
exports.findCtfProblem = findCtfProblem;
exports.recordCtfSolve = recordCtfSolve;
exports.setCtfSolve = setCtfSolve;
exports.deleteCtfSolve = deleteCtfSolve;
exports.upsertCtfContest = upsertCtfContest;
exports.getCtfContest = getCtfContest;
exports.getGuildCtfContests = getGuildCtfContests;
exports.updateCtfContest = updateCtfContest;
exports.removeCtfContest = removeCtfContest;
exports.getForumFor = getForumFor;
exports.setForumFor = setForumFor;
exports.removeForumFor = removeForumFor;
exports.getForumKeysFor = getForumKeysFor;
exports.getVault = getVault;
exports.setVault = setVault;
exports.getCtfRole = getCtfRole;
exports.setCtfRole = setCtfRole;
exports.removeCtfRole = removeCtfRole;
exports.getCtfTime = getCtfTime;
exports.setCtfTime = setCtfTime;
exports.removeCtfTime = removeCtfTime;
exports.getFeatures = getFeatures;
exports.setFeatures = setFeatures;
exports.getLogChannel = getLogChannel;
exports.setLogChannel = setLogChannel;
exports.getGuildEventItems = getGuildEventItems;
exports.hasEventItem = hasEventItem;
exports.addEventItem = addEventItem;
exports.updateEventItem = updateEventItem;
exports.getEventItem = getEventItem;
exports.removeEventItem = removeEventItem;
exports.clearGuildEvents = clearGuildEvents;
exports.getEventStatus = getEventStatus;
exports.setEventStatus = setEventStatus;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = process.env.DATABASE_PATH?.trim() || (0, node_path_1.join)(process.cwd(), "data.json");
/** 대소문자/공백 무시 비교용 키 */
function keyOf(s) {
    return s.trim().toLowerCase();
}
const empty = {
    problems: {},
    ctfProblems: {},
    ctfContests: {},
    forums: {},
    vaults: {},
    ctfRoles: {},
    ctfTimes: {},
    features: {},
    logChannels: {},
    eventItems: {},
    eventStatus: {},
};
function load() {
    if (!(0, node_fs_1.existsSync)(DB_PATH))
        return structuredClone(empty);
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(DB_PATH, "utf8"));
        return { ...structuredClone(empty), ...parsed };
    }
    catch {
        return structuredClone(empty);
    }
}
let db = load();
function save() {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(DB_PATH), { recursive: true });
    const temporary = `${DB_PATH}.tmp`;
    (0, node_fs_1.writeFileSync)(temporary, JSON.stringify(db, null, 2), "utf8");
    (0, node_fs_1.renameSync)(temporary, DB_PATH);
}
// ── 드림핵 문제 ───────────────────────────────────────────────────────
function addProblem(p) {
    db.problems[p.id] = p;
    save();
}
function getProblem(id) {
    return db.problems[id];
}
function removeProblem(id) {
    delete db.problems[id];
    save();
}
function getGuildProblems(guildId) {
    return Object.values(db.problems)
        .filter((p) => p.guildId === guildId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
function markSolved(id, userId) {
    const p = db.problems[id];
    if (p && !p.solvers.includes(userId)) {
        p.solvers.push(userId);
        save();
    }
}
// ── CTF 문제 ──────────────────────────────────────────────────────────
function addCtfProblem(p) {
    db.ctfProblems[p.id] = p;
    save();
}
function getCtfProblem(id) {
    return db.ctfProblems[id];
}
function removeCtfProblem(id) {
    delete db.ctfProblems[id];
    save();
}
function updateCtfProblem(id, patch) {
    const p = db.ctfProblems[id];
    if (p) {
        Object.assign(p, patch);
        save();
    }
}
function getGuildCtfProblems(guildId) {
    return Object.values(db.ctfProblems)
        .filter((p) => p.guildId === guildId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
function getCtfProblemByPost(postId) {
    return Object.values(db.ctfProblems).find((p) => p.postId === postId);
}
/** 같은 CTF 안에서 같은 이름(대소문자 무시) 중복 찾기 */
function findCtfProblem(guildId, ctfKey, nameKey) {
    return Object.values(db.ctfProblems).find((p) => p.guildId === guildId && p.ctfKey === ctfKey && p.nameKey === nameKey);
}
/** 첫 솔브 기록 (푼 사람 1점, 도와준 사람 0.5점). 이미 풀렸으면 false */
function recordCtfSolve(id, solverId, helperIds) {
    const p = db.ctfProblems[id];
    if (!p || p.solved)
        return false;
    p.solves[solverId] = 1;
    for (const h of helperIds)
        if (h !== solverId)
            p.solves[h] = Math.max(p.solves[h] ?? 0, 0.5);
    p.solved = true;
    save();
    return true;
}
/** 수동 보정: 특정 유저에게 점수 부여(잠김 무시) */
function setCtfSolve(id, userId, amount) {
    const p = db.ctfProblems[id];
    if (!p)
        return false;
    p.solves[userId] = amount;
    p.solved = true;
    save();
    return true;
}
/** 특정 유저의 내부 기여 기록 삭제. 남은 기록이 없으면 문제를 미해결로 되돌림 */
function deleteCtfSolve(id, userId) {
    const p = db.ctfProblems[id];
    if (!p || p.solves[userId] == null)
        return false;
    delete p.solves[userId];
    p.solved = Object.values(p.solves).some((score) => score >= 1);
    save();
    return true;
}
// ── CTF 작업 공간 ────────────────────────────────────────────────────
function upsertCtfContest(contest) {
    db.ctfContests[`${contest.guildId}:${contest.key}`] = contest;
    save();
}
function getCtfContest(guildId, ctfKey) {
    return db.ctfContests[`${guildId}:${ctfKey}`];
}
function getGuildCtfContests(guildId) {
    return Object.values(db.ctfContests)
        .filter((contest) => contest.guildId === guildId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
function updateCtfContest(guildId, ctfKey, patch) {
    const contest = getCtfContest(guildId, ctfKey);
    if (!contest)
        return undefined;
    Object.assign(contest, patch, { updatedAt: Date.now() });
    save();
    return contest;
}
function removeCtfContest(guildId, ctfKey) {
    delete db.ctfContests[`${guildId}:${ctfKey}`];
    save();
}
// ── 포럼 / 풀이방 채널 ────────────────────────────────────────────────
function getForumFor(guildId, sourceKey) {
    return db.forums[`${guildId}:${sourceKey}`];
}
function setForumFor(guildId, sourceKey, channelId) {
    db.forums[`${guildId}:${sourceKey}`] = channelId;
    save();
}
function removeForumFor(guildId, sourceKey) {
    delete db.forums[`${guildId}:${sourceKey}`];
    save();
}
function getForumKeysFor(guildId, prefix) {
    const keyPrefix = `${guildId}:${prefix}`;
    return Object.keys(db.forums)
        .filter((key) => key.startsWith(keyPrefix))
        .map((key) => key.slice(guildId.length + 1));
}
function getVault(guildId) {
    return db.vaults[guildId];
}
function setVault(guildId, channelId) {
    db.vaults[guildId] = channelId;
    save();
}
// ── CTF 참가자 역할 ───────────────────────────────────────────────────
function getCtfRole(guildId, ctfKey) {
    return db.ctfRoles[`${guildId}:${ctfKey}`];
}
function setCtfRole(guildId, ctfKey, roleId) {
    db.ctfRoles[`${guildId}:${ctfKey}`] = roleId;
    save();
}
function removeCtfRole(guildId, ctfKey) {
    delete db.ctfRoles[`${guildId}:${ctfKey}`];
    save();
}
// ── CTF 대회 시간 ─────────────────────────────────────────────────────
function getCtfTime(guildId, ctfKey) {
    return db.ctfTimes[`${guildId}:${ctfKey}`];
}
function setCtfTime(guildId, ctfKey, startsAt, endsAt) {
    db.ctfTimes[`${guildId}:${ctfKey}`] = { startsAt, endsAt };
    save();
}
function removeCtfTime(guildId, ctfKey) {
    delete db.ctfTimes[`${guildId}:${ctfKey}`];
    save();
}
// ── 봇 기능 토글 / 로그 채널 ──────────────────────────────────────────
function getFeatures(guildId) {
    return db.features[guildId] ?? [];
}
function setFeatures(guildId, keys) {
    db.features[guildId] = [...new Set(keys)];
    save();
}
function getLogChannel(guildId) {
    return db.logChannels[guildId];
}
function setLogChannel(guildId, channelId) {
    db.logChannels[guildId] = channelId;
    save();
}
// ── 보안뉴스 / 행사 공지 ─────────────────────────────────────────────
function getGuildEventItems(guildId) {
    return Object.values(db.eventItems)
        .filter((item) => item.guildId === guildId)
        .sort((a, b) => b.publishedAt - a.publishedAt);
}
function hasEventItem(guildId, id) {
    return Boolean(db.eventItems[`${guildId}:${id}`]);
}
function addEventItem(item) {
    db.eventItems[`${item.guildId}:${item.id}`] = item;
    save();
}
function updateEventItem(guildId, id, item) {
    if (id !== item.id)
        delete db.eventItems[`${guildId}:${id}`];
    db.eventItems[`${guildId}:${item.id}`] = item;
    save();
}
function getEventItem(guildId, id) {
    return db.eventItems[`${guildId}:${id}`];
}
function removeEventItem(guildId, id) {
    delete db.eventItems[`${guildId}:${id}`];
    save();
}
function clearGuildEvents(guildId) {
    for (const key of Object.keys(db.eventItems)) {
        if (db.eventItems[key]?.guildId === guildId)
            delete db.eventItems[key];
    }
    delete db.eventStatus[guildId];
    save();
}
function getEventStatus(guildId) {
    return db.eventStatus[guildId] ?? {};
}
function setEventStatus(guildId, status) {
    db.eventStatus[guildId] = status;
    save();
}
