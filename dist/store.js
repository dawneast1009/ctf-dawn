"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannel = exports.findProblem = exports.getProblemByThread = exports.getProblem = exports.getProblems = exports.getContests = exports.getContest = exports.keyOf = void 0;
exports.putContest = putContest;
exports.patchContest = patchContest;
exports.removeContest = removeContest;
exports.putProblem = putProblem;
exports.patchProblem = patchProblem;
exports.removeProblem = removeProblem;
exports.putChannel = putChannel;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = process.env.DATABASE_PATH?.trim() || (0, node_path_1.join)(process.cwd(), "data.json");
const keyOf = (value) => value.trim().toLowerCase();
exports.keyOf = keyOf;
const empty = () => ({ contests: {}, problems: {}, channels: {} });
function load() { try {
    return (0, node_fs_1.existsSync)(DB_PATH) ? { ...empty(), ...JSON.parse((0, node_fs_1.readFileSync)(DB_PATH, "utf8")) } : empty();
}
catch {
    return empty();
} }
let db = load();
function save() { (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(DB_PATH), { recursive: true }); const tmp = `${DB_PATH}.tmp`; (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(db, null, 2)); (0, node_fs_1.renameSync)(tmp, DB_PATH); }
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
function putProblem(value) { db.problems[value.id] = value; save(); }
function patchProblem(id, patch) { const value = db.problems[id]; if (!value)
    return; Object.assign(value, patch); save(); return value; }
function removeProblem(id) { delete db.problems[id]; save(); }
const getChannel = (guildId, key) => db.channels[`${guildId}:${key}`];
exports.getChannel = getChannel;
function putChannel(guildId, key, id) { db.channels[`${guildId}:${key}`] = id; save(); }
