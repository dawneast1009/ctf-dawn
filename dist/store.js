"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMessage = exports.getChannel = exports.findProblemByExternalId = exports.findProblem = exports.getProblemByThread = exports.getProblem = exports.getProblems = exports.getContests = exports.getContest = exports.keyOf = void 0;
exports.putContest = putContest;
exports.patchContest = patchContest;
exports.removeContest = removeContest;
exports.putProblem = putProblem;
exports.patchProblem = patchProblem;
exports.removeProblem = removeProblem;
exports.putChannel = putChannel;
exports.putMessage = putMessage;
exports.getMessages = getMessages;
exports.removeMessage = removeMessage;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = process.env.DATABASE_PATH?.trim() || (0, node_path_1.join)(process.cwd(), "data.json");
const BACKUP_PATH = `${DB_PATH}.bak`;
const keyOf = (value) => value.trim().toLowerCase();
exports.keyOf = keyOf;
const empty = () => ({ contests: {}, problems: {}, channels: {}, messages: {} });
let loadedFromBackup = false;
function readDb(path) {
    const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("DB 최상위 형식이 올바르지 않습니다.");
    for (const key of ["contests", "problems", "channels", "messages"])
        if (value[key] != null && (typeof value[key] !== "object" || Array.isArray(value[key])))
            throw new Error(`DB ${key} 형식이 올바르지 않습니다.`);
    return { ...empty(), ...value };
}
function load() {
    if (!(0, node_fs_1.existsSync)(DB_PATH)) {
        if (!(0, node_fs_1.existsSync)(BACKUP_PATH))
            return empty();
        console.warn(`기본 DB가 없어 백업을 복구했습니다: ${BACKUP_PATH}`);
        loadedFromBackup = true;
        return readDb(BACKUP_PATH);
    }
    try {
        return readDb(DB_PATH);
    }
    catch (error) {
        if ((0, node_fs_1.existsSync)(BACKUP_PATH)) {
            try {
                console.error(`DB 손상 감지, 백업을 사용합니다: ${error instanceof Error ? error.message : error}`);
                const backup = readDb(BACKUP_PATH);
                loadedFromBackup = true;
                return backup;
            }
            catch (backupError) {
                throw new Error(`DB와 백업을 모두 읽을 수 없습니다: ${backupError instanceof Error ? backupError.message : backupError}`);
            }
        }
        throw new Error(`DB를 읽을 수 없습니다: ${error instanceof Error ? error.message : error}`);
    }
}
let db = load();
function save() { (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(DB_PATH), { recursive: true, mode: 0o700 }); const tmp = `${DB_PATH}.tmp`; (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); if ((0, node_fs_1.existsSync)(DB_PATH) && !loadedFromBackup)
    (0, node_fs_1.copyFileSync)(DB_PATH, BACKUP_PATH); (0, node_fs_1.renameSync)(tmp, DB_PATH); loadedFromBackup = false; }
const contestKey = (guildId, key) => `${guildId}:${key}`;
const getContest = (guildId, key) => db.contests[contestKey(guildId, key)];
exports.getContest = getContest;
const getContests = (guildId) => Object.values(db.contests).filter((v) => v.guildId === guildId);
exports.getContests = getContests;
function putContest(value) { db.contests[contestKey(value.guildId, value.key)] = value; save(); }
function patchContest(guildId, key, patch) { const value = (0, exports.getContest)(guildId, key); if (!value)
    return; Object.assign(value, patch, { updatedAt: Date.now() }); save(); return value; }
function removeContest(guildId, key) {
    delete db.contests[contestKey(guildId, key)];
    for (const [id, problem] of Object.entries(db.problems))
        if (problem.guildId === guildId && problem.ctfKey === key)
            delete db.problems[id];
    const channelPrefix = `${guildId}:${key}:`;
    for (const channelKey of Object.keys(db.channels))
        if (channelKey.startsWith(channelPrefix))
            delete db.channels[channelKey];
    for (const messageKey of Object.keys(db.messages))
        if (messageKey.startsWith(channelPrefix))
            delete db.messages[messageKey];
    save();
}
const getProblems = (guildId, key) => Object.values(db.problems).filter((v) => v.guildId === guildId && (!key || v.ctfKey === key));
exports.getProblems = getProblems;
const getProblem = (id) => db.problems[id];
exports.getProblem = getProblem;
const getProblemByThread = (id) => Object.values(db.problems).find((v) => v.threadId != null && v.threadId === id);
exports.getProblemByThread = getProblemByThread;
const findProblem = (guildId, key, name) => (0, exports.getProblems)(guildId, key).find((v) => v.nameKey === (0, exports.keyOf)(name));
exports.findProblem = findProblem;
const findProblemByExternalId = (guildId, key, externalId) => (0, exports.getProblems)(guildId, key).find((v) => v.externalId === externalId);
exports.findProblemByExternalId = findProblemByExternalId;
function putProblem(value) { db.problems[value.id] = value; save(); }
function patchProblem(id, patch) { const value = db.problems[id]; if (!value)
    return; Object.assign(value, patch); save(); return value; }
function removeProblem(id) { delete db.problems[id]; save(); }
const getChannel = (guildId, key) => db.channels[`${guildId}:${key}`];
exports.getChannel = getChannel;
function putChannel(guildId, key, id) { db.channels[`${guildId}:${key}`] = id; save(); }
const getMessage = (guildId, key) => db.messages[`${guildId}:${key}`];
exports.getMessage = getMessage;
function putMessage(guildId, key, id) { db.messages[`${guildId}:${key}`] = id; save(); }
function getMessages(guildId, prefix) {
    const fullPrefix = `${guildId}:${prefix}`;
    return Object.entries(db.messages).filter(([key]) => key.startsWith(fullPrefix)).map(([key, id]) => ({ key: key.slice(guildId.length + 1), id }));
}
function removeMessage(guildId, key) { delete db.messages[`${guildId}:${key}`]; save(); }
